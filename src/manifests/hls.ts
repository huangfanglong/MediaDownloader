/**
 * Minimal, original HLS parser for the rebuild.
 *
 * Evidence: analysis/evidence/03-manifest-resolution.md
 *  - F8/F9/F11: playlists are validated by a segment-list (media) or variant-list (master) shape;
 *    `"parse error"` / `"not a valid m3u8"` are the two shipped failure strings (svc:8582-8591).
 *  - F10: subtitle-only rejection — a media playlist whose segment URIs all end in
 *    vtt|srt|webvtt|ttml is a subtitle playlist (svc:8592-8607).
 *  - F11: duration = "unknown" on any non-numeric segment duration; "live" when the last
 *    PROGRAM-DATE-TIME is within 600 s; else the numeric sum. #EXT-X-ENDLIST is NOT consulted.
 *  - F12: master variant filter — CODECS absent => demuxer mp4; CODECS present but not in the
 *    video codec table => variant skipped; VIDEO-RANGE=PQ skipped; unresolvable URI skipped.
 *  - F13/F16: EXT-X-MEDIA audio / subtitle renditions.
 *  - F14: variant ordering = height desc, then bandwidth desc (svc:7389-7424).
 *  - F15: user quality maps to a height; entry 0 when absent (svc:7401-7413).
 *  - F17: EXT-X-MAP / EXT-X-BYTERANGE / EXT-X-KEY semantics consumed by the download worker
 *    (wrk:4115-4160).
 *
 * Deliberately minimal: no segment-template expansion (HLS has none), no I-frame playlists,
 * no date-range streams, no variable substitution. Attribute parsing follows RFC 8216
 * (quoted values may contain commas; no escape sequences) — enough for the proven semantics.
 */
import type { MediaDuration } from "../core/types.js";

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

/** Tagged encryption key (#EXT-X-KEY / #EXT-X-SESSION-KEY). */
export interface HlsKey {
  method: string;
  uri?: URL;
  /** IV exactly as written, including the `0x` prefix. */
  iv?: string;
  /** KEYFORMAT attribute when present (e.g. `identity`, Widevine URN). */
  keyFormat?: string;
}

export interface HlsByteRange {
  offset: number;
  length: number;
}

export interface HlsMap {
  uri: URL;
  byterange?: HlsByteRange;
  /** Key active when the map was declared (init segment encryption). */
  key?: HlsKey;
}

export interface HlsSegment {
  /** Absolute segment URI (resolved against the playlist URL). */
  uri: URL;
  /** #EXTINF duration in seconds; undefined when the tag was missing/unparsable. */
  duration?: number;
  map?: HlsMap;
  byterange?: HlsByteRange;
  key?: HlsKey;
  /** #EXT-X-PROGRAM-DATE-TIME as epoch milliseconds. */
  programDateTime?: number;
  discontinuity?: boolean;
}

/** An EXT-X-MEDIA rendition of an audio group. */
export interface HlsAudioRendition {
  group: string;
  name: string;
  language?: string;
  default: boolean;
  uri?: URL;
}

/** An EXT-X-MEDIA subtitle / closed-caption rendition. */
export interface HlsSubtitleRendition {
  group: string;
  name: string;
  language?: string;
  url?: URL;
  kind: "subtitles" | "closed-captions";
}

export interface HlsVariant {
  uri: URL;
  bandwidth?: number;
  codecs?: string;
  resolution?: { width: number; height: number };
  audioGroup?: string;
  videoRange?: string;
  /** Resolved container demuxer (mp4/webm/mkv/...). Set by the parser filter. */
  demuxer?: string;
  /** Parsed but unused by selection (shipped code reads FRAME-RATE and discards it — F12). */
  frameRate?: number;
}

export type HlsResult =
  | {
      kind: "master";
      variants: HlsVariant[];
      /**
       * Extension beyond the frozen contract: needed to consume EXT-X-MEDIA audio groups
       * (F13/F16). Extra fields do not affect consumers that only read `variants`.
       */
      audioRenditions: HlsAudioRendition[];
      subtitleRenditions: HlsSubtitleRendition[];
    }
  | {
      kind: "media";
      segments: HlsSegment[];
      duration: MediaDuration;
      hasDrm: boolean;
      mediaSequence: number;
    }
  | { kind: "subtitle"; segments: HlsSegment[] }
  | { kind: "invalid"; reason: "parse error" | "not a valid m3u8" };

