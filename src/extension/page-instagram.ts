import { parseMpd } from "../manifests/dash.js";
import { classifyHintUrl, fileIdentity, type HintVariant, type PageMediaHint } from "./media-hint.js";
import { instagramAssetKey, unescapeJson } from "./page-adapter-utils.js";

const INSTAGRAM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

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
    // Fall through to the generic DOM and resource collector.
  }
  console.info("[media-downloader] Instagram media API unavailable; using page-embedded fallback");
  cacheInstagramHints(pageUrl, []);
  return [];
}
