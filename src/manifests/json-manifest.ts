/**
 * JSON media manifests: DASH-in-JSON documents (the `master.json` class).
 *
 * Players that describe their streams in a JSON document expose no `.m3u8`/`.mpd` URL for the
 * network layer to classify — the manifest arrives as an XHR with a `application/json` content
 * type. Recognition is by content shape, not by one site's schema: a JSON object carrying a
 * segment list (`segments`/`segment_urls`/`fragments`/`segment_list` arrays of URL entries) plus
 * media evidence (a video/audio mime type, an init-segment URL, or media-extension segment URLs)
 * is a media manifest. The selected track is mapped onto the HLS media-playlist shape so the
 * existing transfer path (init section, ordered segment fetch, fMP4 assembly) works unchanged.
 *
 * Defense-in-depth mirrors the HLS parser: bounded walk, bounded segment count, bounded URL
 * length. DRM is reported structurally (these manifests carry no `EXT-X-KEY`), so consumers must
 * refuse `hasDrm` themselves.
 */
import { err, ok, type Result } from "../core/option.js";
import type { MediaDuration } from "../core/types.js";
import { MAX_URL_LENGTH, type HlsSegment } from "./hls.js";

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

/** One segment of a JSON manifest track, resolved against the manifest URL. */
export interface JsonManifestSegment {
  uri: URL;
  duration?: number;
}

/** One rendition of a JSON media manifest (usually a video or audio track). */
export interface JsonManifestTrack {
  mimeType?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  /** Track-level duration in seconds when the manifest states one. */
  duration?: number;
  initSegmentUri?: URL;
  segments: JsonManifestSegment[];
}

export interface JsonMediaManifest {
  /**
   * The selected track mapped onto the HLS media-playlist shape; the init section, when present,
   * rides the standard `map` field of every segment.
   */
  playlist: {
    kind: "media";
    segments: HlsSegment[];
    duration: MediaDuration;
    hasDrm: boolean;
    mediaSequence: 0;
  };
  /** Metadata of the selected track, for playlist-entry quality display. */
  track: JsonManifestTrack;
}

export type JsonManifestParseErrorKind = "invalid_json" | "not_a_manifest" | "unsupported";

export interface JsonManifestParseError {
  kind: JsonManifestParseErrorKind;
  message: string;
}

// ---------------------------------------------------------------------------
// Recognition limits (mirrors the HLS defense-in-depth)
// ---------------------------------------------------------------------------

export const MAX_JSON_MANIFEST_SEGMENTS = 50_000;
export const MAX_JSON_MANIFEST_TRACKS = 200;
export const MAX_JSON_MANIFEST_WALK_NODES = 100_000;

/** Object keys whose array values may hold the segment list of a track. */
const SEGMENT_LIST_KEYS = ["segments", "segment_urls", "fragments", "segment_list"] as const;

/** Object keys that may hold a track's init (initialization) section URL. */
const INIT_URL_KEYS = ["init_segment_url", "initSegmentUrl", "init_url", "initUrl", "initialization"] as const;

/** Object keys that may hold DRM protection data. */
const DRM_KEYS = ["drm", "key_systems", "content_protection"] as const;

