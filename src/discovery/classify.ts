/**
 * Classification tables and pure helpers for the discovery pipeline.
 *
 * Evidence references point at `analysis/evidence/02-detection-pipeline.md`
 * (claims D18-D22) and its Evidence index; the original byte offset is given where useful.
 * Constants are shipped as data/fixtures so the rebuilt rules stay auditable.
 */

/** Video container extensions (original `Nm`, service/main.js pretty 7263, byte 149,567). */
export const VIDEO_EXTENSIONS = ["mp4", "webm", "mkv"] as const;

/** Audio-only container extensions (original `Rm`, pretty 7264, byte 149,591). */
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "ogg"] as const;

/** Muxable containers (original `Ms = [...Nm, ...Rm]`, pretty 7265, byte 149,614). */
export const MEDIA_EXTENSIONS = [
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
] as const;

const VIDEO_EXTENSION_SET: ReadonlySet<string> = new Set(VIDEO_EXTENSIONS);
const AUDIO_EXTENSION_SET: ReadonlySet<string> = new Set(AUDIO_EXTENSIONS);
const MEDIA_EXTENSION_SET: ReadonlySet<string> = new Set(MEDIA_EXTENSIONS);

/** `Cm`: is the extension a muxable container (mp4/webm/mkv/mp3/m4a/ogg)? */
export function isMediaExtension(extension: string): boolean {
  return MEDIA_EXTENSION_SET.has(extension);
}

/** `xi`: is the extension a video container (mp4/webm/mkv)? */
export function isVideoExtension(extension: string): boolean {
  return VIDEO_EXTENSION_SET.has(extension);
}

/** `er`: is the extension an audio-only container (mp3/m4a/ogg)? */
export function isAudioExtension(extension: string): boolean {
  return AUDIO_EXTENSION_SET.has(extension);
}

/**
 * Known media file extensions, used to validate a candidate extension before accepting it
 * (original `bv` Set, pretty 7331-7385, byte 151,589; `Um` membership test at 7386).
 * 53 entries, verbatim.
 */
