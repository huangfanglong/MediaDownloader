/**
 * Detection-parity fixtures.
 *
 * Every table/constant below is asserted against the rebuilt modules in `test/discovery.test.ts`. 
 * References are to analysis/evidence/02-detection-pipeline.md` (claim D-numbers + original byte offsets).
 *
 * Rule: tests may quote *values* as facts; implementation code is written fresh.
 */

import type {
  BehaviourGate,
  ResponseStartedEvent,
  SendHeadersEvent,
} from "../../src/discovery/engine.js";
import type { BehaviourFlag } from "../../src/settings/flags.js";

// ---------------------------------------------------------------------------
// Verbatim tables
// ---------------------------------------------------------------------------

/** D18 (Nm/Rm/Ms; original bytes 149,567 / 149,591 / 149,614). */
export const FIXTURE_VIDEO_EXTENSIONS = ["mp4", "webm", "mkv"] as const;
export const FIXTURE_AUDIO_EXTENSIONS = ["mp3", "m4a", "ogg"] as const;
export const FIXTURE_MEDIA_EXTENSIONS = [
  "mp4",
  "webm",
  "mkv",
  "mp3",
  "m4a",
  "ogg",
] as const;

/** D19 (`bv`, 53 entries; original byte 151,589). */
export const FIXTURE_KNOWN_MEDIA_FILE_EXTENSIONS = [
  "3g2",
  "3gp",
  "aac",
  "ac3",
  "aiff",
  "amr",
  "ape",
  "asf",
  "au",
  "avi",
  "divx",
  "dts",
  "dv",
  "f4v",
  "flac",
  "flv",
  "h264",
  "m2t",
  "m2ts",
  "m2v",
  "m4a",
  "m4v",
  "mka",
  "mkv",
  "mov",
  "mp2",
  "mp3",
  "mp4",
  "mpe",
  "mpeg",
  "mpg",
  "mpv",
  "mts",
  "mxf",
  "oga",
  "ogg",
  "ogm",
  "ogv",
  "opus",
  "qt",
  "ra",
  "rm",
  "rmvb",
  "snd",
  "ts",
  "vob",
  "voc",
  "wav",
  "webm",
  "wma",
  "wmv",
  "wv",
  "y4m",
] as const;

/** One MIME → demuxer row, pre-flattened for `toEqual` assertions (D20, original byte 150,766). */
export interface MimeDemuxerRowFixture {
  source: string;
  flags: string;
  audio: string;
  video: string;
}

/** D20 (`jm`, 17 rows; original byte 150,766). */
export const FIXTURE_MIME_DEMUXER_ROWS: readonly MimeDemuxerRowFixture[] = [
  { source: "(?:x-)?(?:pn-)?wave?", flags: "i", audio: "wav", video: "wav" },
  { source: "(?:x-)?3gpp2?", flags: "i", audio: "mp3", video: "3gpp" },
  { source: "(?:x-)?flac", flags: "i", audio: "flac", video: "flac" },
  { source: "(?:x-)?flv", flags: "i", audio: "mp3", video: "flv" },
  { source: "(?:x-)?m4a", flags: "i", audio: "m4a", video: "m4a" },
  { source: "(?:x-)?m4v", flags: "i", audio: "mp3", video: "m4v" },
  { source: "(?:x-)?matroska", flags: "i", audio: "mp3", video: "mkv" },
  { source: "(?:x-)?mov", flags: "i", audio: "mp3", video: "mov" },
  { source: "(?:x-)?mp2t", flags: "i", audio: "mp3", video: "mp2t" },
  { source: "(?:x-)?mp4", flags: "i", audio: "mp3", video: "mp4" },
  { source: "(?:x-)?mpeg", flags: "i", audio: "mp3", video: "mpeg" },
  { source: "(?:x-)?mts", flags: "i", audio: "mp3", video: "mt2s" },
  { source: "(?:x-)?msvideo", flags: "i", audio: "avi", video: "avi" },
  { source: "(?:x-)?og.", flags: "i", audio: "oga", video: "ogv" },
  { source: "(?:x-)?webm", flags: "i", audio: "oga", video: "webm" },
  { source: "(?:x-)?mkv", flags: "i", audio: "mp3", video: "mkv" },
  { source: "(?:x-)?vorbis", flags: "i", audio: "oga", video: "ogv" },
];

/** One codec → demuxer row, pre-flattened for `toEqual` assertions. */
export interface CodecDemuxerRowFixture {
  source: string;
  flags: string;
  demuxer: string;
  codec: string;
}