const MIME_MEDIA_PATTERN = /^(?:video|audio)\//i;
const MEDIA_EXT_PATTERN = /\.(?:mp4|m4s|m2ts|ts|webm|mkv|m4v|mov|m4a|mp3|aac|ogg|opus)$/i;

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveUrl(candidate: unknown, baseUrl: URL): URL | undefined {
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  try {
    const resolved = new URL(candidate, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
    if (resolved.href.length > MAX_URL_LENGTH) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function numberField(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Structural walk
// ---------------------------------------------------------------------------

/**
 * Segment-list parser: entries are objects with a `url`/`uri` string or plain URL strings.
 * Returns `undefined` when no entry resolved, so a non-segment array does not create a track.
 */
function parseSegmentList(
  value: unknown,
  baseUrl: URL,
  budget: { left: number },
): JsonManifestSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: JsonManifestSegment[] = [];
  for (const entry of value) {
    if (budget.left <= 0) break;
    const record = asRecord(entry);
    let uri: URL | undefined;
    let duration: number | undefined;
    if (record !== undefined) {
      uri = resolveUrl(firstDefined(record, ["url", "uri"]), baseUrl);
      duration = numberField(record, ["duration", "approx_duration", "d"]);
    } else if (typeof entry === "string") {
      uri = resolveUrl(entry, baseUrl);
    }
    if (uri === undefined) continue;
    budget.left -= 1;
    out.push({ uri, ...(duration !== undefined ? { duration } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

/** One object node as a track candidate: needs a segment list plus media evidence. */
function trackFromNode(
  record: Record<string, unknown>,
  baseUrl: URL,
  budget: { left: number },
): JsonManifestTrack | undefined {
  for (const key of SEGMENT_LIST_KEYS) {
    const segments = parseSegmentList(record[key], baseUrl, budget);
    if (segments === undefined) continue;
    const mimeType = stringField(record, ["mime_type", "mimeType"]);
    const initSegmentUri = resolveUrl(firstDefined(record, INIT_URL_KEYS), baseUrl);
    const mediaEvidence =
      (mimeType !== undefined && MIME_MEDIA_PATTERN.test(mimeType)) ||
      initSegmentUri !== undefined ||
      segments.some((segment) => MEDIA_EXT_PATTERN.test(segment.uri.pathname));
    if (!mediaEvidence) continue;
    const width = numberField(record, ["width"]);
    const height = numberField(record, ["height"]);
    const bitrate = numberField(record, ["bitrate", "bandwidth"]);
    const duration = numberField(record, ["duration", "total_duration"]);
    return {
      segments,
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(initSegmentUri !== undefined ? { initSegmentUri } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(bitrate !== undefined ? { bitrate } : {}),
      ...(duration !== undefined ? { duration } : {}),
    };
  }
  return undefined;
}

/**
 * Find every media track in an arbitrary JSON value. The walk is cycle-safe and bounded; nested
 * container objects (Vimeo's `sequences`, wrapper APIs) are traversed transparently.
 */
export function findJsonMediaTracks(value: unknown, baseUrl: URL): JsonManifestTrack[] {
  const tracks: JsonManifestTrack[] = [];
  const seen = new Set<unknown>();
  const budget = { left: MAX_JSON_MANIFEST_SEGMENTS };
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_JSON_MANIFEST_WALK_NODES && tracks.length < MAX_JSON_MANIFEST_TRACKS) {
    const node = stack.pop();
    visited += 1;
    if (typeof node !== "object" || node === null) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    const record = node as Record<string, unknown>;
    const track = trackFromNode(record, baseUrl, budget);
    if (track !== undefined) tracks.push(track);
    for (const child of Object.values(record)) stack.push(child);
  }
  return tracks;
}

/** DRM markers anywhere in the document mark the whole manifest as protected. */
function manifestHasDrm(value: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    const record = asRecord(node);
    if (record === undefined) {
      if (Array.isArray(node)) {
        for (const child of node) stack.push(child);
      }
      continue;
    }
    if (seen.has(node)) continue;
    seen.add(node);
    for (const key of DRM_KEYS) {
      const flag = record[key];
      if (flag === true) return true;
      if (Array.isArray(flag) && flag.length > 0) return true;
      if (asRecord(flag) !== undefined) return true;
      if (typeof flag === "string" && flag.length > 0) return true;
    }
    for (const child of Object.values(record)) stack.push(child);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Selection + parse
// ---------------------------------------------------------------------------

/**
 * Prefer the best video track (highest bitrate, then largest frame); fall back to any track so
 * audio-only manifests still resolve.
 */
export function selectBestVideoTrack(
  tracks: readonly JsonManifestTrack[],
): JsonManifestTrack | undefined {
  if (tracks.length === 0) return undefined;
  const isVideo = (track: JsonManifestTrack): boolean =>
    (track.mimeType !== undefined && MIME_MEDIA_PATTERN.test(track.mimeType)) ||
    (track.width !== undefined && track.height !== undefined);
  const video = tracks.filter(isVideo);
  const pool = video.length > 0 ? video : tracks;
  return [...pool].sort((left, right) => {
    const leftBitrate = left.bitrate ?? 0;
    const rightBitrate = right.bitrate ?? 0;
    if (leftBitrate !== rightBitrate) return rightBitrate - leftBitrate;
    const leftArea = (left.width ?? 0) * (left.height ?? 0);
    const rightArea = (right.width ?? 0) * (right.height ?? 0);
    return rightArea - leftArea;
  })[0];
}

/** Whether a body is JSON-shaped (an object or an array) — cheap pre-check before parsing. */
export function looksLikeJsonText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/**
 * Parse a JSON media manifest into the HLS media-playlist shape. Duration is the summed segment
 * duration when the manifest declares all of them, else the track's total, else `"unknown"`.
 */
export function parseJsonMediaManifest(
  text: string,
  baseUrl: URL,
): Result<JsonMediaManifest, JsonManifestParseError> {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return err({ kind: "invalid_json", message: "manifest is not valid JSON" });
  }
  const track = selectBestVideoTrack(findJsonMediaTracks(root, baseUrl));
  if (track === undefined) {
    return err({ kind: "not_a_manifest", message: "JSON document carries no media segment lists" });
  }
  const hasDrm = manifestHasDrm(root);
  const initMap = track.initSegmentUri === undefined ? undefined : { uri: track.initSegmentUri };
  const segments: HlsSegment[] = track.segments.map((segment) => ({
    uri: segment.uri,
    ...(segment.duration !== undefined ? { duration: segment.duration } : {}),
    ...(initMap !== undefined ? { map: initMap } : {}),
  }));
  const declared = track.segments.filter((segment) => segment.duration !== undefined);
  const duration: MediaDuration =
    track.segments.length > 0 && declared.length === track.segments.length
      ? declared.reduce((sum, segment) => sum + (segment.duration ?? 0), 0)
      : (track.duration ?? "unknown");
  return ok({
    playlist: { kind: "media", segments, duration, hasDrm, mediaSequence: 0 },
    track,
  });
}
