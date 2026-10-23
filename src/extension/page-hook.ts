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
import { instagramAssetKey, unescapeJson } from "./page-adapter-utils.js";
import { collectBilibiliApiHints, bilibiliDashHints } from "./page-bilibili.js";
import {
  collectInlineDashHints,
  collectInstagramHints,
  instagramMediaId,
  instagramShortcode,
} from "./page-instagram.js";
import {
  cachedYouTubeHints,
  collectYouTubeInnerTubeHints,
  hintsFromYouTubePlayerResponse,
  youtubeHostname,
  youtubeVideoId,
} from "./page-youtube.js";

export { PAGE_ON_MEDIA_HINTS, PAGE_REQUEST_MEDIA_HINTS, classifyHintUrl };
export {
  collectYouTubeInnerTubeHints,
  hintsFromYouTubePlayerResponse,
  instagramMediaId,
  instagramShortcode,
  youtubeVideoId,
};
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
