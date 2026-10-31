/**
 * Shared data model for the rebuilt loop.
 *
 * Shapes and field names follow the recovered protocol (`analysis/evidence/01..04`) so parity
 * tests can compare values directly and so the module seams match what the original transports
 * between contexts. Optionality is `T | undefined`; Option/Result wrappers are used only where
 * the original protocol is explicitly optional (see protocol/serde.ts).
 */

/** Why a transfer ended. Mirrors the original ending-reason object field-for-field. */
export interface EndingReason {
  user_abort: boolean;
  e4XX_5XX_failure: boolean;
  percentage_incomplete: boolean;
  other_failure: boolean;
  message?: string;
  status?: number;
}

/** User-initiated abort reason. */
export function userAbortReason(): EndingReason {
  return { user_abort: true, e4XX_5XX_failure: false, percentage_incomplete: false, other_failure: false };
}

/** Generic failure carrying a message. */
export function otherFailureReason(message: string): EndingReason {
  return {
    user_abort: false,
    e4XX_5XX_failure: false,
    percentage_incomplete: false,
    other_failure: true,
    message,
  };
}

/** HTTP 4xx/5xx failure. */
export function httpFailureReason(status: number): EndingReason {
  return {
    user_abort: false,
    e4XX_5XX_failure: true,
    percentage_incomplete: false,
    other_failure: false,
    status,
  };
}

// ---------------------------------------------------------------------------
// Discovery model (proven: 02-detection-pipeline.md Â§3.1)
// ---------------------------------------------------------------------------

/** Media item kinds emitted by the sniffing path. Site adapters add `youtube_format`. */
export type MediaType = "http_playlist" | "m3u8" | "m3u8_playlist" | "mpd_playlist" | "youtube_format";

/** Size/bitrate descriptor attached to a rendition. */
export interface Quality {
  size?: { height: number; width?: number };
  bitrate?: number;
}

/** Video/audio URL pair of one rendition. `false` means "no separate audio track". */
export interface AvSource {
  video: URL | false;
  audio: URL | false;
}

/** One selectable rendition of a playlist media item. */
export interface PlaylistEntry {
  /** Container demuxer name, e.g. mp4/webm/mkv/mp3/m4a/ogg. */
  demuxer: string;
  quality: Quality;
  av?: AvSource;
  /** Byte size when the entry came from a direct HTTP response. */
  size?: number;
  /** DASH representation index (used by the libav `-mpd_*_idx` arguments). */
  index?: number;
  audio_id?: string;
  audio_language?: string;
}

/** Subtitle track reference. `type:"id"` refers to an in-manifest rendition (DASH). */
export type SubtitleTrack =
  | { language: string; type: "http"; url: URL }
  | { language: string; type: "id"; id: string; languageName?: string };

/** Duration reported to the UI. */
export type MediaDuration = number | "live" | "unknown";

/** Toolbar action chosen for a site (also the context-menu default). */
export type DefaultAction = "download" | "download_as" | "download_audio" | "copy";

/** One discovered media item in a tab. */
export interface MediaItem {
  type: MediaType;
  /** `media_hash_<cyrb53>`; per-tab identity used for dedupe and UI keys. */
  hash: string;
  is_youtube: boolean;
  /** Request headers captured for the response; replayed on manifest/segment fetches. */
  sent_headers: Headers;
  /** Page/player URL that caused the request. */
  initiator?: URL;
  /** Manifest URL for `m3u8_playlist` / `mpd_playlist`. */
  master_url?: URL;
  /** Media-playlist URL for standalone `m3u8` items. */
  url?: URL;
  /** Renditions; also carries the direct-response entry for `http_playlist`. */
  playlist?: PlaylistEntry[];
  /** Container demuxer for `m3u8` items. */
  demuxer?: string;
  /** Resolved demuxer for `http_playlist` (mp4/webm/mkv only). */
  libav_demuxer?: string;
  /** Output extension for `http_playlist`. */
  extension?: string;
  filename?: string;
  supports_byte_ranges?: boolean;
  duration?: MediaDuration;
  has_drm?: boolean;
  subtitles?: SubtitleTrack[];
  thumbnail_url?: URL;
  /** Rendered player size when the manifest itself carries no resolution metadata. */
  rendered_width?: number;
  rendered_height?: number;
  /** Approximate average bitrate from page resource timing. */
  estimated_bitrate?: number;
  /** Optional direct MP4/WebM track used for a muted hover preview (e.g. Twitter). */
  preview_url?: URL;
  /** HLS alternative for a direct format stream, when the source exposes both. */
  hls_url?: URL;
  title?: string;
  /** Explicit rendition chosen by the user. */
  preferred_entry?: number;
  discovery_timestamp_ms: number;
  cache: "default" | "reload";
}

/** Selected tab metadata used for naming, defaults and UI. */
export interface TabMeta {
  incognito: boolean;
  tab_id: number;
  title?: string;
  thumbnail_url?: URL;
  favicon_url?: URL;
  url?: URL;
  default_action: DefaultAction;
  /** Smart-naming rule resolved for this page (see naming/rules.ts). */
  smartnaming_rule: import("../naming/rules.js").MaterializedRule;
}