/** Remove low-latency playlist refresh params so repeated refreshes share one identity. */
export function canonicalHlsManifestUrl(url: URL): URL {
  const copy = new URL(url.href);
  for (const key of ["_HLS_msn", "_HLS_part", "_HLS_skip"]) copy.searchParams.delete(key);
  return copy;
}

/** Defense-in-depth limits from adversarial review 3.1 (hostile manifests must not DoS us). */
export const MAX_HLS_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_HLS_LINES = 200_000;
export const MAX_HLS_SEGMENTS = 50_000;
export const MAX_HLS_VARIANTS = 2_000;
export const MAX_URL_LENGTH = 8_192;

/** Error strings are part of the recovered contract (F9). */
export const HLS_PARSE_ERROR = "parse error";
export const HLS_NOT_VALID = "not a valid m3u8";
/** Subtitle-only rejection marker (F10); exported for discovery/UI messaging parity. */
export const HLS_SUBTITLE_PLAYLIST = "subtitle playlist";

/** Window that classifies a playlist as live from its last PROGRAM-DATE-TIME (F11). */
export const LIVE_WINDOW_MS = 600_000;

/** Demuxer priority order for user-quality entry selection (F15). */
export const DEMUXER_ORDER = ["mp4", "webm", "mkv", "mp3", "m4a", "ogg"] as const;

// ---------------------------------------------------------------------------
// Attribute / tag helpers
// ---------------------------------------------------------------------------

/** Parse an RFC 8216 attribute list (`KEY=VALUE,KEY="quoted,value"`). */
export function parseAttributes(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  let index = 0;
  while (index < input.length) {
    while (index < input.length && (input[index] === "," || input[index] === " ")) index += 1;
    if (index >= input.length) break;
    let keyEnd = index;
    while (keyEnd < input.length && input[keyEnd] !== "=") keyEnd += 1;
    if (keyEnd >= input.length) break;
    const key = input.slice(index, keyEnd).trim();
    index = keyEnd + 1;
    let value = "";
    if (input[index] === '"') {
      index += 1;
      const quoteEnd = input.indexOf('"', index);
      const end = quoteEnd === -1 ? input.length : quoteEnd;
      value = input.slice(index, end);
      index = end + 1;
    } else {
      let valueEnd = index;
      while (valueEnd < input.length && input[valueEnd] !== ",") valueEnd += 1;
      value = input.slice(index, valueEnd).trim();
      index = valueEnd;
    }
    if (key.length > 0) result[key] = value;
  }
  return result;
}

