/**
 * Shared page-hint model used by the MAIN-world hook and the ISOLATED-world adapter.
 *
 * Real-world corrections baked in here (learned from live Instagram/YouTube testing):
 *  - Players request the same media URL with `bytestart`/`byteend` byte-range parameters. Those
 *    are *chunks*, not files; treating them as files downloads a few hundred bytes. They are
 *    canonicalised (range params stripped) and only used as fallback when no full-file URL exists.
 *  - Instagram's feed JSON contains many videos; the open post also exposes `og:video`/`<video>`.
 *    The extractor prefers current-page sources and, when falling back, ranks candidates so a
 *    single progressive/muxed stream wins over video-only + audio-only variants.
 */

export const PAGE_REQUEST_MEDIA_HINTS = "request_media_hints";
export const PAGE_ON_MEDIA_HINTS = "on_media_hints";

export type HintKind = "hls" | "dash" | "file";

export type HintSource =
  | "video"
  | "source"
  | "og:video"
  | "json-ld"
  | "inline-json"
  | "player-response"
  | "resource-entry";

/** One selectable quality of a direct (non-manifest) media item. */
export interface HintVariant {
  url: string;
  audio_url?: string;
  mime?: string;
  /** Source demuxer of this rendition (`mp4` or `webm`). */
  demuxer?: string;
  itag?: number;
  width?: number;
  height?: number;
  /** Bits per second as reported by the player. */
  bitrate?: number;
  /** Declared byte size (`clen`). */
  size?: number;
}

export interface PageMediaHint {
  url: string;
  /** Stable identity from an adapter (Instagram post/asset id); used for row hashing. */
  identity?: string;
  /** Separate audio track URL (YouTube adaptive formats); muxed with the video track. */
  audio_url?: string;
  /** All selectable renditions, best first (quality dropdown). */
  variants?: HintVariant[];
  source: HintSource;
  kind: HintKind;
  durationSeconds?: number;
  title?: string;
  referer?: string;
  /** Poster/og:image/link-rel thumbnail for the media (VDH shows one per item). */
  thumbnail?: string;
  /** Direct video track URL used for a hover preview when the item itself is a manifest. */
  preview?: string;
  /** HLS alternative for a direct format stream, when the player exposes both. */
  hls_url?: string;
  /** Rendered video size, used when the source manifest has no resolution metadata. */
  rendered_width?: number;
  rendered_height?: number;
  /** Approximate average bitrate from page resource timing, when available. */
  estimated_bitrate?: number;
  /** Adapter-certified fragment file (e.g. Bilibili .m4s) that is a whole track, not a segment. */
  allow_segment?: boolean;
  /** Set by the page hook when this hint belongs to the focused/playing media element. */
  focused?: boolean;
}