// ---------------------------------------------------------------------------
// Transfer plan (proven: 03-manifest-resolution.md Â§3.1/Â§3.2, 04-download-transfer.md)
// ---------------------------------------------------------------------------

/** Transfer strategies observed in the original (`download_args.strategy`). */
export const TransferStrategy = {
  // Progressive HTTP
  HttpVideoPreview: "http_video_preview_jsfetch",
  HttpAudioVideoOneSource: "http_audio_video_one_source",
  HttpAudioVideoOneSourceJsFetch: "http_audio_video_one_source_jsfetch",
  HttpAudioVideoTwoSourcesJsFetch: "http_audio_video_two_sources_jsfetch",
  HttpStripAudioJsFetch: "http_strip_audio_jsfetch",
  // HLS
  HlsVideoPreview: "m3u8_video_preview",
  HlsAudioOnly: "m3u8_audio_only",
  HlsAudioVideoOneSource: "m3u8_audio_video_one_source",
  HlsAudioVideoTwoSources: "m3u8_audio_video_two_sources",
  // DASH
  DashVideoPreview: "mpd_video_preview",
  DashAudioOnly: "mpd_audio_only",
  DashAudioVideoOneSource: "mpd_audio_video_one_source",
  // Site adapter (YouTube-shaped)
  YoutubeVideoPreview: "youtube_video_preview",
  YoutubeAudioOnly: "youtube_audio_only",
  YoutubeAudioVideoOneSource: "youtube_audio_video_one_source",
  YoutubeAudioVideoTwoSources: "youtube_audio_video_two_sources",
} as const;

export type TransferStrategy = (typeof TransferStrategy)[keyof typeof TransferStrategy];

/** HLS strategies routed through the HLS transfer path. */
export const HLS_STRATEGIES: readonly string[] = [
  TransferStrategy.HlsVideoPreview,
  TransferStrategy.HlsAudioOnly,
  TransferStrategy.HlsAudioVideoOneSource,
  TransferStrategy.HlsAudioVideoTwoSources,
];

/** DASH strategies routed through the DASH transfer path. */
export const DASH_STRATEGIES: readonly string[] = [
  TransferStrategy.DashVideoPreview,
  TransferStrategy.DashAudioOnly,
  TransferStrategy.DashAudioVideoOneSource,
];

export const isHlsStrategy = (strategy: string): boolean => HLS_STRATEGIES.includes(strategy);
export const isDashStrategy = (strategy: string): boolean => DASH_STRATEGIES.includes(strategy);

/** Complete download plan produced before the transfer starts. */
export interface DownloadPlan {
  /** `download_<uuid>`; correlates all worker/progress messages. */
  download_id: string;
  headers: Headers;
  /** Origin from which headers were captured; used to scope credential replay. Optional for backward compatibility with test fixtures, but always set in production. */
  headers_origin?: string;
  good_basename: string;
  subdir: string;
  duration?: MediaDuration;
  save_as: boolean;
  will_use_jsfetch: boolean;
  strategy: TransferStrategy;
  url: URL;
  url_audio?: URL;
  carry_get_params: boolean;
  extension: string;
  muxer: string;
  /** Requested container/audio target from the panel "Format" select. */
  output_format?: "mp4" | "mkv" | "webm" | "mp3";
  /** Demuxer of the selected rendition (mp4/webm/...), used to choose copy vs transcode. */
  source_demuxer?: string;
  is_youtube: boolean;
  throttle: boolean;
  cache: "default" | "reload";
  subtitles?: SubtitleTrack;
  audio_language?: string;
  audio_track_id?: string;
  /** DASH representation index for the audio/video track. */
  entry?: number;
  content_length?: number;
  audio_content_length?: number;
  size?: number;
}

// ---------------------------------------------------------------------------
// Transfer results / progress (proven: 04-download-transfer.md Â§3.2-Â§3.4)
// ---------------------------------------------------------------------------

/** Worker â†’ service progress payload. At most 2 Hz. */
export interface DownloadProgress {
  status: "queuing" | "downloading" | "finalizing";
  percent?: { is_known: boolean; value: number };
  fetched_bytes_count?: number;
  output_duration_s?: number;
}

/** Output of one transfer, as returned by the worker to the service worker. */
export interface TransferOutcome {
  /** Set when the transfer was cancelled before producing a file. */
  download_id?: string;
  aborted_no_partial?: boolean;
  ending_reason?: EndingReason;
  /** Final container extension actually produced by the worker (may differ from the plan when a remuxer is unavailable). */
  output_extension?: string;
  /** OPFS file name of the assembled output (removed after saving). */
  internal_filename?: string;
  /** Blob URL handed to chrome.downloads. */
  internal_bloburl?: string;
  browser_download_id?: number;
  browser_downloads_duration_ms?: number;
  path?: string;
}

