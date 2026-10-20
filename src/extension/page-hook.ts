/**
 * MAIN-world page hook: extracts media hints from the page and answers requests over the per-page
 * BroadcastChannel.
 *
 * Evidence: the shipped `injected/*_untrusted.js` scripts use exactly this bridge — a
 * `BroadcastChannel("injected-<cyrb53(location.href)>")`, speaking channels 4/5 — to hand page
 * state (player config, manifest text, ids) to the extension.
 *
 * Strategy:
 *  1. YouTube gets a real adapter: the InnerTube player API is called **from the page context**
 *     (cookies included), trying several clients and preferring `hlsManifestUrl`. This is the
 *     mechanism the original uses when it forwards `visitor_data`; a plain URL scrape cannot work
 *     because modern playback is SABR/UMP-only.
 *  2. Other sites: DOM sources, inline JSON, well-known player globals, resource timeline.
 *  3. SABR/UMP endpoints are filtered out — a GET against them returns a protocol blob, not media.
 */
import { Channel, injectedHrefChannel } from "../protocol/channels.js";
import { parseMpd } from "../manifests/dash.js";
import { parsePlaylist } from "../manifests/hls.js";
import { probeMpegTsVideoSize } from "../manifests/ts-probe.js";
import { focusKey } from "./focus.js";
import {
  PAGE_ON_MEDIA_HINTS,
  PAGE_REQUEST_MEDIA_HINTS,
  chooseBestHints,
  classifyHintUrl,
  classifyRangeChunkUrl,
  decodeTaggingParameter,
  fileHintRank,
  fileIdentity,
  type HintKind,
  type HintVariant,
  type PageMediaHint,
  type ResourceTimingHint,
} from "./media-hint.js";

export { PAGE_ON_MEDIA_HINTS, PAGE_REQUEST_MEDIA_HINTS, classifyHintUrl };
export type { PageMediaHint };

/** Upper bound on hints reported for one page (feed pages can contain many videos). */
const MAX_HINTS = 12;

/** Globals that commonly hold player metadata. Only read, never written. */
const PLAYER_GLOBALS = [
  "ytInitialPlayerResponse",
  "__INITIAL_STATE__",
  "__PLAYER_CONFIG__",
  "playerConfig",
  "__NEXT_DATA__",
  "__APOLLO_STATE__",
] as const;

const JSON_URL_PATTERN =
  /"(?:video_url|videoUrl|playback_url|playbackUrl|hlsManifestUrl|dashManifestUrl|masterUrl|contentUrl|manifestUrl|url)"\s*:\s*"((?:[^"\\]|\\.)*)"/gu;
const VIDEO_VERSIONS_PATTERN = /"video_versions"\s*:\s*\[([\s\S]{0,6000}?)\]/gu;

const unescapeJson = (value: string): string =>
  value.replace(/\\u0026/gu, "&").replace(/\\\//gu, "/").replace(/\\"/gu, '"');

/** Walk a player-data object collecting URL-looking strings (bounded, cycle-safe). */
export function collectFromPlayerData(root: unknown, baseUrl: string): Array<{ url: string; kind: HintKind }> {
  const found: Array<{ url: string; kind: HintKind }> = [];
  const seenObjects = new Set<object>();
  let budget = 6000;

  const visit = (value: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > 10) return;
    if (typeof value === "string") {
      if (!/^https?:\/\//u.test(value) && !value.startsWith("//")) return;
      const classified = classifyHintUrl(value, baseUrl);
      if (classified && !found.some((entry) => entry.url === classified.url)) found.push(classified);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seenObjects.has(value as object)) return;
    seenObjects.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        /^(streamingData|formats|adaptiveFormats|video_versions|video|media|sources|playlist|manifest|content|player|args)$/iu.test(
          key,
        ) ||
        key === "url" ||
        key === "hlsManifestUrl" ||
        key === "dashManifestUrl"
      ) {
        visit(child, depth + 1);
      }
    }
  };

  visit(root, 0);
  return found;
}

/** Scan inline `<script>` JSON for media URLs. */
export function collectFromInlineJson(document: Document, baseUrl: string): Array<{ url: string; kind: HintKind }> {
  const found: Array<{ url: string; kind: HintKind }> = [];
  const push = (raw: string): void => {
    const classified = classifyHintUrl(unescapeJson(raw), baseUrl);
    if (classified && !found.some((entry) => entry.url === classified.url)) found.push(classified);
  };
  for (const script of Array.from(document.querySelectorAll("script:not([src])"))) {
    const text = script.textContent ?? "";
    if (text.length === 0 || text.length > 2_000_000) continue;
    if (!/(?:video|playback|manifest|stream|contentUrl)/iu.test(text)) continue;
    for (const match of text.matchAll(JSON_URL_PATTERN)) if (match[1]) push(match[1]);
    for (const block of text.matchAll(VIDEO_VERSIONS_PATTERN)) {
      for (const urlMatch of (block[1] ?? "").matchAll(JSON_URL_PATTERN)) if (urlMatch[1]) push(urlMatch[1]);
    }
  }
  return found;
}

const VIDEO_VERSION_OBJECT_PATTERN = /\{[^{}]*\}/gu;

/**
 * Instagram and similar players publish several muxed renditions in `video_versions`.
 * Extract each array as one media hint carrying all resolutions, so the panel can show a
 * real quality dropdown (the flat URL collectors intentionally keep only one URL per asset).
 */
export function collectVideoVersionHints(
  document: Document,
  baseUrl: string,
): PageMediaHint[] {
  const groups: PageMediaHint[] = [];
  const seenGroups = new Set<string>();
  for (const script of Array.from(document.querySelectorAll("script:not([src])"))) {
    const text = script.textContent ?? "";
    if (text.length === 0 || text.length > 2_000_000) continue;
    for (const block of text.matchAll(VIDEO_VERSIONS_PATTERN)) {
      const variants: HintVariant[] = [];
      const seenUrls = new Set<string>();
      for (const object of (block[1] ?? "").matchAll(VIDEO_VERSION_OBJECT_PATTERN)) {
        const raw = /"url"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(object[0])?.[1];
        if (raw === undefined) continue;
        const classified = classifyHintUrl(unescapeJson(raw), baseUrl);
        if (classified === undefined || classified.kind !== "file" || seenUrls.has(classified.url)) continue;
        seenUrls.add(classified.url);
        const width = /"width"\s*:\s*(\d+)/u.exec(object[0])?.[1];
        const height = /"height"\s*:\s*(\d+)/u.exec(object[0])?.[1];
        let identity: { extension: string; demuxer: string } | undefined;
        try {
          identity = fileIdentity(new URL(classified.url));
        } catch {
          identity = undefined;
        }
        variants.push({
          url: classified.url,
          ...(width !== undefined ? { width: Number.parseInt(width, 10) } : {}),
          ...(height !== undefined ? { height: Number.parseInt(height, 10) } : {}),
          ...(identity !== undefined
            ? { demuxer: identity.demuxer, mime: identity.demuxer === "webm" ? "video/webm" : "video/mp4" }
            : {}),
        });
      }
      if (variants.length === 0) continue;
      variants.sort((a, b) => {
        const areaA = (a.width ?? 0) * (a.height ?? 0);
        const areaB = (b.width ?? 0) * (b.height ?? 0);
        return areaB - areaA || (b.height ?? 0) - (a.height ?? 0);
      });
      const groupKey = variants.map((variant) => variant.url).join("\n");
      if (seenGroups.has(groupKey)) continue;
      seenGroups.add(groupKey);
      const best = variants[0];
      if (best === undefined) continue;
      groups.push({
        url: best.url,
        kind: "file",
        source: "inline-json",
        variants,
      });
    }
  }
  return groups;
}

/** Asset identity from Instagram's base64 `efg` tag (`xpv_asset_id`/`asset_id`). */
function instagramAssetKey(rawUrl: string): string | undefined {
  try {
    const decoded = decodeTaggingParameter(new URL(rawUrl));
    if (decoded.length === 0) return undefined;
    const data = JSON.parse(decoded) as Record<string, unknown>;
    const value = data.xpv_asset_id ?? data.asset_id ?? data.video_id ?? data.pk;
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  } catch {
    return undefined;
  }
}

function variantGroupMatches(group: PageMediaHint, hint: PageMediaHint): boolean {
  const urls = new Set((group.variants ?? []).map((variant) => variant.url));
  if (urls.has(hint.url)) return true;
  const hintKey = instagramAssetKey(hint.url);
  if (hintKey === undefined) return false;
  return (group.variants ?? []).some((variant) => instagramAssetKey(variant.url) === hintKey);
}

/** Replace DOM hints that match a multi-quality group with the grouped hint. */
export function attachVariantHints(
  hints: readonly PageMediaHint[],
  groups: readonly PageMediaHint[],
): PageMediaHint[] {
  const usedGroups = new Set<string>();
  const result: PageMediaHint[] = [];
  const seenUrls = new Set<string>();
  const push = (hint: PageMediaHint): void => {
    if (seenUrls.has(hint.url)) return;
    seenUrls.add(hint.url);
    result.push(hint);
  };
  for (const hint of hints) {
    if (hint.kind !== "file") {
      push(hint);
      continue;
    }
    const group = groups.find(
      (candidate) =>
        !usedGroups.has(candidate.url) &&
        (candidate.variants?.length ?? 0) > 1 &&
        variantGroupMatches(candidate, hint),
    );
    if (group === undefined) {
      push(hint);
      continue;
    }
    usedGroups.add(group.url);
    push({
      ...group,
      ...(hint.title !== undefined ? { title: hint.title } : {}),
      ...(hint.focused === true ? { focused: true } : {}),
    });
  }
  return result.slice(0, MAX_HINTS);
}