const IGNORED_PATH = /\.(?:ts|m4s|m2ts|jpg|jpeg|png|gif|webp|avif|svg|css|js|json|html?)(?:[?#]|$)/i;
const FILE_PATH = /\.(mp4|m4v|webm|mkv|mov|mp3|m4a|ogg|opus)(?:[?#]|$)/i;
const HLS_PATH = /\.m3u8(?:[?#]|$)/i;
const HLS_FRAGMENT_PATH = /(?:_part\d+|_init_[A-Za-z0-9_-]+)\.(?:mp4|m4s|ts)(?:[?#]|$)/i;
const HLS_REFRESH_PARAMS = ["_HLS_msn", "_HLS_part", "_HLS_skip"] as const;
const DASH_PATH = /\.mpd(?:[?#]|$)/i;

/** Query parameters used by players to request a byte range of the same asset. */
const RANGE_PARAMS = ["bytestart", "byteend", "range", "rbuf", "rn"] as const;

/** True when the URL addresses a byte-range chunk rather than a complete file. */
export function isRangeChunk(url: URL): boolean {
  return RANGE_PARAMS.some((param) => url.searchParams.has(param));
}

/** The underlying full-file URL for a range chunk (range params removed). */
export function canonicalFileUrl(url: URL): URL {
  const canonical = new URL(url.href);
  for (const param of RANGE_PARAMS) canonical.searchParams.delete(param);
  // Keep the original parameter order stable for dedupe.
  return canonical;
}

/** One resource-timing entry (subset of PerformanceResourceTiming). */
export interface ResourceTimingHint {
  url: string;
  status?: number;
  transferSize?: number;
}

/** Classify a complete (non-chunk) candidate URL into a manifest or whole-file hint. */
export function classifyHintUrl(raw: string, baseUrl: string): { url: string; kind: HintKind } | undefined {
  let resolved: URL;
  try {
    resolved = new URL(raw, baseUrl);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
  // SABR (UMP) endpoints answer GET with a protocol blob, not media bytes.
  if (resolved.searchParams.get("sabr") === "1") return undefined;
  // Byte-range chunk: not a file on its own. Callers use `classifyRangeChunkUrl` for fallbacks.
  if (isRangeChunk(resolved)) return undefined;
  if (HLS_FRAGMENT_PATH.test(resolved.pathname)) return undefined;
  const href = resolved.href;
  if (IGNORED_PATH.test(resolved.pathname) && !HLS_PATH.test(resolved.pathname)) return undefined;

  if (HLS_PATH.test(resolved.pathname) || HLS_PATH.test(resolved.search)) {
    const canonical = new URL(resolved.href);
    for (const param of HLS_REFRESH_PARAMS) canonical.searchParams.delete(param);
    return { url: canonical.href, kind: "hls" };
  }
  if (DASH_PATH.test(resolved.pathname)) return { url: href, kind: "dash" };
  // YouTube/GoogleVideo media files do not end in a file extension.
  if (/videoplayback/i.test(resolved.pathname)) return { url: href, kind: "file" };
  if (FILE_PATH.test(resolved.pathname)) return { url: href, kind: "file" };
  return undefined;
}

/** Fallback classification: chunk URLs are canonicalised to their full asset URL. */
export function classifyRangeChunkUrl(
  raw: string,
  baseUrl: string,
): { url: string; kind: "file"; range: boolean } | undefined {
  let resolved: URL;
  try {
    resolved = new URL(raw, baseUrl);
  } catch {
    return undefined;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
  if (resolved.searchParams.get("sabr") === "1") return undefined;
  if (!isRangeChunk(resolved)) return undefined;
  const canonical = canonicalFileUrl(resolved);
  if (!FILE_PATH.test(canonical.pathname) && !/videoplayback/i.test(canonical.pathname)) return undefined;
  return { url: canonical.href, kind: "file", range: true };
}

/** Decode the Instagram/YouTube `efg` tagging parameter when present (best effort). */
export function decodeTaggingParameter(url: URL): string {
  const raw = url.searchParams.get("efg");
  if (!raw) return "";
  try {
    return atob(decodeURIComponent(raw));
  } catch {
    return "";
  }
}

/** Instagram asset identity from the base64 `efg` tag (xpv_asset_id / asset_id). */
export function instagramAssetKey(rawUrl: string): string | undefined {
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

/**
 * Rank a file candidate for display/download preference.
 *  0 = progressive/muxed (audio+video in one file) — best
 *  1 = unknown layout
 *  2 = audio-only
 *  3 = video-only
 */
export function fileHintRank(url: URL): number {
  const tag = `${url.pathname} ${decodeTaggingParameter(url)}`.toLowerCase();
  if (tag.includes("progressive")) return 0;
  if (/\/m86\//u.test(url.pathname)) return 0; // Instagram's muxed progressive bucket
  const audioOnly = tag.includes("_audio") || /\/m78\//u.test(url.pathname);
  if (audioOnly) return 2;
  if (/dash_|vp9|avc1|hev1|av1|baseline|hfr/u.test(tag)) return 3;
  return 1;
}

/** Prefer a single muxed stream when one exists; otherwise keep a small mixed fallback list. */
export function chooseBestHints(hints: readonly PageMediaHint[], limit = 12): PageMediaHint[] {
  if (hints.length === 0) return [];
  const scored = hints.map((hint) => {
    let url: URL | undefined;
    try {
      url = new URL(hint.url);
    } catch {
      url = undefined;
    }
    return { hint, rank: url ? fileHintRank(url) : 1 };
  });
  const muxed = scored.filter((entry) => entry.rank === 0);
  const chosen = muxed.length > 0 ? muxed : scored;
  const seen = new Set<string>();
  const result: PageMediaHint[] = [];
  for (const entry of chosen) {
    if (seen.has(entry.hint.url)) continue;
    seen.add(entry.hint.url);
    result.push(entry.hint);
    if (result.length >= limit) break;
  }
  return result;
}

/** Container demuxer/extension for a whole-file hint. */
export function fileIdentity(url: URL): { extension: string; demuxer: string } {
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url.pathname);
  const extension = (match?.[1] ?? "mp4").toLowerCase();
  if (extension === "webm" || extension === "mkv") return { extension, demuxer: extension };
  if (extension === "mp3" || extension === "m4a" || extension === "ogg" || extension === "opus") {
    return { extension: extension === "opus" ? "ogg" : extension, demuxer: extension === "opus" ? "ogg" : extension };
  }
  return { extension: "mp4", demuxer: "mp4" };
}