/** D21 video rows (`gv`, original byte 150,026). */
export const FIXTURE_VIDEO_CODEC_ROWS: readonly CodecDemuxerRowFixture[] = [
  { source: "(avc1|avc3).*", flags: "i", demuxer: "mp4", codec: "H264" },
  {
    source: "(hvc1|hev1|hevc|h265|h\\.265).*",
    flags: "i",
    demuxer: "mp4",
    codec: "H265",
  },
  { source: "mp4v\\.20.*", flags: "i", demuxer: "mp4", codec: "MP4V" },
  { source: "av0?1.*", flags: "i", demuxer: "webm", codec: "AV1" },
  { source: "vp0?8.*", flags: "i", demuxer: "webm", codec: "VP8" },
  { source: "vp0?9.*", flags: "i", demuxer: "webm", codec: "VP9" },
];

/** D21 audio rows (`hv`, original byte 150,357). */
export const FIXTURE_AUDIO_CODEC_ROWS: readonly CodecDemuxerRowFixture[] = [
  { source: "(aac|mp4a.40).*", flags: "i", demuxer: "m4a", codec: "AAC" },
  {
    source: "(\\.?mp3|mp4a\\.69|mp4a\\.6b).*",
    flags: "i",
    demuxer: "mp3",
    codec: "MP3",
  },
  { source: "(opus|(mp4a\\.ad.*))", flags: "i", demuxer: "ogg", codec: "Opus" },
  { source: "vorbis", flags: "i", demuxer: "ogg", codec: "Vorbis" },
];

/** D25 (`PS`, 11 entries; original byte 237,954). */
export const FIXTURE_BLOCKED_INITIATOR_HOSTS = [
  "youtube.com",
  "instagram.com",
  "ok.ru",
  "vk.com",
  "vk.ru",
  "vkvideo.ru",
  "canva.com",
  "iq.com",
  "vimeo.com",
  "kick.com",
  "javrank.com",
] as const;

// ---------------------------------------------------------------------------
// Verbatim constants
// ---------------------------------------------------------------------------

/** D6/D17/D30; original bytes 244,147 / 241,327 / 241,435. */
export const FIXTURE_SEND_HEADERS_TTL_MS = 600_000;
export const FIXTURE_SMALL_FILE_THRESHOLD_BYTES = 500_000;
export const FIXTURE_INITIATOR_SUPPRESSION_THRESHOLD_BYTES = 20_000_000;
export const FIXTURE_SAME_TYPE_ITEM_CAP = 10;
export const FIXTURE_FIFO_DISCOVERED_ITEM_CAP = 30;

/** Regexes that drive dispatch/rejection, as [source, flags] pairs (D9/D10). */
export const FIXTURE_REGEXES = {
  segmentPath: ["\\.ts$|\\.m4s$|\\.m2ts$|(?:_part\\d+|_init_[A-Za-z0-9_-]+)\\.(?:mp4|m4s|ts)$", "i"],
  hlsContentType: ["mpegurl", "i"],
  hlsUrl: ["\\.m3u8(?:$|[?#])", "i"],
  hlsMasterApi: ["\\/api\\/playlist\\/master\\/", ""],
  dashContentType: ["dash", "i"],
  dashUrl: ["\\.mpd", "i"],
  mpdConversion: ["\\.mpd", "i"],
  extensionInitiator: ["^(moz|chrome)-extension", ""],
} as const;

/** D27 (be = cyrb53), values computed by running the recovered algorithm (Node). */
export const FIXTURE_HASHES: ReadonlyArray<{
  input: string;
  seed?: number;
  expected: number;
}> = [
  { input: "", expected: 3338908027751811 },
  { input: "hello", expected: 4625896200565286 },
  { input: "https://example.com/a.mp4", expected: 8135403097150076 },
  { input: "https://example.com/a.mp4", seed: 7, expected: 604828098449536 },
  {
    input:
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720\n720.m3u8",
    expected: 5958122816181801,
  },
];

// ---------------------------------------------------------------------------
// Decision-table inputs
// ---------------------------------------------------------------------------

export interface HeaderFixture {
  name: string;
  value: string;
}

export function headerList(record: Record<string, string>): HeaderFixture[] {
  return Object.entries(record).map(([name, value]) => ({ name, value }));
}