function resolveUrl(reference: string, base: URL): URL | undefined {
  if (!reference) return undefined;
  try {
    return new URL(reference, base);
  } catch {
    return undefined;
  }
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Video codec table (`Zn`, svc:7290-7307). First match wins; unrecognised => undefined. */
export function videoDemuxerForCodecs(codecs: string): string | undefined {
  if (/(avc1|avc3).*/i.test(codecs)) return "mp4";
  if (/(hvc1|hev1|hevc|h265|h\.265).*/i.test(codecs)) return "mp4";
  if (/mp4v\.20.*/i.test(codecs)) return "mp4";
  if (/av0?1.*/i.test(codecs)) return "webm";
  if (/vp0?8.*/i.test(codecs)) return "webm";
  if (/vp0?9.*/i.test(codecs)) return "webm";
  return undefined;
}

const SUBTITLE_EXTENSION = /vtt|srt|webvtt|ttml/;
/** Widevine KEYFORMAT URN the shipped parser accepts. */
const WIDEVINE_KEYFORMAT_URN = "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
/**
 * DRM KEYFORMATs the shipped parser records under `manifest.contentProtection` keys that its DRM
 * predicate (`kv`) then honours: `com.microsoft.playready` and `com.widevine.alpha`.
 *
 * FairPlay (`com.apple.streamingkeydelivery`) is deliberately NOT treated as DRM here: the shipped
 * parser stores it as `com.apple.fps.1_0`, which is absent from its DRM set, so it proceeds as a
 * normal (undecryptable) key rather than blocking the download. We mirror the predicate and refuse
 * the transfer explicitly in the worker instead of saving ciphertext.
 */
const DRM_KEY_FORMATS = new Set(["com.microsoft.playready", "com.widevine.alpha"]);
const DRM_SESSION_DATA = /widevine|playready/i;

/** Is this segment URI a subtitle resource? Mirrors `ro`'s extension test (F10). */
export function isSubtitleUri(uri: URL): boolean {
  const path = uri.pathname;
  const dot = path.lastIndexOf(".");
  const extension = (dot === -1 ? path : path.substring(dot + 1)).toLowerCase();
  return SUBTITLE_EXTENSION.test(extension);
}

/** #EXT-X-BYTERANGE value `length[@offset]`. */
function parseByteRange(value: string, lastEnd: number): HlsByteRange | undefined {
  const [lengthPart, offsetPart] = value.split("@");
  const length = parseInteger(lengthPart?.trim());
  if (length === undefined) return undefined;
  const offset = offsetPart === undefined ? lastEnd : parseInteger(offsetPart.trim());
  if (offset === undefined) return undefined;
  return { offset, length };
}

function parseKey(attributes: Record<string, string>, base: URL): HlsKey | undefined {
  const method = attributes.METHOD;
  if (!method) return undefined;
  if (method === "NONE") return undefined;
  const uri = attributes.URI === undefined ? undefined : resolveUrl(attributes.URI, base);
  return {
    method,
    ...(uri === undefined ? {} : { uri }),
    ...(attributes.IV === undefined ? {} : { iv: attributes.IV }),
    ...(attributes.KEYFORMAT === undefined ? {} : { keyFormat: attributes.KEYFORMAT }),
  };
}

/** Does a key declare one of the DRM key formats the shipped code treats as DRM? (F37/F45) */
function keyIsDrm(key: HlsKey): boolean {
  const format = key.keyFormat;
  if (format === undefined) return false;
  if (format === "com.apple.streamingkeydelivery") return false;
  if (format === WIDEVINE_KEYFORMAT_URN) return true;
  return DRM_KEY_FORMATS.has(format);
}

// ---------------------------------------------------------------------------
// Duration / live classification (`io` + `Ev`, F11)
// ---------------------------------------------------------------------------

/**
 * Report a duration exactly like the shipped `io`:
 * - any missing/non-numeric segment duration => "unknown"
 * - last segment PROGRAM-DATE-TIME newer than `now - 600 s` => "live"
 * - otherwise the numeric sum of segment durations.
 * #EXT-X-ENDLIST is deliberately not consulted (proven code behaviour).
 */
export function durationOf(segments: readonly HlsSegment[], now: number): MediaDuration {
  if (segments.length === 0) return "unknown";
  if (segments.some((segment) => typeof segment.duration !== "number")) return "unknown";
  const last = segments[segments.length - 1];
  if (last !== undefined && last.programDateTime !== undefined && last.programDateTime > now - LIVE_WINDOW_MS) {
    return "live";
  }
  return segments.reduce((total, segment) => total + (segment.duration ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Master playlist helpers (`Lm`, F12-F16)
// ---------------------------------------------------------------------------

/** Sort variants: resolution height descending, then bandwidth descending. Stable. */
export function sortVariants<T extends HlsVariant>(variants: readonly T[]): T[] {
  return [...variants].sort((left, right) => {
    const leftHeight = left.resolution?.height ?? 0;
    const rightHeight = right.resolution?.height ?? 0;
    if (leftHeight !== rightHeight) return rightHeight - leftHeight;
    const leftBandwidth = left.bandwidth ?? 0;
    const rightBandwidth = right.bandwidth ?? 0;
    if (leftBandwidth !== rightBandwidth) return rightBandwidth - leftBandwidth;
    return 0;
  });
}

/** Preview rendition: height 480, else 260, else the last (lowest) variant (F15 `Qn`). */
export function defaultPreviewVariant<T extends HlsVariant>(variants: readonly T[]): T | undefined {
  if (variants.length === 0) return undefined;
  const at480 = variants.find((variant) => variant.resolution?.height === 480);
  if (at480 !== undefined) return at480;
  const at260 = variants.find((variant) => variant.resolution?.height === 260);
  if (at260 !== undefined) return at260;
  return variants[variants.length - 1];
}

/**
 * User quality (height) => variant selection (F15). When a height is given, demuxers are tried
 * in `DEMUXER_ORDER` and the first variant of that demuxer at that exact height wins; if nothing
 * matches, the first variant (index 0) is returned, mirroring `Kn`.
 */
export function selectVariant<T extends HlsVariant>(
  variants: readonly T[],
  preferredHeight?: number,
): T | undefined {
  if (preferredHeight !== undefined) {
    for (const demuxer of DEMUXER_ORDER) {
      for (const variant of variants) {
        if (variant.demuxer === demuxer && variant.resolution?.height === preferredHeight) return variant;
      }
    }
  }
  return variants[0];
}

export interface HlsAudioSelectionOptions {
  strategy: "original" | "user_language";
  languages: ReadonlySet<string> | readonly string[];
}

function languageList(languages: HlsAudioSelectionOptions["languages"]): string[] {
  return Array.isArray(languages) ? [...languages] : [...(languages as ReadonlySet<string>)];
}

/**
 * Audio rendition choice (F13). `user_language` tries exact language matches in preference
 * order, then base-language matches; on no match it falls back to the default rendition. The
 * `original` strategy reproduces `Lm`'s loop: remember each rendition with a URI, stop at the
 * first `DEFAULT=YES` (so a group with no default resolves to its last rendition).
 */
export function selectAudioRendition(
  renditions: readonly HlsAudioRendition[],
  options: HlsAudioSelectionOptions,
): HlsAudioRendition | undefined {
  if (options.strategy === "user_language") {
    const languages = languageList(options.languages);
    for (const language of languages) {
      const exact = renditions.find((rendition) => rendition.language === language);
      if (exact !== undefined) return exact;
    }
    for (const language of languages) {
      const base = language.split("-")[0];
      if (base === undefined || base === "") continue;
      const partial = renditions.find(
        (rendition) => rendition.language !== undefined && rendition.language.split("-")[0] === base,
      );
      if (partial !== undefined) return partial;
    }
    return renditions.find((rendition) => rendition.default);
  }
  let picked: HlsAudioRendition | undefined;
  for (const rendition of renditions) {
    if (rendition.uri !== undefined) picked = rendition;
    if (rendition.default) break;
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface PendingVariant {
  bandwidth?: number;
  codecs?: string;
  resolution?: { width: number; height: number };
  audioGroup?: string;
  videoRange?: string;
  frameRate?: number;
}

/**
 * Parse an HLS playlist.
 *
 * Master playlists (`#EXT-X-STREAM-INF` present) return filtered, ordered variants plus the
 * EXT-X-MEDIA renditions. Media playlists return segments (and subtitle-only playlists are
 * separated as `kind:"subtitle"`, F10). Never throws: malformed input maps to `invalid`.
 */
/** Some hosts serve each manifest character as a decimal line (e.g. `35` = `#`). */
export function decodeCharacterCodedManifest(text: string): string {
  const lines = text.replace(/\r/gu, "").split("\n");
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length < 4) return text;
  if (!nonEmpty.every((line) => /^\d{1,3}$/u.test(line.trim()))) return text;
  let decoded = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      decoded += "\n";
      continue;
    }
    const code = Number(trimmed);
    if (!Number.isInteger(code) || code < 0 || code > 255) return text;
    decoded += String.fromCharCode(code);
  }
  return decoded.startsWith("#EXTM3U") ? decoded : text;
}

export function parsePlaylist(text: string, baseUrl: URL): HlsResult {
  if (typeof text !== "string" || text.length === 0) return { kind: "invalid", reason: HLS_PARSE_ERROR };
  if (text.length > MAX_HLS_MANIFEST_BYTES) return { kind: "invalid", reason: HLS_PARSE_ERROR };
  const decoded = decodeCharacterCodedManifest(text);
  const normalized = decoded.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines.length > MAX_HLS_LINES) return { kind: "invalid", reason: HLS_PARSE_ERROR };
  const firstLine = lines.find((line) => line.trim().length > 0);
  if (firstLine === undefined || !firstLine.trim().startsWith("#EXTM3U")) {
    return { kind: "invalid", reason: HLS_PARSE_ERROR };
  }

  let sawStreamInf = false;
  let pendingVariant: PendingVariant | undefined;
  let pendingDuration: number | undefined;
  let pendingByteRange: HlsByteRange | undefined;
  let pendingDiscontinuity = false;
  let pendingProgramDateTime: number | undefined;
  let currentKey: HlsKey | undefined;
  let currentMap: HlsMap | undefined;
  let lastByteRangeEnd = 0;
  let mediaSequence = 0;
  const contentProtection = new Set<string>();
  const variants: HlsVariant[] = [];
  const audioRenditions: HlsAudioRendition[] = [];
  const subtitleRenditions: HlsSubtitleRendition[] = [];
  const segments: HlsSegment[] = [];
  const overLimit = (): boolean =>
    segments.length >= MAX_HLS_SEGMENTS ||
    variants.length >= MAX_HLS_VARIANTS ||
    subtitleRenditions.length >= MAX_HLS_VARIANTS ||
    audioRenditions.length >= MAX_HLS_VARIANTS;

  const noteDrm = (key: HlsKey): void => {
    if (keyIsDrm(key)) contentProtection.add(key.keyFormat ?? "unknown-drm");
  };

  for (const rawLine of lines) {
    if (overLimit()) break;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF")) continue; // I-frame playlists are separate (F12)
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      const width = parseInteger(attributes.RESOLUTION?.split("x")[0]);
      const height = parseInteger(attributes.RESOLUTION?.split("x")[1]);
      pendingVariant = {
        ...(parseInteger(attributes.BANDWIDTH) === undefined ? {} : { bandwidth: parseInteger(attributes.BANDWIDTH) }),
        ...(attributes.CODECS === undefined ? {} : { codecs: attributes.CODECS }),
        ...(width === undefined || height === undefined ? {} : { resolution: { width, height } }),
        ...(attributes.AUDIO === undefined ? {} : { audioGroup: attributes.AUDIO }),
        ...(attributes["VIDEO-RANGE"] === undefined ? {} : { videoRange: attributes["VIDEO-RANGE"] }),
        ...(parseNumber(attributes["FRAME-RATE"]) === undefined
          ? {}
          : { frameRate: parseNumber(attributes["FRAME-RATE"]) }),
      };
      sawStreamInf = true;
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      const group = attributes["GROUP-ID"] ?? "";
      const name = attributes.NAME ?? "";
      const language = attributes.LANGUAGE;
      const uri = attributes.URI === undefined ? undefined : resolveUrl(attributes.URI, baseUrl);
      const type = attributes.TYPE ?? "";
      if (type === "AUDIO") {
        audioRenditions.push({
          group,
          name,
          default: attributes.DEFAULT === "YES",
          ...(language === undefined ? {} : { language }),
          ...(uri === undefined ? {} : { uri }),
        });
      } else if (type === "SUBTITLES" || type === "CLOSED-CAPTIONS") {
        subtitleRenditions.push({
          group,
          name,
          kind: type === "SUBTITLES" ? "subtitles" : "closed-captions",
          ...(language === undefined ? {} : { language }),
          ...(uri === undefined ? {} : { url: uri }),
        });
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const sequence = parseInteger(line.slice("#EXT-X-MEDIA-SEQUENCE:".length));
      if (sequence !== undefined) mediaSequence = sequence;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      const value = line.slice("#EXTINF:".length).split(",")[0] ?? "";
      pendingDuration = parseNumber(value.trim());
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingByteRange = parseByteRange(line.slice("#EXT-X-BYTERANGE:".length).trim(), lastByteRangeEnd);
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-MAP:".length));
      const uri = attributes.URI === undefined ? undefined : resolveUrl(attributes.URI, baseUrl);
      if (uri === undefined) return { kind: "invalid", reason: HLS_PARSE_ERROR };
      const range = attributes.BYTERANGE === undefined ? undefined : parseByteRange(attributes.BYTERANGE, 0);
      currentMap = {
        uri,
        ...(range === undefined ? {} : { byterange: range }),
        ...(currentKey === undefined ? {} : { key: currentKey }),
      };
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const key = parseKey(parseAttributes(line.slice("#EXT-X-KEY:".length)), baseUrl);
      currentKey = key;
      if (key !== undefined) noteDrm(key);
      continue;
    }
    if (line.startsWith("#EXT-X-SESSION-KEY:")) {
      const key = parseKey(parseAttributes(line.slice("#EXT-X-SESSION-KEY:".length)), baseUrl);
      if (key !== undefined) noteDrm(key);
      continue;
    }
    if (line.startsWith("#EXT-X-SESSION-DATA:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-SESSION-DATA:".length));
      const id = attributes["DATA-ID"] ?? "";
      if (DRM_SESSION_DATA.test(id)) contentProtection.add(id);
      continue;
    }
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const timestamp = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length).trim());
      pendingProgramDateTime = Number.isNaN(timestamp) ? undefined : timestamp;
      continue;
    }
    if (line.startsWith("#EXT-X-DISCONTINUITY")) {
      pendingDiscontinuity = true;
      continue;
    }
    if (line.startsWith("#")) continue; // other tags are not needed by the proven semantics

    // Non-tag line: either the URI of the pending #EXT-X-STREAM-INF variant, or a segment URI.
    if (pendingVariant !== undefined) {
      const variantUri = resolveUrl(line, baseUrl);
      if (variantUri !== undefined) {
        // F12: no CODECS => mp4; unreadable video codec => skip; VIDEO-RANGE=PQ => skip.
        const demuxer =
          pendingVariant.codecs === undefined ? "mp4" : videoDemuxerForCodecs(pendingVariant.codecs);
        if (demuxer !== undefined && pendingVariant.videoRange !== "PQ") {
          variants.push({ uri: variantUri, demuxer, ...pendingVariant });
        }
      }
      pendingVariant = undefined;
      continue;
    }

    const segmentUri = resolveUrl(line, baseUrl);
    if (segmentUri === undefined) return { kind: "invalid", reason: HLS_PARSE_ERROR };
    segments.push({
      uri: segmentUri,
      ...(pendingDuration === undefined ? {} : { duration: pendingDuration }),
      ...(currentMap === undefined ? {} : { map: currentMap }),
      ...(pendingByteRange === undefined ? {} : { byterange: pendingByteRange }),
      ...(currentKey === undefined ? {} : { key: currentKey }),
      ...(pendingProgramDateTime === undefined ? {} : { programDateTime: pendingProgramDateTime }),
      ...(pendingDiscontinuity ? { discontinuity: true } : {}),
    });
    if (pendingByteRange !== undefined) lastByteRangeEnd = pendingByteRange.offset + pendingByteRange.length;
    pendingDuration = undefined;
    pendingByteRange = undefined;
    pendingDiscontinuity = false;
    pendingProgramDateTime = undefined;
  }

  if (sawStreamInf) {
    // `Lm` returns "Empty playlist" when every variant was filtered out; the frozen HlsResult
    // union has no such reason, so the closest contract value is used (documented deviation).
    const shortUrl = (value: string): boolean => value.length <= MAX_URL_LENGTH;
    if (variants.length === 0) return { kind: "invalid", reason: HLS_NOT_VALID };
    return {
      kind: "master",
      variants: sortVariants(variants).filter((variant) => shortUrl(variant.uri.href)),
      audioRenditions: audioRenditions.filter((rendition) => rendition.uri === undefined || shortUrl(rendition.uri.href)),
      subtitleRenditions: subtitleRenditions.filter((rendition) => rendition.url === undefined || shortUrl(rendition.url.href)),
    };
  }
  if (segments.length === 0) return { kind: "invalid", reason: HLS_NOT_VALID };
  // F10: all segment URIs subtitle resources => subtitle playlist.
  if (segments.every((segment) => isSubtitleUri(segment.uri))) return { kind: "subtitle", segments };
  return {
    kind: "media",
    segments: segments.filter((segment) => segment.uri.href.length <= MAX_URL_LENGTH),
    duration: durationOf(segments, Date.now()),
    hasDrm: contentProtection.size > 0,
    mediaSequence,
  };
}