export const KNOWN_MEDIA_FILE_EXTENSIONS = [
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

const KNOWN_MEDIA_FILE_EXTENSION_SET: ReadonlySet<string> = new Set(
  KNOWN_MEDIA_FILE_EXTENSIONS,
);

/** `Um`: would the original accept this extension as a media file extension? */
export function isKnownMediaFileExtension(extension: string): boolean {
  return KNOWN_MEDIA_FILE_EXTENSION_SET.has(extension);
}

/**
 * Container normalisation (original `Gn`/`it`/`fv`, pretty 7275-7289).
 * Audio containers collapse to `mp3`; `webm`/`mkv` collapse to `mkv`; `mp4` stays `mp4`.
 * The second argument is the preferred muxer for mp4 ("mp4" in every sniffing call site).
 */
export function containerToMuxer(
  extension: string,
  muxer: "mp4" | "mkv",
): string {
  if (isVideoExtension(extension)) {
    if (extension === "mp4") return muxer;
    return "mkv"; // webm or mkv
  }
  // fv(): mp3, m4a and ogg all become mp3
  return "mp3";
}

/** Parsed file name: basename without the extension plus the lowercased extension. */
export interface FileNameDescriptor {
  basename?: string;
  extension: string;
}

/**
 * `Tf` (pretty 11480-11486, byte 240,418): split `name` at the last dot, lowercase the suffix.
 * Returns `undefined` when there is no usable `base.ext` shape.
 */
export function descriptorFromFileName(
  name: string | undefined,
): FileNameDescriptor | undefined {
  if (!name) return undefined;
  const match = /^(.*)\.([^\.]+)$/.exec(name);
  if (!match || !match[1] || !match[2]) return undefined;
  return { basename: match[1], extension: match[2].toLowerCase() };
}

/** `de` (pretty 7245-7250): `new URL` with failure mapped to `undefined` instead of a throw. */
export function tryUrl(
  input: string | URL | undefined,
  base?: string,
): URL | undefined {
  if (input === undefined) return undefined;
  if (input instanceof URL) return input;
  try {
    return new URL(input, base);
  } catch {
    return undefined;
  }
}

/**
 * `extensionFromUrl(url)`: extension of the last path segment, lowercased.
 * Query and hash are excluded because only `URL.pathname` is inspected (D22).
 */
export function extensionFromUrl(
  url: URL | string | undefined,
): string | undefined {
  const parsed = tryUrl(url);
  if (!parsed) return undefined;
  const segment = parsed.pathname.split("/").pop();
  return descriptorFromFileName(segment)?.extension;
}

/** One row of the MIME → demuxer table (original `jm`, pretty 7312-7330, byte 150,766). */
export interface MimeDemuxerRow {
  regex: RegExp;
  audio: string;
  video: string;
}

/**
 * MIME subtype → demuxer table (D20). The regexes are unanchored (`Pf` tests the subtype
 * string with `RegExp.test`), so e.g. `application/x-mpegurl` matches the `mpeg` row.
 */
export const MIME_DEMUXER_ROWS: readonly MimeDemuxerRow[] = [
  { regex: /(?:x-)?(?:pn-)?wave?/i, audio: "wav", video: "wav" },
  { regex: /(?:x-)?3gpp2?/i, audio: "mp3", video: "3gpp" },
  { regex: /(?:x-)?flac/i, audio: "flac", video: "flac" },
  { regex: /(?:x-)?flv/i, audio: "mp3", video: "flv" },
  { regex: /(?:x-)?m4a/i, audio: "m4a", video: "m4a" },
  { regex: /(?:x-)?m4v/i, audio: "mp3", video: "m4v" },
  { regex: /(?:x-)?matroska/i, audio: "mp3", video: "mkv" },
  { regex: /(?:x-)?mov/i, audio: "mp3", video: "mov" },
  { regex: /(?:x-)?mp2t/i, audio: "mp3", video: "mp2t" },
  { regex: /(?:x-)?mp4/i, audio: "mp3", video: "mp4" },
  { regex: /(?:x-)?mpeg/i, audio: "mp3", video: "mpeg" },
  { regex: /(?:x-)?mts/i, audio: "mp3", video: "mt2s" },
  { regex: /(?:x-)?msvideo/i, audio: "avi", video: "avi" },
  { regex: /(?:x-)?og./i, audio: "oga", video: "ogv" },
  { regex: /(?:x-)?webm/i, audio: "oga", video: "webm" },
  { regex: /(?:x-)?mkv/i, audio: "mp3", video: "mkv" },
  { regex: /(?:x-)?vorbis/i, audio: "oga", video: "ogv" },
];

/**
 * `Pf` (pretty 11469-11479, byte 240,185): content-type → demuxer-ish name.
 * The major type only decides the audio/video column; any non-`audio` major uses the video
 * column. Parameters (`; charset=…`) are stripped and the subtype is lowercased.
 */
export function mimeToDemuxer(
  contentType: string | undefined,
): string | undefined {
  if (!contentType) return undefined;
  const parts = contentType.split(";");
  let value = contentType;
  const first = parts[0];
  if (first) value = first.trim().toLowerCase();
  const slash = value.split("/");
  if (!slash[0] || !slash[1]) return undefined;
  const kind = slash[0] === "audio" ? "audio" : "video";
  for (const row of MIME_DEMUXER_ROWS) {
    if (row.regex.test(slash[1])) return row[kind];
  }
  return undefined;
}

/** One row of a codec → demuxer table (original `gv` video rows / `hv` audio rows). */
export interface CodecDemuxerRow {
  /** Original field name is `mime_reg` (pretty 7291); kept close to the source. */
  mime_regex: RegExp;
  demuxer: string;
  codec: string;
}

/**
 * Video codec table (original `gv`, pretty 7290-7297, byte 150,026). First match wins.
 * This is the exact name transfer/remux imports as `CODEC_DEMUXER_ROWS`.
 */
export const CODEC_DEMUXER_ROWS: readonly CodecDemuxerRow[] = [
  { mime_regex: /(avc1|avc3).*/i, demuxer: "mp4", codec: "H264" },
  {
    mime_regex: /(hvc1|hev1|hevc|h265|h\.265).*/i,
    demuxer: "mp4",
    codec: "H265",
  },
  { mime_regex: /mp4v\.20.*/i, demuxer: "mp4", codec: "MP4V" },
  { mime_regex: /av0?1.*/i, demuxer: "webm", codec: "AV1" },
  { mime_regex: /vp0?8.*/i, demuxer: "webm", codec: "VP8" },
  { mime_regex: /vp0?9.*/i, demuxer: "webm", codec: "VP9" },
];

/** Alias making the video/audio split explicit; `CODEC_DEMUXER_ROWS` is the video table. */
export const VIDEO_CODEC_DEMUXER_ROWS: readonly CodecDemuxerRow[] =
  CODEC_DEMUXER_ROWS;

/** Audio codec table (original `hv`, pretty 7298-7303, byte 150,357). First match wins. */
export const AUDIO_CODEC_DEMUXER_ROWS: readonly CodecDemuxerRow[] = [
  { mime_regex: /(aac|mp4a.40).*/i, demuxer: "m4a", codec: "AAC" },
  { mime_regex: /(\.?mp3|mp4a\.69|mp4a\.6b).*/i, demuxer: "mp3", codec: "MP3" },
  { mime_regex: /(opus|(mp4a\.ad.*))/i, demuxer: "ogg", codec: "Opus" },
  { mime_regex: /vorbis/i, demuxer: "ogg", codec: "Vorbis" },
];

/** Both codec tables in original evaluation order: video rows first, then audio rows. */
export const ALL_CODEC_DEMUXER_ROWS: readonly CodecDemuxerRow[] = [
  ...CODEC_DEMUXER_ROWS,
  ...AUDIO_CODEC_DEMUXER_ROWS,
];

/**
 * First matching codec row over **both** tables (video first). Used by transfer/remux to pick a
 * container from a codec string; the discovery engine uses the per-kind helpers below to mirror
 * the original `Zn` (HLS, video only) / `Mm` (DASH audio fallback) behaviour.
 */
export function codecToDemuxer(codec: string): string | undefined {
  for (const row of ALL_CODEC_DEMUXER_ROWS) {
    if (row.mime_regex.test(codec)) return row.demuxer;
  }
  return undefined;
}

/** `Zn`: video codec string → demuxer (pretty 7304-7307). */
export function videoCodecToDemuxer(codec: string): string | undefined {
  for (const row of CODEC_DEMUXER_ROWS) {
    if (row.mime_regex.test(codec)) return row.demuxer;
  }
  return undefined;
}

/** `Mm`: audio codec string → demuxer (pretty 7308-7311). */
export function audioCodecToDemuxer(codec: string): string | undefined {
  for (const row of AUDIO_CODEC_DEMUXER_ROWS) {
    if (row.mime_regex.test(codec)) return row.demuxer;
  }
  return undefined;
}

/** Segment requests that the sniffing path drops before classification (D9 step 3, D5). */
/** HLS fragment/init files that must never become standalone media items. */
export const HLS_FRAGMENT_PATH_PATTERN = /(?:_part\d+|_init_[A-Za-z0-9_-]+)\.(?:mp4|m4s|ts)$/i;

export const SEGMENT_PATH_PATTERN = /\.ts$|\.m4s$|\.m2ts$|(?:_part\d+|_init_[A-Za-z0-9_-]+)\.(?:mp4|m4s|ts)$/i;

/**
 * Initiator hosts handled by site adapters; `webRequest` sniffing is suppressed for them
 * (original `PS`, pretty 11317-11329, byte 237,954; D25). Matched on the last two host labels.
 */
export const BLOCKED_INITIATOR_HOSTS = [
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

const BLOCKED_INITIATOR_HOST_SET: ReadonlySet<string> = new Set(
  BLOCKED_INITIATOR_HOSTS,
);

/** `PS` membership test: compare against the hostname's last two labels (as the original does). */
export function isBlockedInitiatorHost(hostname: string): boolean {
  const lastTwo = hostname.split(".").slice(-2).join(".");
  return BLOCKED_INITIATOR_HOST_SET.has(lastTwo);
}

/** Result of resolving a direct response's extension/filename/demuxer (original `$S`). */
export interface MediaDescriptor {
  /** `libav_demuxer`: set only when the extension is a muxable container (mp4/webm/mkv). */
  libavDemuxer?: string;
  /** Output extension; normalised through `containerToMuxer` when it is a muxable container. */
  extension: string;
  /** Basename from the URL path or the Content-Disposition header, whichever wins. */
  filename?: string;
}

/**
 * Extract a filename from a Content-Disposition value. Mirrors the original regex
 * `filename\*=(?:UTF-8'')?['"]?([^'";]*)['"]?|filename=['"]?([^'";]*)['"]?`, preferring the
 * RFC 5987 form. `decodeURIComponent` failures fall back to the raw value (the original would
 * throw; documented deviation in 02-detection-pipeline.md U-notes).
 */
export function filenameFromContentDisposition(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  const match =
    /filename\*=(?:UTF-8'')?['"]?([^'";]*)['"]?|filename=['"]?([^'";]*)['"]?/i.exec(
      header,
    );
  if (!match) return undefined;
  const encoded = match[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return match[2] || undefined;
}

/**
 * `$S` (pretty 11487-11507, byte 240,564): resolve extension, basename and libav demuxer from
 * the content-disposition header, content-type and response URL.
 *
 * Candidate order is [URL path file name, content-disposition file name, MIME-derived
 * extension]. The loop does not break: the **last** candidate with a known media extension
 * wins for the extension, and the last such candidate that also has a basename wins for the
 * filename. A muxable container additionally yields `libav_demuxer` (and its extension is
 * normalised to the output muxer), otherwise the extension is kept as-is or defaults to `mp4`.
 */
export function resolveMediaDescriptor(
  contentDisposition: string | undefined,
  contentType: string | undefined,
  url: URL,
): MediaDescriptor {
  const candidates: FileNameDescriptor[] = [];
  const pathCandidate = descriptorFromFileName(url.pathname.split("/").pop());
  if (pathCandidate) candidates.push(pathCandidate);
  const dispositionCandidate = descriptorFromFileName(
    filenameFromContentDisposition(contentDisposition),
  );
  if (dispositionCandidate) candidates.push(dispositionCandidate);
  const mimeExtension = mimeToDemuxer(contentType);
  if (mimeExtension) candidates.push({ extension: mimeExtension });

  let extension: string | undefined;
  let filename: string | undefined;
  for (const candidate of candidates) {
    if (!isKnownMediaFileExtension(candidate.extension)) continue;
    extension = candidate.extension;
    if (candidate.basename) filename = candidate.basename;
  }

  let libavDemuxer: string | undefined;
  if (extension && isMediaExtension(extension)) {
    libavDemuxer = extension;
    if (isVideoExtension(extension))
      extension = containerToMuxer(extension, "mp4");
  }
  return {
    extension: extension ?? "mp4",
    ...(libavDemuxer !== undefined ? { libavDemuxer } : {}),
    ...(filename !== undefined ? { filename } : {}),
  };
}