const DEFAULT_SEND_HEADERS: SendHeadersEvent = {
  requestId: "req-1",
  url: "https://cdn.example.com/media/video.mp4",
  tabId: 1,
  frameId: 0,
  type: "media",
  initiator: "https://site.example/watch",
  timeStamp: 1_000_000,
  requestHeaders: [
    { name: "referer", value: "https://site.example/watch" },
    { name: "cookie", value: "a=b" },
  ],
};

export function makeSendHeadersEvent(
  overrides: Partial<SendHeadersEvent> = {},
): SendHeadersEvent {
  return { ...DEFAULT_SEND_HEADERS, ...overrides };
}

const DEFAULT_RESPONSE: ResponseStartedEvent = {
  requestId: "req-1",
  url: "https://cdn.example.com/media/video.mp4",
  tabId: 1,
  frameId: 0,
  type: "media",
  initiator: "https://site.example/watch",
  statusCode: 200,
  timeStamp: 1_000_100,
  responseHeaders: [
    { name: "content-type", value: "video/mp4" },
    { name: "content-length", value: "2000000" },
  ],
};

export function makeResponseStartedEvent(
  overrides: Partial<ResponseStartedEvent> = {},
): ResponseStartedEvent {
  return { ...DEFAULT_RESPONSE, ...overrides };
}

// ---------------------------------------------------------------------------
// Behaviour-gate doubles
// ---------------------------------------------------------------------------

export interface RecordingGate extends BehaviourGate {
  calls: Array<{ flag: BehaviourFlag; host: string }>;
}

/** Gate with a fixed set of enabled flags (host-independent) that records every lookup. */
export function createGate(
  enabled: readonly BehaviourFlag[] = [],
): RecordingGate {
  const enabledSet = new Set<BehaviourFlag>(enabled);
  const calls: RecordingGate["calls"] = [];
  return {
    calls,
    enabled(flag, host) {
      calls.push({ flag, host });
      return enabledSet.has(flag);
    },
  };
}

/**
 * Gate enabled per host (exact string match, like the original's `domain_hash` lookup):
 * `{ FIFO_DISCOVERED_WEBSITES: ["fifo.example"] }`.
 */
export function createHostGate(
  hosts: Partial<Record<BehaviourFlag, readonly string[]>>,
): RecordingGate {
  const calls: RecordingGate["calls"] = [];
  return {
    calls,
    enabled(flag, host) {
      calls.push({ flag, host });
      return hosts[flag]?.includes(host) ?? false;
    },
  };
}

/** Deterministic clock for `discovery_timestamp_ms` assertions. */
export function fixedNow(value = 1_000_000): () => number {
  return () => value;
}

// ---------------------------------------------------------------------------
// `$S` descriptor resolution fixtures (D22)
// ---------------------------------------------------------------------------

export interface DescriptorFixture {
  name: string;
  contentDisposition?: string;
  contentType?: string;
  url: string;
  expected: { extension: string; libavDemuxer?: string; filename?: string };
}

export const FIXTURE_DESCRIPTORS: readonly DescriptorFixture[] = [
  {
    name: "URL extension wins and a video container is normalised to the mp4 muxer",
    url: "https://cdn.example.com/videos/movie.webm",
    expected: { extension: "mkv", libavDemuxer: "webm", filename: "movie" },
  },
  {
    name: "MIME supplies the extension when the URL has none",
    url: "https://cdn.example.com/stream",
    contentType: "video/webm",
    expected: { extension: "mkv", libavDemuxer: "webm" },
  },
  {
    name: "MIME extension overrides the Content-Disposition extension, basename still from CD",
    url: "https://cdn.example.com/stream",
    contentDisposition: 'attachment; filename="clip.mkv"',
    contentType: "video/mp4",
    expected: { extension: "mp4", libavDemuxer: "mp4", filename: "clip" },
  },
  {
    name: "RFC 5987 filename* is percent-decoded; a muxable audio container yields libav_demuxer",
    url: "https://cdn.example.com/stream",
    contentDisposition: "attachment; filename*=UTF-8''a%20b.mp3",
    expected: { extension: "mp3", libavDemuxer: "mp3", filename: "a b" },
  },
  {
    name: "Content-Disposition basename wins because it is the last valid candidate",
    url: "https://cdn.example.com/path/from-url.mp4",
    contentDisposition: 'attachment; filename="from-header.webm"',
    expected: {
      extension: "mkv",
      libavDemuxer: "webm",
      filename: "from-header",
    },
  },
  {
    name: "Unparseable/unknown extension falls back to mp4 with no libav demuxer",
    url: "https://cdn.example.com/download?id=7",
    contentType: "application/octet-stream",
    expected: { extension: "mp4" },
  },
];