/** Resource-timing entries as `{url,status,transferSize}` (failed requests are filtered later). */
function currentResourceEntries(): ResourceTimingHint[] {
  if (typeof performance?.getEntriesByType !== "function") return [];
  return performance
    .getEntriesByType("resource")
    .filter((entry) => /\.m3u8|\.mpd|videoplayback|\.mp4|\.webm|mime=/iu.test(entry.name))
    .map((entry) => {
      const timing = entry as unknown as { name: string; responseStatus?: number; transferSize?: number };
      return {
        url: timing.name,
        ...(typeof timing.responseStatus === "number" ? { status: timing.responseStatus } : {}),
        ...(typeof timing.transferSize === "number" ? { transferSize: timing.transferSize } : {}),
      };
    });
}

/** Infer a rendition label/size from a <video>/<source> element or its URL query. */
function domVariant(element: Element, url: URL, video?: HTMLVideoElement): HintVariant {
  const label = [
    element.getAttribute("label"),
    element.getAttribute("data-quality"),
    element.getAttribute("data-res"),
    element.getAttribute("res"),
    element.getAttribute("size"),
    element.getAttribute("height"),
    element.getAttribute("title"),
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join(" ");
  const pair = /(\d{2,5})\s*[xX]\s*(\d{2,5})/u.exec(label);
  const heightOnly = /(?:^|\D)(\d{3,4})p(?:\D|$)/iu.exec(label) ?? /^(\d{3,4})$/u.exec(label);
  const queryHeight = url.searchParams.get("height") ?? url.searchParams.get("h");
  const queryWidth = url.searchParams.get("width") ?? url.searchParams.get("w");
  const numeric = (value: string | null | undefined): number | undefined => {
    if (value === null || value === undefined) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const identity = fileIdentity(url);
  const bitrate = numeric(element.getAttribute("data-bitrate") ?? element.getAttribute("bitrate"));
  const renderedWidth = video !== undefined && Number.isFinite(video.videoWidth) && video.videoWidth > 0 ? video.videoWidth : undefined;
  const renderedHeight =
    video !== undefined && Number.isFinite(video.videoHeight) && video.videoHeight > 0 ? video.videoHeight : undefined;
  return {
    url: url.href,
    ...(pair?.[1] !== undefined ? { width: Number.parseInt(pair[1], 10) } : {}),
    ...(pair?.[2] !== undefined
      ? { height: Number.parseInt(pair[2], 10) }
      : heightOnly?.[1] !== undefined
        ? { height: Number.parseInt(heightOnly[1], 10) }
        : {}),
    ...(pair === null && numeric(queryWidth) !== undefined ? { width: numeric(queryWidth) } : {}),
    ...(pair === null && numeric(queryHeight) !== undefined ? { height: numeric(queryHeight) } : {}),
    ...(pair === null && heightOnly?.[1] === undefined && renderedWidth !== undefined ? { width: renderedWidth } : {}),
    ...(pair === null && heightOnly?.[1] === undefined && renderedHeight !== undefined ? { height: renderedHeight } : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
    demuxer: identity.demuxer,
    mime: identity.demuxer === "webm" ? "video/webm" : "video/mp4",
  };
}

/**
 * Group a media element's own sources into one hint. A <video> with several <source>
 * renditions is one downloadable item with a quality list, not several panel rows.
 */
function collectDomElementHints(
  document: Document,
  baseUrl: string,
  seen: Set<string>,
): PageMediaHint[] {
  const groups: PageMediaHint[] = [];
  for (const media of Array.from(document.querySelectorAll("video"))) {
    const sources: Array<{ raw: string | null; element: Element; source: PageMediaHint["source"] }> = [
      { raw: media.getAttribute("src"), element: media, source: "video" },
      ...Array.from(media.querySelectorAll("source[src]")).map((element) => ({
        raw: element.getAttribute("src"),
        element,
        source: "source" as const,
      })),
    ];
    const candidates: Array<{ url: string; source: PageMediaHint["source"]; variant: HintVariant }> = [];
    for (const candidate of sources) {
      if (candidate.raw === null || candidate.raw.length === 0) continue;
      const classified = classifyHintUrl(candidate.raw, baseUrl);
      if (classified === undefined || classified.kind !== "file" || seen.has(classified.url)) continue;
      const url = new URL(classified.url);
      candidates.push({
        url: classified.url,
        source: candidate.source,
        variant: domVariant(candidate.element, url, media),
      });
    }
    if (candidates.length === 0) continue;
    for (const candidate of candidates) seen.add(candidate.url);
    const variants = candidates.map((candidate) => candidate.variant);
    if (variants.length > 1) {
      variants.sort((a, b) => {
        const areaA = (a.width ?? 0) * (a.height ?? 0);
        const areaB = (b.width ?? 0) * (b.height ?? 0);
        return areaB - areaA || (b.height ?? 0) - (a.height ?? 0);
      });
      groups.push({ url: variants[0]?.url ?? candidates[0]?.url ?? "", kind: "file", source: "video", variants });
    } else {
      const only = candidates[0];
      if (only !== undefined) groups.push({ url: only.url, kind: "file", source: only.source, variants: [only.variant] });
    }
  }
  return groups;
}

/** Quality metadata available inside Instagram's base64 `efg` tag. */
function instagramHintVariant(hint: PageMediaHint): HintVariant {
  try {
    const url = new URL(hint.url);
    const decoded = decodeTaggingParameter(url);
    const data = decoded.length > 0 ? (JSON.parse(decoded) as Record<string, unknown>) : {};
    const bitrate = typeof data.bitrate === "number" && data.bitrate > 0 ? data.bitrate : undefined;
    const tag = typeof data.vencode_tag === "string" ? data.vencode_tag : "";
    const heightMatch = /(\d{3,4})p/u.exec(tag);
    const widthMatch = /C3\.(\d{3,4})/u.exec(tag);
    const identity = fileIdentity(url);
    return {
      url: hint.url,
      ...(heightMatch?.[1] !== undefined ? { height: Number.parseInt(heightMatch[1], 10) } : {}),
      ...(widthMatch?.[1] !== undefined ? { width: Number.parseInt(widthMatch[1], 10) } : {}),
      ...(bitrate !== undefined ? { bitrate } : {}),
      demuxer: identity.demuxer,
      mime: identity.demuxer === "webm" ? "video/webm" : "video/mp4",
    };
  } catch {
    return { url: hint.url };
  }
}

/**
 * Group direct Instagram URLs that belong to the same asset id. Signed query parameters rotate
 * on every request; the asset id is what makes the panel row stable and merges quality URLs.
 */
function groupInstagramFileHints(hints: readonly PageMediaHint[], _pageUrl: string): PageMediaHint[] {
  const groups = new Map<string, { hint: PageMediaHint; variants: Map<string, HintVariant> }>();
  const result: PageMediaHint[] = [];
  for (const hint of hints) {
    if (hint.kind !== "file") {
      result.push(hint);
      continue;
    }
    const asset = instagramAssetKey(hint.url);
    if (asset === undefined) {
      result.push(hint);
      continue;
    }
    let group = groups.get(asset);
    if (group === undefined) {
      const groupedHint: PageMediaHint = { ...hint, identity: `ig:asset:${asset}` };
      group = { hint: groupedHint, variants: new Map() };
      groups.set(asset, group);
      result.push(groupedHint);
    }
    const key = focusKey(hint.url) ?? hint.url;
    group.variants.set(key, instagramHintVariant(hint));
  }
  for (const group of groups.values()) {
    const variants = [...group.variants.values()].sort((a, b) => {
      const areaA = (a.width ?? 0) * (a.height ?? 0);
      const areaB = (b.width ?? 0) * (b.height ?? 0);
      return areaB - areaA || (b.bitrate ?? 0) - (a.bitrate ?? 0);
    });
    if (variants.length > 1) {
      const muxed = variants.find((variant) => {
        try {
          return fileHintRank(new URL(variant.url)) === 0;
        } catch {
          return false;
        }
      });
      group.hint.variants = variants;
      group.hint.url = muxed?.url ?? variants[0]?.url ?? group.hint.url;
    }
  }
  return result;
}

/**
 * Extract candidate media URLs from the document (plus optional resource-timing entries).
 * Pure enough to unit-test with jsdom.
 */
export function collectMediaHints(
  document: Document,
  baseUrl: string = globalThis.location?.href ?? "",
  resourceEntries: readonly (string | ResourceTimingHint)[] = [],
): PageMediaHint[] {
  const hints: PageMediaHint[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined, source: PageMediaHint["source"]): void => {
    if (!raw) return;
    const classified = classifyHintUrl(raw, baseUrl);
    if (!classified || seen.has(classified.url)) return;
    seen.add(classified.url);
    hints.push({ url: classified.url, kind: classified.kind, source });
  };

  // 1. DOM sources that unambiguously describe the open media item. A <video> with multiple
  // <source> children becomes one item with variants rather than several rows.
  for (const hint of collectDomElementHints(document, baseUrl, seen)) hints.push(hint);
  for (const video of Array.from(document.querySelectorAll("video[src]"))) add(video.getAttribute("src"), "video");
  for (const source of Array.from(document.querySelectorAll("video source[src], audio source[src]")))
    add(source.getAttribute("src"), "source");
  for (const meta of Array.from(
    document.querySelectorAll("meta[property='og:video'], meta[property='og:video:url'], meta[property='og:video:secure_url']"),
  ))
    add(meta.getAttribute("content"), "og:video");
  for (const script of Array.from(document.querySelectorAll("script[type='application/ld+json']"))) {
    for (const match of (script.textContent ?? "").matchAll(/"contentUrl"\s*:\s*"([^"]+)"/gu)) {
      add(match[1] ? unescapeJson(match[1]) : undefined, "json-ld");
    }
  }
  if (hints.length > 0) {
    return withTitle(
      groupInstagramFileHints(attachVariantHints(hints, collectVideoVersionHints(document, baseUrl)), baseUrl),
      document,
    );
  }
  const variantHints = collectVideoVersionHints(document, baseUrl);

  // 2. Resource timeline: URLs the player actually requested (successful ones only).
  const resourceCandidates: Array<{ hint: PageMediaHint; size: number; successful: boolean }> = [];
  const addResource = (entry: string | ResourceTimingHint): void => {
    const raw = typeof entry === "string" ? entry : entry.url;
    const status = typeof entry === "string" ? undefined : entry.status;
    const size = typeof entry === "string" ? 0 : (entry.transferSize ?? 0);
    // A failed request (403 etc.) is exactly what we must not pick; only trust 2xx/3xx.
    if (status !== undefined && status >= 400) return;
    const direct = classifyHintUrl(raw, baseUrl);
    const chunk = direct === undefined ? classifyRangeChunkUrl(raw, baseUrl) : undefined;
    const candidate = direct ?? (chunk ? { url: chunk.url, kind: chunk.kind } : undefined);
    if (!candidate) return;
    const existing = resourceCandidates.find((item) => item.hint.url === candidate.url);
    if (existing) {
      existing.size = Math.max(existing.size, size);
      return;
    }
    resourceCandidates.push({
      hint: { url: candidate.url, kind: candidate.kind, source: "resource-entry" },
      size,
      successful: status === undefined || (status >= 200 && status < 400),
    });
  };
  for (const entry of resourceEntries) addResource(entry);
  resourceCandidates.sort((a, b) => Number(b.successful) - Number(a.successful) || b.size - a.size);
  const resourceHints = resourceCandidates.map((candidate) => candidate.hint);

  const hasLiveToken = (hint: PageMediaHint): boolean => {
    try {
      const url = new URL(hint.url);
      return url.searchParams.has("pot") || url.searchParams.has("expire");
    } catch {
      return false;
    }
  };
  const liveResourceHints = resourceHints.filter(hasLiveToken);
  if (liveResourceHints.length > 0) {
    return withTitle(chooseBestHints(groupInstagramFileHints(liveResourceHints, baseUrl), MAX_HINTS), document);
  }

  // 3. Player globals (may be stale for YouTube; the InnerTube adapter covers that case).
  const globalScope = globalThis as unknown as Record<string, unknown>;
  for (const name of PLAYER_GLOBALS) {
    const value = globalScope[name];
    if (value === undefined) continue;
    for (const entry of collectFromPlayerData(value, baseUrl)) add(entry.url, "player-response");
  }

  // 4. Inline page JSON (feed pages): bounded and de-duplicated.
  for (const entry of collectFromInlineJson(document, baseUrl)) add(entry.url, "inline-json");

  const merged = groupInstagramFileHints([...resourceHints, ...hints], baseUrl);
  if (variantHints.length > 0) {
    const grouped = variantHints.slice(0, MAX_HINTS);
    const remaining = chooseBestHints(merged, MAX_HINTS).filter(
      (hint) =>
        !grouped.some(
          (group) =>
            group.url === hint.url ||
            (group.variants ?? []).some((variant) => variant.url === hint.url),
        ),
    );
    return withTitle([...grouped, ...remaining].slice(0, MAX_HINTS), document);
  }
  if (merged.length > 0) {
    return withTitle(chooseBestHints(merged, MAX_HINTS), document);
  }
  return [];
}

/** Twitter's amplify-video id shared by HLS and direct-file URLs for the same tweet video. */
function twitterAmplifyId(raw: string): string | undefined {
  try {
    return /\/amplify_video\/(\d+)\//u.exec(new URL(raw).pathname)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Twitter exposes a direct video-only MP4 next to the HLS manifest. Point the HLS row's hover
 * preview at that MP4 so the panel can play a muted preview instead of showing only a poster.
 */
export function attachTwitterPreviewUrls(hints: PageMediaHint[]): void {
  const directVideos = hints.filter((hint) => {
    if (hint.kind !== "file") return false;
    try {
      return /\/vid\/(?:avc1|h26[45]|vp9|av1)\//u.test(new URL(hint.url).pathname);
    } catch {
      return false;
    }
  });
  for (const hint of hints) {
    if (hint.kind !== "hls") continue;
    const id = twitterAmplifyId(hint.url);
    if (id === undefined) continue;
    const preview = directVideos.find((candidate) => twitterAmplifyId(candidate.url) === id);
    if (preview !== undefined) hint.preview = preview.url;
  }
}

/** Direct video file hint (not audio, not a manifest). */
function isDirectVideoHint(hint: PageMediaHint): boolean {
  if (hint.kind !== "file") return false;
  try {
    const path = new URL(hint.url).pathname;
    if (/\.(?:m3u8|mpd)(?:$|[?#])/iu.test(path)) return false;
    if (/\/(?:aud|audio|mp4a)\//iu.test(path)) return false;
    return /\/(?:vid|video|media)\//iu.test(path) || /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/iu.test(path);
  } catch {
    return false;
  }
}

/**
 * Generic single-video pages: when the same page snapshot yielded exactly one manifest and one
 * direct video file, they almost certainly describe the same media. Multi-video pages are left to
 * the per-asset (Twitter) mapping; never guess across unrelated rows.
 */
export function attachSiblingPreviewUrl(hints: PageMediaHint[]): void {
  const manifests = hints.filter((hint) => hint.kind === "hls" || hint.kind === "file" && /\.(?:m3u8)(?:$|[?#])/iu.test(hint.url));
  const direct = hints.filter(isDirectVideoHint);
  if (manifests.length !== 1 || direct.length !== 1) return;
  const manifest = manifests[0];
  const preview = direct[0];
  if (manifest !== undefined && preview !== undefined && manifest.preview === undefined) {
    manifest.preview = preview.url;
  }
}

/** Attach the page title to every hint (used for labels) and cap the list. */
function withTitle(hints: PageMediaHint[], document: Document): PageMediaHint[] {
  const pageTitle = document.title || undefined;
  for (const hint of hints) if (pageTitle !== undefined) hint.title = pageTitle;
  return hints;
}

// ---------------------------------------------------------------------------
// YouTube InnerTube adapter
// ---------------------------------------------------------------------------

interface YouTubePlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: {
    hlsManifestUrl?: string;
    formats?: Array<{ url?: string; mimeType?: string; itag?: number }>;
    adaptiveFormats?: Array<{
      url?: string;
      mimeType?: string;
      itag?: number;
      width?: number;
      height?: number;
      bitrate?: number;
      contentLength?: string | number;
    }>;
  };
}

/** One InnerTube client definition: full client context + header identity. */
interface YouTubeClient {
  name: string;
  headerName: string;
  clientVersion: string;
  context: Record<string, unknown>;
}


/**
 * visionOS is the client that still returns a directly downloadable HLS master (video variants
 * plus #EXT-X-MEDIA audio renditions). The muxer in `transfer/mux-fmp4.ts` combines the two
 * tracks; progressive web URLs are dead (403) and ANDROID_VR's URL only serves the first ~4 MiB.
 * Evidence: sandbox probe + analysis/evidence/05-youtube-empirical.md.
 */
const YOUTUBE_CLIENTS: readonly YouTubeClient[] = [
  {
    name: "VISIONOS",
    headerName: "101",
    clientVersion: "1.02",
    context: {
      clientName: "VISIONOS",
      clientVersion: "1.02",
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      osName: "visionOS",
      osVersion: "26.5.23O471",
    },
  },
  // Fallbacks for sessions where YouTube rejects the visionOS client. Their adaptive URLs are
  // fetched with bounded ranges like VISIONOS; the first client that returns direct formats wins.
  {
    name: "ANDROID_VR",
    headerName: "28",
    clientVersion: "1.62.27",
    context: {
      clientName: "ANDROID_VR",
      clientVersion: "1.62.27",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12",
      androidSdkVersion: 32,
      userAgent: "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en-US; Quest 3 Build/SQ3A.220605.009.A1) gzip",
    },
  },
  {
    name: "IOS",
    headerName: "5",
    clientVersion: "20.10.4",
    context: {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
      userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    },
  },
];

interface YtConfigLike {
  get?: (key: string) => unknown;
  data_?: Record<string, unknown>;
}

function youtubeHostname(pageUrl: string): boolean {
  try {
    const host = new URL(pageUrl).hostname;
    return /(^|\.)youtube\.com$/iu.test(host) || /(^|\.)youtu\.be$/iu.test(host);
  } catch {
    return false;
  }
}

/** Extract the current video id from a watch/shorts/youtu.be URL. */
export function youtubeVideoId(pageUrl: string): string | undefined {
  if (!youtubeHostname(pageUrl)) return undefined;
  try {
    const url = new URL(pageUrl);
    if (/youtu\.be$/iu.test(url.hostname)) return url.pathname.split("/")[1];
    const fromQuery = url.searchParams.get("v");
    if (fromQuery) return fromQuery;
    const shorts = /\/shorts\/([\w-]{6,})/u.exec(url.pathname);
    return shorts?.[1];
  } catch {
    return undefined;
  }
}

function youtubeConfig(): { apiKey?: string; clientVersion?: string; visitorData?: string } {
  const scope = globalThis as unknown as { ytcfg?: YtConfigLike };
  const config = scope.ytcfg;
  const read = (key: string): unknown => {
    try {
      if (typeof config?.get === "function") return config.get(key);
    } catch {
      /* ignore */
    }
    return config?.data_?.[key];
  };
  const apiKey = read("INNERTUBE_API_KEY");
  const clientVersion = read("INNERTUBE_CLIENT_VERSION");
  const visitorData = read("VISITOR_DATA");
  return {
    ...(typeof apiKey === "string" ? { apiKey } : {}),
    ...(typeof clientVersion === "string" ? { clientVersion } : {}),
    ...(typeof visitorData === "string" ? { visitorData } : {}),
  };
}

/** Parse a `clen` query parameter without throwing on signed/odd URLs. */
const declaredTrackSize = (format: { url?: string }): number => {
  if (format.url === undefined) return 0;
  try {
    const value = new URL(format.url).searchParams.get("clen");
    return value === null ? 0 : Number.parseInt(value, 10) || 0;
  } catch {
    return 0;
  }
};

/**
 * Convert one YouTube player response (branding request, page player, or InnerTube) into hints.
 *
 * Exported for tests. Pure apart from nothing: the caller decides whether to log/use the result.
 * Only direct (`url`) formats are usable; SABR/UMP-only responses yield no hints.
 */
function formatCounts(json: YouTubePlayerResponse): {
  adaptive: number;
  direct: number;
  ciphered: number;
  progressive: number;
  hls: boolean;
  sabr: boolean;
} {
  const adaptive = json.streamingData?.adaptiveFormats ?? [];
  const direct = adaptive.filter((format) => typeof format.url === "string");
  const ciphered = adaptive.filter((format) => {
    const candidate = format as { signatureCipher?: unknown; cipher?: unknown };
    return typeof candidate.signatureCipher === "string" || typeof candidate.cipher === "string";
  });
  return {
    adaptive: adaptive.length,
    direct: direct.length,
    ciphered: ciphered.length,
    progressive: (json.streamingData?.formats ?? []).length,
    hls: typeof json.streamingData?.hlsManifestUrl === "string",
    sabr: typeof (json.streamingData as { serverAbrStreamingUrl?: string })?.serverAbrStreamingUrl === "string",
  };
}

export function hintsFromYouTubePlayerResponse(json: YouTubePlayerResponse): PageMediaHint[] {
  const streaming = json.streamingData;
  const direct = <Format extends { url?: string }>(formats: Format[] | undefined): Format[] =>
    (formats ?? []).filter((format) => typeof format.url === "string" && !format.url.includes("sabr=1"));
  const adaptive = direct(streaming?.adaptiveFormats);
  const bestAudio = (mimePattern: RegExp) =>
    adaptive
      .filter((format) => mimePattern.test(format.mimeType ?? "") && typeof format.url === "string")
      .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0))[0];
  const mp4Audio = bestAudio(/^audio\/mp4/iu);
  const webmAudio = bestAudio(/^audio\/webm/iu);
  const families = [
    { demuxer: "mp4", video: /^video\/mp4/iu, codec: /avc1/iu, audio: mp4Audio },
    // Modern Chrome pages may expose only AV1 or HEVC; ffmpeg stream-copy merges both.
    { demuxer: "mp4", video: /^video\/mp4/iu, codec: /av01|av1/iu, audio: mp4Audio },
    { demuxer: "mp4", video: /^video\/mp4/iu, codec: /hvc1|hev1|hevc/iu, audio: mp4Audio },
    { demuxer: "webm", video: /^video\/webm/iu, codec: /vp9|vp8/iu, audio: webmAudio },
  ];
  const candidates = families.flatMap((family) =>
    adaptive
      .filter((format) => family.video.test(format.mimeType ?? "") && family.codec.test(format.mimeType ?? ""))
      .filter((format) => {
        const size = declaredTrackSize(format);
        return size === 0 || size <= MAX_ADAPTIVE_TRACK_BYTES;
      })
      .map((format) => ({ format, demuxer: family.demuxer, audio: family.audio })),
  );
  candidates.sort(
    (left, right) =>
      (right.format.height ?? 0) - (left.format.height ?? 0) || (right.format.bitrate ?? 0) - (left.format.bitrate ?? 0),
  );
  const variants = candidates.map((candidate) => {
    const format = candidate.format;
    return {
      url: format.url as string,
      ...(candidate.audio?.url !== undefined ? { audio_url: candidate.audio.url } : {}),
      demuxer: candidate.demuxer,
      ...(format.mimeType !== undefined ? { mime: format.mimeType } : {}),
      ...(format.itag !== undefined ? { itag: format.itag } : {}),
      ...(format.width !== undefined ? { width: format.width } : {}),
      ...(format.height !== undefined ? { height: format.height } : {}),
      ...(format.bitrate !== undefined ? { bitrate: format.bitrate } : {}),
      ...(declaredTrackSize(format) > 0 ? { size: declaredTrackSize(format) } : {}),
    };
  });
  const best = variants[0];
  if (best !== undefined) {
    return [
      {
        url: best.url,
        ...(best.audio_url !== undefined ? { audio_url: best.audio_url } : {}),
        variants,
        kind: "file",
        source: "player-response",
        ...(streaming?.hlsManifestUrl !== undefined ? { hls_url: streaming.hlsManifestUrl } : {}),
      },
    ];
  }
  if (streaming?.hlsManifestUrl !== undefined) {
    return [{ url: streaming.hlsManifestUrl, kind: "hls", source: "player-response" }];
  }
  // Progressive WEB URLs (itag 18) are known dead with 403; never surface them as an item.
  return [];
}

/** Player responses already present in the page (works for logged-in players; no extra request). */
function pageYouTubePlayerResponses(): YouTubePlayerResponse[] {
  const responses: YouTubePlayerResponse[] = [];
  const push = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const candidate = value as YouTubePlayerResponse;
    if (candidate.streamingData !== undefined || candidate.playabilityStatus !== undefined) responses.push(candidate);
  };
  const scope = globalThis as {
    ytInitialPlayerResponse?: unknown;
    ytplayer?: { config?: { args?: { player_response?: unknown } } };
  };
  push(scope.ytInitialPlayerResponse);
  try {
    const player = document.querySelector("#movie_player") as { getPlayerResponse?: () => unknown } | null;
    push(player?.getPlayerResponse?.());
  } catch {
    /* player API unavailable on non-watch pages */
  }
  const raw = scope.ytplayer?.config?.args?.player_response;
  if (typeof raw === "string") {
    try {
      push(JSON.parse(raw));
    } catch {
      /* ignore malformed legacy payload */
    }
  } else {
    push(raw);
  }
  return responses;
}

/**
 * Ask the InnerTube player API from the page context (cookies included), with a page-player
 * fallback first. YouTube increasingly answers guest InnerTube calls with `LOGIN_REQUIRED`; a
 * signed-in player response already in the page still carries usable formats, so try it before
 * burning an API request. The log line always names the reason so a blocked adapter is diagnosable.
 */
export async function collectYouTubeInnerTubeHints(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PageMediaHint[]> {
  const videoId = youtubeVideoId(pageUrl);
  if (videoId === undefined) return [];
  const config = youtubeConfig();
  const reasons: string[] = [];
  // uses the guest clients first and then MWEB/WEB with cookies. The cookie-backed pair is the last chance
  // for signed-in sessions where YouTube challenges the pseudo-device clients.
  const pageVersion = config.clientVersion ?? "2.20250701.01.00";
  const clients = [
    ...YOUTUBE_CLIENTS,
    {
      name: "MWEB",
      headerName: "2",
      clientVersion: pageVersion,
      context: { clientName: "MWEB", clientVersion: pageVersion },
    },
    {
      name: "WEB",
      headerName: "1",
      clientVersion: pageVersion,
      context: { clientName: "WEB", clientVersion: pageVersion },
    },
  ];
  // InnerTube first: these adaptive URLs are the ones the downloader knows how to range-fetch.
  for (const client of clients) {
    const context = {
      ...client.context,
      hl: "en",
      gl: "US",
      utcOffsetMinutes: 0,
      ...(config.visitorData ? { visitorData: config.visitorData } : {}),
    };
    const body = {
      context: { client: context },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    };
    try {
      const endpoint = `https://www.youtube.com/youtubei/v1/player?prettyPrint=false${
        config.apiKey ? `&key=${config.apiKey}` : ""
      }`;
      const response = await fetchImpl(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-youtube-client-name": client.headerName,
          "x-youtube-client-version": client.clientVersion,
          ...(config.visitorData ? { "x-goog-visitor-id": config.visitorData } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        console.info("[media-downloader] innertube", client.name, "HTTP", response.status);
        reasons.push(`${client.name}:HTTP ${response.status}`);
        continue;
      }
      const json = (await response.json()) as YouTubePlayerResponse;
      const hints = hintsFromYouTubePlayerResponse(json);
      const status = json.playabilityStatus?.status;
      const reason = json.playabilityStatus?.reason;
      const counts = formatCounts(json);
      console.info(
        "[media-downloader] innertube",
        client.name,
        status ?? "?",
        ...(reason !== undefined ? [`reason=${reason}`] : []),
        "formats",
        counts,
        "hints",
        hints.length,
      );
      if (hints.length > 0) return hints;
      if (status !== undefined && status !== "OK") {
        reasons.push(`${client.name}:${status}${reason !== undefined ? ` (${reason})` : ""}`);
      } else if (status === undefined) {
        reasons.push(`${client.name}:no player response`);
      }
    } catch (error) {
      console.info("[media-downloader] innertube", client.name, "failed", String(error));
      reasons.push(`${client.name}:${String(error)}`);
    }
  }

  // Signed-in page fallback: only adaptive video/audio pairs or HLS. Progressive WEB URLs in a
  // page player response are known dead (403) and must not create a broken single-quality item.
  for (const response of pageYouTubePlayerResponses()) {
    console.info("[media-downloader] page player response formats", formatCounts(response));
    const hints = hintsFromYouTubePlayerResponse(response);
    if (hints.length > 0) {
      console.info("[media-downloader] youtube formats from the page player response", hints.length);
      return hints;
    }
    const status = response.playabilityStatus?.status;
    const reason = response.playabilityStatus?.reason;
    if (status !== undefined && status !== "OK") {
      console.info("[media-downloader] youtube page player response unavailable", status, reason ?? "");
      reasons.push(`page:${status}${reason !== undefined ? ` (${reason})` : ""}`);
    } else if ((response.streamingData?.formats ?? []).some((format) => typeof format.url === "string")) {
      console.info("[media-downloader] page player response has only progressive WEB formats (known 403); ignoring");
      reasons.push("page:only progressive WEB formats");
    } else if (status === "OK") {
      console.info("[media-downloader] page player response is OK but SABR-only (no direct adaptive URLs); will retry");
      reasons.push("page:SABR-only (will retry)");
    }
  }
  if (reasons.some((reason) => reason.includes("LOGIN_REQUIRED"))) youtubeLastOutcome = "blocked";
  // console.info, not warn: warnings from content scripts show up as Brave/Chrome extension errors.
  console.info(
    "[media-downloader] YouTube adaptive formats not ready yet:",
    [...new Set(reasons)].join("; ") || "no player response with adaptive formats",
    "- the adapter retries; if this persists, sign in/complete YouTube's check and refresh the tab.",
  );
  return [];
}

/** Short-lived per-page cache: the content script asks repeatedly; the player API must not be hammered. */
let youTubeHintCache: { url: string; at: number; pending?: Promise<PageMediaHint[]>; hints?: PageMediaHint[] } | undefined;
const YOUTUBE_HINT_TTL_MS = 60_000;
/** Empty results are retried quickly: the player often exposes adaptive formats seconds later. */
const YOUTUBE_EMPTY_HINT_TTL_MS = 5_000;
/** When YouTube answers LOGIN_REQUIRED for every client, back off so retries do not deepen the block. */
const YOUTUBE_BLOCKED_HINT_TTL_MS = 60_000;
let youtubeLastOutcome: "empty" | "blocked" = "empty";
/**
 * Largest video track offered for in-browser merging.
 *
 * ffmpeg.wasm single-thread has a hard 2 GiB heap; measured peak tree ~1.66 GB for a 271 MB output.
 * 512 MiB covers 1080p and most 1440p videos; long 4K cannot fit in the browser and is not offered.
 */
const MAX_ADAPTIVE_TRACK_BYTES = 512 * 1024 * 1024;

async function cachedYouTubeHints(pageUrl: string, fetchImpl: typeof fetch): Promise<PageMediaHint[]> {
  const now = Date.now();
  const emptyTtl = youtubeLastOutcome === "blocked" ? YOUTUBE_BLOCKED_HINT_TTL_MS : YOUTUBE_EMPTY_HINT_TTL_MS;
  const ttl = youTubeHintCache?.hints !== undefined && youTubeHintCache.hints.length === 0 ? emptyTtl : YOUTUBE_HINT_TTL_MS;
  if (youTubeHintCache && youTubeHintCache.url === pageUrl && now - youTubeHintCache.at < ttl) {
    return youTubeHintCache.hints ?? (youTubeHintCache.pending ? await youTubeHintCache.pending : []);
  }
  youtubeLastOutcome = "empty";
  const pending = collectYouTubeInnerTubeHints(pageUrl, fetchImpl).catch(() => [] as PageMediaHint[]);
  youTubeHintCache = { url: pageUrl, at: now, pending };
  const hints = await pending;
  youTubeHintCache = { url: pageUrl, at: now, hints };
  return hints;
}

/**
 * Best thumbnail for the page's media.
 *
 * Evidence: the original resolves `link[rel='image_src'], link[rel='thumbnail'], link[as='image']`
 * into `{thumbnail, title}` (service pretty 11672-11706) and the panel uses
 * `media.thumbnail_url.or(meta.thumbnail_url)` (content__panel pretty 12148-12149). We add the
 * page's og:image/video poster and a YouTube thumbnail, which the original gets from its adapter.
 */
export function chooseThumbnail(document: Document, pageUrl: string): string | undefined {
  const absolute = (raw: string | null | undefined): string | undefined => {
    if (!raw) return undefined;
    try {
      const url = new URL(raw, pageUrl || undefined);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const videoId = youtubeVideoId(pageUrl);
    // maxres is sharper; the panel falls back to sd/default when a video has no maxres file.
    if (videoId !== undefined) return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  } catch {
    /* not a YouTube page */
  }
  const firstPoster = Array.from(document.querySelectorAll("video[poster]"))
    .map((video) => video.getAttribute("poster"))
    .find((poster): poster is string => poster !== null && poster.length > 0);
  const candidates = [
    document.querySelector("meta[property='og:image'], meta[name='og:image']")?.getAttribute("content"),
    firstPoster,
    document.querySelector("meta[name='twitter:image']")?.getAttribute("content"),
    document
      .querySelector("link[rel='image_src'], link[rel='thumbnail'], link[as='image']")
      ?.getAttribute("href"),
  ];
  for (const candidate of candidates) {
    const url = absolute(candidate);
    if (url !== undefined) return url;
  }
  return undefined;
}

/** Instagram's shortcode alphabet (media ids are base64 with a URL-safe alphabet). */
const INSTAGRAM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The shortcode for an Instagram post/reel/TV page, if this is one. */
export function instagramShortcode(pageUrl: string): string | undefined {
  try {
    const url = new URL(pageUrl);
    if (!/(^|\.)instagram\.com$/u.test(url.hostname)) return undefined;
    const match = /^\/(?:p|reel|tv)\/([A-Za-z0-9_-]{3,})/u.exec(url.pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Convert an Instagram shortcode to the numeric media id its API expects. */
export function instagramMediaId(shortcode: string): string | undefined {
  let value = 0n;
  for (const char of shortcode) {
    const digit = INSTAGRAM_ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    value = value * 64n + BigInt(digit);
  }
  return value > 0n ? value.toString() : undefined;
}

interface InstagramVideoVersion {
  url?: string;
  width?: number;
  height?: number;
}

interface InstagramMediaInfo {
  pk?: string | number;
  /** Some API responses expose the DASH manifest at the top level. */
  video_dash_manifest?: string;
  id?: string;
  video_url?: string;
  dimensions?: { width?: number; height?: number };
  video_versions?: InstagramVideoVersion[];
  image_versions2?: { candidates?: Array<{ url?: string }> };
  dash_info?: { video_dash_manifest?: string };
  carousel_media?: InstagramMediaInfo[];
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">");
}

function dashVariantsFromXml(xml: string, pageUrl: string): HintVariant[] {
  const parsed = parseMpd(xml, new URL(pageUrl));
  if (parsed.tag !== "Ok") return [];
  const audio = parsed.value.audio[0]?.url;
  if (audio === undefined) return [];
  const variants: HintVariant[] = [];
  for (const entry of parsed.value.video.slice(0, 20)) {
    variants.push({
      url: decodeXmlEntities(entry.url.href),
      audio_url: decodeXmlEntities(audio.href),
      ...(entry.width !== undefined ? { width: entry.width } : {}),
      ...(entry.height !== undefined ? { height: entry.height } : {}),
      ...(entry.bandwidth !== undefined ? { bitrate: entry.bandwidth } : {}),
      demuxer: entry.demuxer,
      mime: entry.demuxer === "webm" ? "video/webm" : "video/mp4",
    });
  }
  return variants;
}

/** DASH manifests embedded directly in Instagram page JSON (logged-in feeds). */
export function collectInlineDashHints(document: Document, pageUrl: string): PageMediaHint[] {
  const hints: PageMediaHint[] = [];
  for (const script of Array.from(document.querySelectorAll("script:not([src])"))) {
    const text = script.textContent ?? "";
    if (text.length === 0 || text.length > 2_000_000 || !text.includes("video_dash_manifest")) continue;
    for (const match of text.matchAll(/"video_dash_manifest"\s*:\s*"((?:[^"\\]|\\.)*)"/gu)) {
      const xml = unescapeJson(match[1] ?? "");
      if (!xml.includes("<MPD")) continue;
      const variants = dashVariantsFromXml(xml, pageUrl);
      if (variants.length === 0) continue;
      variants.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
      const shortcode = instagramShortcode(pageUrl);
      hints.push({
        url: variants[0]?.url ?? "",
        variants,
        kind: "file",
        source: "inline-json",
        referer: pageUrl,
        ...(shortcode !== undefined ? { identity: `ig:post:${shortcode}` } : {}),
      });
    }
  }
  return hints;
}

function instagramMediaHints(media: InstagramMediaInfo, pageUrl: string): PageMediaHint[] {
  const variants: HintVariant[] = [];
  const assetIdentity = media.pk ?? media.id;
  const postShortcode = instagramShortcode(pageUrl);
  // The DASH BaseURLs may not carry efg; the muxed video_versions URLs usually do. Reuse that
  // asset id so an API row and a generic MP4 row of the same post share one stable hash.
  const versionAsset = (media.video_versions ?? [])
    .map((version) => (typeof version.url === "string" ? instagramAssetKey(version.url) : undefined))
    .find((key) => key !== undefined);
  const dashXml = media.video_dash_manifest ?? media.dash_info?.video_dash_manifest;
  if (typeof dashXml === "string" && dashXml.length > 0) {
    variants.push(...dashVariantsFromXml(dashXml, pageUrl));
  }
  if (variants.length === 0) {
    const videos =
      Array.isArray(media.video_versions) && media.video_versions.length > 0
        ? media.video_versions
        : typeof media.video_url === "string"
          ? [
              {
                url: media.video_url,
                ...(media.dimensions?.width !== undefined ? { width: media.dimensions.width } : {}),
                ...(media.dimensions?.height !== undefined ? { height: media.dimensions.height } : {}),
              },
            ]
          : [];
    const seen = new Set<string>();
    for (const video of videos) {
      if (typeof video.url !== "string") continue;
      const classified = classifyHintUrl(video.url, pageUrl);
      if (classified === undefined || classified.kind !== "file" || seen.has(classified.url)) continue;
      seen.add(classified.url);
      const identity = fileIdentity(new URL(classified.url));
      variants.push({
        url: classified.url,
        ...(typeof video.width === "number" && Number.isFinite(video.width) && video.width > 0 ? { width: video.width } : {}),
        ...(typeof video.height === "number" && Number.isFinite(video.height) && video.height > 0 ? { height: video.height } : {}),
        demuxer: identity.demuxer,
        mime: identity.demuxer === "webm" ? "video/webm" : "video/mp4",
      });
    }
  }
  if (variants.length === 0) return [];
  variants.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  const urlAsset = variants.map((variant) => instagramAssetKey(variant.url)).find((key) => key !== undefined);
  const identity =
    (urlAsset ?? versionAsset) !== undefined
      ? `ig:asset:${urlAsset ?? versionAsset}`
      : assetIdentity !== undefined
        ? `ig:asset:${String(assetIdentity)}`
        : postShortcode !== undefined
          ? `ig:post:${postShortcode}`
          : undefined;
  const thumbnail = media.image_versions2?.candidates
    ?.map((candidate) => candidate.url)
    .find((url): url is string => typeof url === "string" && url.length > 0);
  return [
    {
      url: variants[0]?.url ?? "",
      variants,
      kind: "file",
      source: "player-response",
      referer: pageUrl,
      focused: true,
      ...(identity !== undefined ? { identity } : {}),
      ...(thumbnail !== undefined ? { thumbnail } : {}),
    },
  ];
}

function cacheInstagramHints(pageUrl: string, hints: PageMediaHint[]): void {
  if (instagramHintsCache.size >= 50 && !instagramHintsCache.has(pageUrl)) {
    const oldest = [...instagramHintsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest !== undefined) instagramHintsCache.delete(oldest);
  }
  instagramHintsCache.set(pageUrl, { at: Date.now(), hints });
}
const instagramHintsCache = new Map<string, { at: number; hints: PageMediaHint[] }>();
const INSTAGRAM_HINTS_TTL_MS = 60_000;

/** Current-post renditions from Instagram's own media-info API (page cookies included). */
export async function collectInstagramHints(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PageMediaHint[]> {
  const shortcode = instagramShortcode(pageUrl);
  const mediaId = shortcode === undefined ? undefined : instagramMediaId(shortcode);
  if (shortcode === undefined || mediaId === undefined) return [];
  const cached = instagramHintsCache.get(pageUrl);
  if (cached !== undefined && Date.now() - cached.at < INSTAGRAM_HINTS_TTL_MS) return cached.hints;
  const csrftoken = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("csrftoken="))
    ?.slice("csrftoken=".length);
  const endpoints = [
    `https://www.instagram.com/api/v1/media/${mediaId}/info/`,
    `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`,
  ];
  try {
    for (const endpoint of endpoints) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          credentials: "include",
          headers: {
            accept: "*/*",
            origin: "https://www.instagram.com",
            "x-ig-app-id": "936619743392459",
            "x-asbd-id": "359341",
            "x-ig-www-claim": "0",
            "x-requested-with": "XMLHttpRequest",
            ...(csrftoken !== undefined && csrftoken.length > 0 ? { "x-csrftoken": csrftoken } : {}),
          },
        });
      } catch {
        continue;
      }
      if (!response.ok || !/json/iu.test(response.headers?.get?.("content-type") ?? "")) continue;
      let json: {
        items?: InstagramMediaInfo[];
        video_url?: string;
        data?: { items?: InstagramMediaInfo[]; shortcode_media?: InstagramMediaInfo };
        graphql?: { shortcode_media?: InstagramMediaInfo };
      };
      try {
        json = (await response.json()) as typeof json;
      } catch {
        continue;
      }
      const media = json.graphql?.shortcode_media ?? json.data?.shortcode_media;
      const items =
        json.items ??
        json.data?.items ??
        (media !== undefined
          ? [media]
          : typeof json.video_url === "string"
            ? [json as InstagramMediaInfo]
            : []);
      const hints = items.flatMap((item) =>
        Array.isArray(item.carousel_media) && item.carousel_media.length > 0
          ? item.carousel_media.flatMap((child) => instagramMediaHints(child, pageUrl))
          : instagramMediaHints(item, pageUrl),
      );
      if (hints.length > 0) {
        console.info(
          "[media-downloader] Instagram media API:",
          hints.length,
          "video(s),",
          hints.reduce((total, hint) => total + (hint.variants?.length ?? 0), 0),
          "rendition(s) (DASH/direct)",
        );
        cacheInstagramHints(pageUrl, hints);
        return hints;
      }
    }
  } catch {
    /* fall through to the generic DOM/resource collector */
  }
  console.info("[media-downloader] Instagram media API unavailable; using page-embedded fallback");
  cacheInstagramHints(pageUrl, []);
  return [];
}

// ---------------------------------------------------------------------------
// Bilibili adapter
// ---------------------------------------------------------------------------

interface BilibiliDashVideo {
  id?: number;
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  bandwidth?: number;
  mimeType?: string;
  mime_type?: string;
  width?: number;
  height?: number;
}

interface BilibiliDashAudio {
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  bandwidth?: number;
  mimeType?: string;
  mime_type?: string;
}

interface BilibiliPlayInfo {
  data?: {
    dash?: {
      video?: BilibiliDashVideo[];
      audio?: BilibiliDashAudio[];
    };
  };
}

function bilibiliHostname(pageUrl: string): boolean {
  try {
    return /(^|\.)bilibili\.com$/iu.test(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
}

function bilibiliMediaUrl(entry: { baseUrl?: string; base_url?: string; backupUrl?: string[]; backup_url?: string[] }): string | undefined {
  const candidates = [entry.baseUrl, entry.base_url, ...(entry.backupUrl ?? []), ...(entry.backup_url ?? [])];
  return candidates.find((value): value is string => typeof value === "string" && /^https?:\/\//iu.test(value));
}

function bilibiliPlayInfo(): BilibiliPlayInfo | undefined {
  const value = (globalThis as { __playinfo__?: unknown }).__playinfo__;
  return value !== null && typeof value === "object" ? (value as BilibiliPlayInfo) : undefined;
}

function bilibiliHintsFromData(
  data: BilibiliPlayInfo["data"],
  pageUrl: string,
  document: Document,
): PageMediaHint[] {
  if (!bilibiliHostname(pageUrl)) return [];
  const dash = data?.dash;
  if (dash === undefined) return [];
  const audio = [...(dash.audio ?? [])]
    .filter((entry) => bilibiliMediaUrl(entry) !== undefined)
    .sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0];
  const audioUrl = audio === undefined ? undefined : bilibiliMediaUrl(audio);
  const variants: HintVariant[] = [];
  const seen = new Set<string>();
  for (const entry of dash.video ?? []) {
    const url = bilibiliMediaUrl(entry);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    const mime = entry.mimeType ?? entry.mime_type ?? "";
    const demuxer = /webm/iu.test(mime) ? "webm" : "mp4";
    variants.push({
      url,
      ...(entry.width !== undefined && entry.width > 0 ? { width: entry.width } : {}),
      ...(entry.height !== undefined && entry.height > 0 ? { height: entry.height } : {}),
      ...(entry.bandwidth !== undefined && entry.bandwidth > 0 ? { bitrate: entry.bandwidth } : {}),
      demuxer,
      ...(mime.length > 0 ? { mime } : {}),
      ...(audioUrl !== undefined ? { audio_url: audioUrl } : {}),
    });
    if (variants.length >= 32) break;
  }
  if (variants.length === 0) return [];
  variants.sort((left, right) => (right.height ?? 0) - (left.height ?? 0) || (right.bitrate ?? 0) - (left.bitrate ?? 0));
  const bvid = bilibiliVideoId(pageUrl);
  const thumbnail =
    document.querySelector("meta[property='og:image']")?.getAttribute("content") ??
    document.querySelector("meta[name='og:image']")?.getAttribute("content");
  return [
    {
      url: variants[0]?.url ?? "",
      variants,
      kind: "file",
      source: "player-response",
      allow_segment: true,
      focused: true,
      ...(bvid !== undefined ? { identity: `bili:${bvid}` } : {}),
      ...(document.title.length > 0 ? { title: document.title } : {}),
      ...(thumbnail !== null && thumbnail !== undefined && thumbnail.length > 0 ? { thumbnail } : {}),
    },
  ];
}

function bilibiliDashHints(pageUrl: string, document: Document): PageMediaHint[] {
  return bilibiliHintsFromData(bilibiliPlayInfo()?.data, pageUrl, document);
}

function bilibiliCid(pageUrl: string): number | undefined {
  const scope = globalThis as { __INITIAL_STATE__?: unknown };
  const state = scope.__INITIAL_STATE__;
  if (state === null || typeof state !== "object") return undefined;
  const videoData = (state as { videoData?: { cid?: unknown; pages?: Array<{ cid?: unknown }> } }).videoData;
  const requestedPage = Number.parseInt(new URL(pageUrl).searchParams.get("p") ?? "1", 10);
  const index = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage - 1 : 0;
  const cid = videoData?.pages?.[index]?.cid ?? videoData?.cid ?? videoData?.pages?.[0]?.cid;
  return typeof cid === "number" && cid > 0 ? cid : undefined;
}

const bilibiliHintsCache = new Map<string, { at: number; hints: PageMediaHint[] }>();
const BILIBILI_HINTS_TTL_MS = 60_000;

/** Fallback to Bilibili's playurl API when the page has not exposed __playinfo__ yet. */
async function collectBilibiliApiHints(
  pageUrl: string,
  document: Document,
  fetchImpl: typeof fetch,
): Promise<PageMediaHint[]> {
  if (!bilibiliHostname(pageUrl)) return [];
  const bvid = bilibiliVideoId(pageUrl);
  const cid = bilibiliCid(pageUrl);
  if (bvid === undefined || cid === undefined) return [];
  const cacheKey = `${bvid}:${cid}`;
  const cached = bilibiliHintsCache.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.at < BILIBILI_HINTS_TTL_MS) return cached.hints;
  try {
    const response = await fetchImpl(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=127&fnval=4048&fourk=1`,
      { credentials: "include" },
    );
    if (!response.ok) return [];
    const json = (await response.json()) as { data?: BilibiliPlayInfo["data"] };
    const hints = bilibiliHintsFromData(json.data, pageUrl, document);
    if (bilibiliHintsCache.size >= 50 && !bilibiliHintsCache.has(cacheKey)) {
      const oldest = [...bilibiliHintsCache.entries()].sort((left, right) => left[1].at - right[1].at)[0]?.[0];
      if (oldest !== undefined) bilibiliHintsCache.delete(oldest);
    }
    bilibiliHintsCache.set(cacheKey, { at: Date.now(), hints });
    return hints;
  } catch {
    return [];
  }
}

function bilibiliVideoId(pageUrl: string): string | undefined {
  try {
    const match = /\/video\/(BV[0-9A-Za-z]+)/u.exec(new URL(pageUrl).pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

interface RenderedQuality {
  width: number;
  height: number;
  bitrate?: number;
}

function renderedVideos(root: Document | ShadowRoot): HTMLVideoElement[] {
  const videos = Array.from(root.querySelectorAll("video")) as HTMLVideoElement[];
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow !== null && shadow !== undefined) videos.push(...renderedVideos(shadow));
  }
  return videos;
}

function pageRenderedQuality(document: Document): RenderedQuality | undefined {
  const videos = renderedVideos(document);
  const video = videos.find((candidate) => !candidate.paused && candidate.videoWidth > 0) ??
    videos.find((candidate) => candidate.videoWidth > 0);
  if (video === undefined) return undefined;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return undefined;
  let bytes = 0;
  try {
    if (typeof performance?.getEntriesByType === "function") {
      for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
        if (!/\.(?:ts|m4s|mp4|m4a|webm)(?:[?#]|$)/iu.test(entry.name)) continue;
        const size = entry.transferSize > 0 ? entry.transferSize : entry.encodedBodySize;
        if (Number.isFinite(size) && size > 0) bytes += size;
      }
    }
  } catch {
    /* resource timing unavailable */
  }
  const duration = video.duration;
  const bitrate =
    Number.isFinite(duration) && duration > 0 && bytes > 0 ? Math.round((bytes * 8) / duration) : undefined;
  return { width, height, ...(bitrate !== undefined && bitrate > 0 ? { bitrate } : {}) };
}

const HLS_PAGE_PROBE_TIMEOUT_MS = 4000;
const HLS_PAGE_PROBE_MANIFEST_MAX = 8 * 1024 * 1024;
const HLS_PAGE_PROBE_SEGMENT_MAX = 3 * 1024 * 1024;
interface HlsPageQuality { width: number; height: number; bitrate?: number }
const hlsPageQualityCache = new Map<string, { at: number; quality?: HlsPageQuality }>();

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      const value = read.value;
      if (value === undefined) break;
      const remaining = maxBytes - total;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel?.().catch(() => undefined);
  }
  if (total === 0) return undefined;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchPageBytes(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HLS_PAGE_PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { credentials: "include", signal: controller.signal });
    if (!response.ok) return undefined;
    return await readLimitedBody(response, maxBytes);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Cross-origin HLS metadata is fetched by the page, never by the privileged worker. */
async function pageHlsQuality(
  hint: PageMediaHint,
  pageUrl: string,
  fetchImpl: typeof fetch,
): Promise<HlsPageQuality | undefined> {
  let manifestUrl: URL;
  try {
    manifestUrl = new URL(hint.url, pageUrl);
  } catch {
    return undefined;
  }
  if (manifestUrl.protocol !== "http:" && manifestUrl.protocol !== "https:") return undefined;
  const cached = hlsPageQualityCache.get(manifestUrl.href);
  if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.quality;
  let quality: HlsPageQuality | undefined;
  try {
    const manifestBytes = await fetchPageBytes(manifestUrl.href, fetchImpl, HLS_PAGE_PROBE_MANIFEST_MAX);
    if (manifestBytes === undefined) {
      hlsPageQualityCache.set(manifestUrl.href, { at: Date.now() });
      return undefined;
    }
    const parsed = parsePlaylist(new TextDecoder().decode(manifestBytes), manifestUrl);
    if (parsed.kind === "master") {
      const best = parsed.variants
        .filter((variant) => variant.resolution !== undefined)
        .sort(
          (left, right) =>
            (right.resolution?.width ?? 0) * (right.resolution?.height ?? 0) -
              (left.resolution?.width ?? 0) * (left.resolution?.height ?? 0) ||
            (right.bandwidth ?? 0) - (left.bandwidth ?? 0),
        )[0];
      if (best?.resolution !== undefined) {
        quality = {
          width: best.resolution.width,
          height: best.resolution.height,
          ...(best.bandwidth !== undefined ? { bitrate: best.bandwidth } : {}),
        };
      }
    } else if (parsed.kind === "media") {
      const segment = parsed.segments[0];
      if (segment !== undefined) {
        const segmentBytes = await fetchPageBytes(segment.uri.href, fetchImpl, HLS_PAGE_PROBE_SEGMENT_MAX);
        const dimensions = segmentBytes !== undefined ? probeMpegTsVideoSize(segmentBytes) : undefined;
        if (dimensions !== undefined) {
          const duration = segment.duration;
          const bitrate =
            segmentBytes !== undefined && duration !== undefined && duration > 0
              ? Math.round((segmentBytes.byteLength * 8) / duration)
              : undefined;
          quality = {
            width: dimensions.width,
            height: dimensions.height,
            ...(bitrate !== undefined && bitrate > 0 ? { bitrate } : {}),
          };
        }
      }
    }
  } catch {
    quality = undefined;
  }
  hlsPageQualityCache.set(manifestUrl.href, { at: Date.now(), ...(quality !== undefined ? { quality } : {}) });
  return quality;
}

async function probePageHlsQuality(hints: PageMediaHint[], pageUrl: string, fetchImpl: typeof fetch): Promise<void> {
  const targets = hints.filter((hint) => hint.kind === "hls" && hint.rendered_width === undefined).slice(0, 2);
  await Promise.all(
    targets.map(async (hint) => {
      const quality = await pageHlsQuality(hint, pageUrl, fetchImpl);
      if (quality === undefined) return;
      hint.rendered_width = quality.width;
      hint.rendered_height = quality.height;
      if (hint.estimated_bitrate === undefined && quality.bitrate !== undefined) {
        hint.estimated_bitrate = quality.bitrate;
      }
    }),
  );
}

/** Collect hints for the current page (YouTube uses the InnerTube adapter only). */
export async function collectHintsForPage(
  pageUrl: string,
  document: Document,
  resourceEntries: readonly (string | ResourceTimingHint)[],
  fetchImpl: typeof fetch = fetch,
): Promise<PageMediaHint[]> {
  if (youtubeHostname(pageUrl)) {
    const innerTube = await cachedYouTubeHints(pageUrl, fetchImpl);
    if (innerTube.length === 0) return [];
    // A page player may use HLS without putting hlsManifestUrl in the InnerTube response;
    // the resource timeline still knows the manifest, so keep it as the alternate source.
    const hlsResource = resourceEntries
      .map((entry) => (typeof entry === "string" ? entry : entry.url))
      .find((url) => /(?:^|\.)m3u8(?:$|[?#])/iu.test(url) || /manifest\.googlevideo\.com\/api\/manifest\/hls/iu.test(url));
    const withAlternate =
      hlsResource === undefined
        ? innerTube
        : innerTube.map((hint) =>
            hint.kind === "file" && hint.hls_url === undefined ? { ...hint, hls_url: hlsResource } : hint,
          );
    return withTitle(withAlternate, document);
  }
  const instagramPageUrl =
    instagramShortcode(pageUrl) !== undefined
      ? pageUrl
      : (() => {
          const canonical =
            document.querySelector("link[rel='canonical']")?.getAttribute("href") ??
            document.querySelector("meta[property='og:url']")?.getAttribute("content");
          return canonical !== null && canonical !== undefined && instagramShortcode(canonical) !== undefined
            ? canonical
            : undefined;
        })();
  if (instagramPageUrl !== undefined) {
    const instagram = await collectInstagramHints(instagramPageUrl, fetchImpl);
    const inlineDash = collectInlineDashHints(document, instagramPageUrl);
    const apiHasChoice = instagram.some((hint) => (hint.variants?.length ?? 0) > 1);
    const chosen = !apiHasChoice && inlineDash.length > 0 ? inlineDash.slice(0, 1) : instagram;
    if (chosen.length > 0) {
      const titled = withTitle(chosen, document);
      for (const hint of titled) hint.focused = true;
      return titled;
    }
  }
  const bilibili = bilibiliDashHints(pageUrl, document);
  const bilibiliFallback = bilibili.length > 0 ? bilibili : await collectBilibiliApiHints(pageUrl, document, fetchImpl);
  if (bilibiliFallback.length > 0) return withTitle(bilibiliFallback, document);
  const hints = collectMediaHints(document, pageUrl, resourceEntries);
  // A blob/MSE player often hides the real URL, leaving network hints without a resolution.
  // When the page has a single <video>, its rendered dimensions are the best exact quality
  // available; attach them to each direct file hint instead of showing just "MP4".
  const rendered = pageRenderedQuality(document);
  if (rendered !== undefined) {
    for (const hint of hints) {
      if (hint.rendered_width === undefined) hint.rendered_width = rendered.width;
      if (hint.rendered_height === undefined) hint.rendered_height = rendered.height;
      if (hint.estimated_bitrate === undefined && rendered.bitrate !== undefined) {
        hint.estimated_bitrate = rendered.bitrate;
      }
      if (hint.kind !== "file" || (hint.variants !== undefined && hint.variants.length > 0)) continue;
      try {
        const identity = fileIdentity(new URL(hint.url));
        hint.variants = [
          {
            url: hint.url,
            width: rendered.width,
            height: rendered.height,
            ...(rendered.bitrate !== undefined ? { bitrate: rendered.bitrate } : {}),
            demuxer: identity.demuxer,
            mime: identity.demuxer === "webm" ? "video/webm" : "video/mp4",
          },
        ];
      } catch {
        /* malformed hint already filtered by the collector */
      }
    }
  }
  attachTwitterPreviewUrls(hints);
  attachSiblingPreviewUrl(hints);
  await probePageHlsQuality(hints, pageUrl, fetchImpl);
  return hints;
}
interface ActiveMediaState {
  urls: Set<string>;
  at: number;
}

let activeMedia: ActiveMediaState | undefined;
const ACTIVE_MEDIA_TTL_MS = 120_000;

/** Record a play/focus event and map it to the media URLs requested while it plays. */
function noteMediaEvent(target: EventTarget | null): void {
  const element =
    target instanceof HTMLVideoElement || target instanceof HTMLAudioElement
      ? target
      : target instanceof Element
        ? (target.closest("video, audio") as HTMLMediaElement | null)
        : null;
  const urls = new Set<string>();
  if (element) {
    for (const raw of [element.currentSrc, element.getAttribute("src")]) {
      const key = focusKey(raw);
      if (key !== undefined) urls.add(key);
    }
  }
  const baseline = new Set(currentResourceEntries().map((entry) => entry.url));
  const state: ActiveMediaState = { urls, at: Date.now() };
  activeMedia = state;
  // MSE/blob playback issues network requests shortly after `play`; those URLs identify the
  // asset even when the element source itself is a blob URL.
  setTimeout(() => {
    if (activeMedia !== state) return;
    for (const entry of currentResourceEntries()) {
      if (baseline.has(entry.url)) continue;
      const key = focusKey(entry.url);
      if (key !== undefined) state.urls.add(key);
    }
  }, 1500);
}

/** Focused media URL identities, or an empty list when nothing played recently. */
function currentFocusUrls(): string[] {
  if (activeMedia === undefined || Date.now() - activeMedia.at > ACTIVE_MEDIA_TTL_MS) return [];
  return [...activeMedia.urls];
}

export interface FocusedHints {
  hints: PageMediaHint[];
  focusActive: boolean;
  focusedUrls: string[];
}

/** Mark hints that belong to the focused/playing media (pure, unit-testable). */
export function applyFocusToHints(hints: PageMediaHint[], focusUrls: readonly string[]): FocusedHints {
  const keys = new Set(focusUrls);
  const preFocused = hints.filter((hint) => hint.focused === true);
  const focusedUrlsFor = (): string[] =>
    [
      ...new Set(
        hints
          .filter((hint) => hint.focused === true)
          .flatMap((hint) => [hint.url, ...(hint.variants ?? []).map((variant) => variant.url)]),
      ),
    ].slice(0, 20);
  if (keys.size === 0) {
    return preFocused.length > 0
      ? { hints, focusActive: true, focusedUrls: focusedUrlsFor() }
      : { hints, focusActive: false, focusedUrls: [] };
  }
  let matched = preFocused.length;
  for (const hint of hints) {
    const candidates = [hint.url, ...(hint.variants ?? []).map((variant) => variant.url)];
    const key = candidates.map((url) => focusKey(url)).find((entry) => entry !== undefined && keys.has(entry));
    if (key !== undefined) {
      hint.focused = true;
      matched += 1;
    }
  }
  if (matched === 0) return { hints, focusActive: false, focusedUrls: [] };
  return { hints, focusActive: true, focusedUrls: focusedUrlsFor() };
}

let pageChannel: BroadcastChannel | undefined;
let hintPushTimer: ReturnType<typeof setTimeout> | undefined;

/** Push hints without waiting for the content script's poll (play/visibility resume). */
function scheduleHintPush(): void {
  if (pageChannel === undefined || hintPushTimer !== undefined) return;
  hintPushTimer = setTimeout(() => {
    hintPushTimer = undefined;
    if (pageChannel !== undefined) void respondWithHints(pageChannel);
  }, 700);
}

/** Attach the bridge to the page world. Idempotent. */
export function installPageHook(): void {
  const globalScope = globalThis as unknown as { __mediaDownloaderHookInstalled?: boolean };
  if (globalScope.__mediaDownloaderHookInstalled) return;
  globalScope.__mediaDownloaderHookInstalled = true;

  const channel = new BroadcastChannel(injectedHrefChannel(globalThis.location?.href ?? ""));
  channel.addEventListener("message", (event) => {
    const envelope = event.data as { msg?: { name?: string }; channel?: number };
    if (envelope?.channel !== Channel.FromTrustedInjectedToUntrusted) return;
    if (envelope.msg?.name !== PAGE_REQUEST_MEDIA_HINTS) return;
    void respondWithHints(channel);
  });
  pageChannel = channel;
  const onMediaEvent = (event: Event): void => {
    noteMediaEvent(event.target);
    scheduleHintPush();
  };
  document.addEventListener("play", onMediaEvent, true);
  document.addEventListener("playing", onMediaEvent, true);
  document.addEventListener("focusin", onMediaEvent, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleHintPush();
  });
}

async function respondWithHints(channel: BroadcastChannel): Promise<void> {
  const pageUrl = globalThis.location?.href ?? "";
  try {
    const hints = await collectHintsForPage(pageUrl, document, currentResourceEntries());
    const thumbnail = chooseThumbnail(document, pageUrl);
    if (thumbnail !== undefined) {
      for (const hint of hints) if (hint.thumbnail === undefined) hint.thumbnail = thumbnail;
    }
    const focused = applyFocusToHints(hints, currentFocusUrls());
    channel.postMessage({
      msg: {
        name: PAGE_ON_MEDIA_HINTS,
        data: {
          hints: focused.hints,
          title: document.title,
          referer: pageUrl,
          ...(focused.focusActive
            ? { focus_active: true, focused_urls: focused.focusedUrls }
            : {}),
        },
      },
      channel: Channel.FromUntrustedInjectedToTrusted,
    });
  } catch (error) {
    console.warn("[media-downloader] hint collection failed", error);
  }
}

// Auto-install when injected in the page world. Guarded for test environments (`process` only
// exists in Node/vitest, never in the page's MAIN world).
if (
  typeof process === "undefined" &&
  typeof document !== "undefined" &&
  typeof BroadcastChannel === "function" &&
  typeof globalThis.location?.href === "string"
) {
  try {
    installPageHook();
    console.info("[media-downloader] page hook active", globalThis.location.href);
  } catch (error) {
    console.error("[media-downloader] page hook failed", error);
  }
}
