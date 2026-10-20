/**
 * Strategy selection and preview plans.
 *
 * Evidence: analysis/evidence/03-manifest-resolution.md
 *  - F19: the closed strategy enum and the two classifier lists (svc:9500-9507).
 *  - F20 (HLS master => `Hv`, svc:9785-9893), F21 (HLS media playlist => `Gv`, svc:9895-9944),
 *    F22 (MPD => `Vv`, svc:9619-9671). The §3.2 matrix is reproduced decision-for-decision.
 *  - F23: preview plans (`_p`, svc:9508-9618) and the 480→260→last default rendition (`Qn`).
 *  - F15: user quality is a height; `preferred_entry` wins over the height match (Kn).
 *  - F24: extension/muxer mapping (`it`/`fv`, svc:7275-7289).
 *
 * This module works on the discovery-side `MediaItem` shape: by the time a plan is built the
 * manifest has already been turned into `PlaylistEntry[]` (av sources, demuxer, quality).
 */
import { err, ok, type Result } from "../core/option.js";
import {
  TransferStrategy,
  type DownloadPlan,
  type MediaItem,
  type PlaylistEntry,
  type SubtitleTrack,
} from "../core/types.js";
import { DEMUXER_ORDER } from "../manifests/hls.js";

/** Audio-only demuxers (`er`, svc:7272-7274). */
export const AUDIO_ONLY_DEMUXERS: ReadonlySet<string> = new Set(["mp3", "m4a", "ogg"]);

export function isAudioOnlyDemuxer(demuxer: string | undefined): boolean {
  return demuxer !== undefined && AUDIO_ONLY_DEMUXERS.has(demuxer);
}

/** Container demuxers known to the transfer layer (`Nm`, svc:7263). Re-exported for build.ts. */
export const VIDEO_DEMUXERS: ReadonlySet<string> = new Set(["mp4", "webm", "mkv"]);

/**
 * Extension/muxer for a demuxer (`it`, F24): mp4 keeps the user's preferred container,
 * webm/mkv become mkv (libav cannot write webm through this mux path).
 */
export function extensionForDemuxer(demuxer: string, preferredAvMuxer: "mp4" | "mkv"): string {
  if (demuxer === "mp4") return preferredAvMuxer;
  if (demuxer === "webm" || demuxer === "mkv") return "mkv";
  return preferredAvMuxer;
}

/** Select the playlist entry for a user height (`Kn`, F15). */
export interface SelectedPlaylistEntry {
  entry: PlaylistEntry;
  index: number;
}

export function selectPlaylistEntry(
  media: MediaItem,
  preferredHeight?: number,
): SelectedPlaylistEntry | undefined {
  const playlist = media.playlist;
  if (playlist === undefined || playlist.length === 0) return undefined;
  // `preferred_entry` wins before any height matching (Kn, svc:7401-7413).
  if (media.preferred_entry !== undefined) {
    const preferred = playlist[media.preferred_entry];
    if (preferred !== undefined) return { entry: preferred, index: media.preferred_entry };
  }
  if (preferredHeight !== undefined) {
    for (const demuxer of DEMUXER_ORDER) {
      for (let index = 0; index < playlist.length; index += 1) {
        const entry = playlist[index];
        if (entry === undefined) continue;
        if (entry.demuxer === demuxer && entry.quality.size?.height === preferredHeight) {
          return { entry, index };
        }
      }
    }
  }
  const first = playlist[0];
  return first === undefined ? undefined : { entry: first, index: 0 };
}

/** Preview rendition default: 480 → 260 → last (`Qn`, F23). */
export function defaultPreviewEntry(media: MediaItem): SelectedPlaylistEntry | undefined {
  const playlist = media.playlist;
  if (playlist === undefined || playlist.length === 0) return undefined;
  const at480 = playlist.findIndex((entry) => entry.quality.size?.height === 480);
  if (at480 !== -1) return { entry: playlist[at480] as PlaylistEntry, index: at480 };
  const at260 = playlist.findIndex((entry) => entry.quality.size?.height === 260);
  if (at260 !== -1) return { entry: playlist[at260] as PlaylistEntry, index: at260 };
  const last = playlist.length - 1;
  return { entry: playlist[last] as PlaylistEntry, index: last };
}

/** Choose the subtitle track for the user's language set (`vt`, F16). */
export function selectSubtitleTrack(
  tracks: readonly SubtitleTrack[] | undefined,
  languages: ReadonlySet<string> | undefined,
): SubtitleTrack | undefined {
  if (tracks === undefined || tracks.length === 0 || languages === undefined || languages.size === 0) {
    return undefined;
  }
  for (const language of languages) {
    const exact = tracks.find((track) => track.language === language);
    if (exact !== undefined) return exact;
  }
  for (const language of languages) {
    const base = language.split("-")[0];
    if (base === undefined || base === "") continue;
    const partial = tracks.find((track) => track.language.split("-")[0] === base);
    if (partial !== undefined) return partial;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Strategy choice (§3.2 matrix)
// ---------------------------------------------------------------------------

export interface ChooseStrategyOptions {
  audioOnly: boolean;
  /** User quality height; when absent `preferred_entry`/index 0 is used (F15). */
  preferredQuality?: number;
}

export interface StrategyChoice {
  strategy: TransferStrategy;
  url: URL;
  url_audio?: URL;
  /** MPD representation index (`-mpd_video_idx`); only set for DASH choices. */
  entry?: number;
  /**
   * Extension beyond the frozen contract: the playlist entry/index the choice was derived from,
   * so the plan builder can read demuxer/language/subtitle metadata without redoing selection.
   */
  playlistEntry?: PlaylistEntry;
  playlistIndex?: number;
}

const supportsStrategy = (type: MediaItem["type"]): boolean =>
  type === "m3u8_playlist" || type === "m3u8" || type === "mpd_playlist";

/**
 * Map a discovered playlist media item to its transfer strategy.
 *
 * HLS master (§3.2 rows 1-4):
 *  - no separate video track (`av.video === false`) → `m3u8_audio_only`
 *  - audio-only requested → `m3u8_audio_only` (audio rendition, else the video URL)
 *  - audio rendition present → `m3u8_audio_video_two_sources`
 *  - else → `m3u8_audio_video_one_source`
 *
 * HLS media playlist (§3.2 rows 5-6): audio-only demuxer or audio-only requested →
 * `m3u8_audio_only`; else `m3u8_audio_video_one_source` (the playlist already muxes both).
 *
 * MPD (§3.2 rows 7-8): audio-only demuxer or audio-only requested → `mpd_audio_only`;
 * else `mpd_audio_video_one_source`. `url` is the MPD master URL plus the representation
 * `entry` index — the shipped plan does not point at a representation URL (F22/F26).
 */
export function chooseStrategy(item: MediaItem, options: ChooseStrategyOptions): Result<StrategyChoice, string> {
  if (!supportsStrategy(item.type)) {
    return err(`unsupported media type for strategy choice: ${item.type}`);
  }

  if (item.type === "m3u8") {
    const url = item.url;
    if (url === undefined) return err("m3u8 media item is missing its media playlist URL");
    if (options.audioOnly || isAudioOnlyDemuxer(item.demuxer)) {
      return ok({ strategy: TransferStrategy.HlsAudioOnly, url });
    }
    return ok({ strategy: TransferStrategy.HlsAudioVideoOneSource, url });
  }

  if (item.type === "mpd_playlist") {
    const master = item.master_url;
    if (master === undefined) return err("mpd media item is missing its master URL");
    const selected = selectPlaylistEntry(item, options.preferredQuality);
    if (selected === undefined) return err("mpd media item has no playlist entries");
    const entryIndex = selected.entry.index ?? selected.index;
    if (options.audioOnly || isAudioOnlyDemuxer(selected.entry.demuxer)) {
      return ok({
        strategy: TransferStrategy.DashAudioOnly,
        url: master,
        entry: entryIndex,
        playlistEntry: selected.entry,
        playlistIndex: selected.index,
      });
    }
    return ok({
      strategy: TransferStrategy.DashAudioVideoOneSource,
      url: master,
      entry: entryIndex,
      playlistEntry: selected.entry,
      playlistIndex: selected.index,
    });
  }

  // HLS master playlist.
  const selected = selectPlaylistEntry(item, options.preferredQuality);
  if (selected === undefined) return err("HLS master playlist has no renditions");
  const av = selected.entry.av;
  const base = {
    playlistEntry: selected.entry,
    playlistIndex: selected.index,
  } as const;
  if (av === undefined) return err("HLS playlist entry is missing its av sources");
  if (av.video === false) {
    if (av.audio === false) return err("HLS playlist entry has neither audio nor video");
    return ok({ strategy: TransferStrategy.HlsAudioOnly, url: av.audio, ...base });
  }
  if (options.audioOnly) {
    const url = av.audio === false ? av.video : av.audio;
    return ok({ strategy: TransferStrategy.HlsAudioOnly, url, ...base });
  }
  if (av.audio !== false) {
    return ok({
      strategy: TransferStrategy.HlsAudioVideoTwoSources,
      url: av.video,
      url_audio: av.audio,
      ...base,
    });
  }
  return ok({ strategy: TransferStrategy.HlsAudioVideoOneSource, url: av.video, ...base });
}

// ---------------------------------------------------------------------------
// Preview plans (`_p`, F23)
// ---------------------------------------------------------------------------

export interface PreviewPlanSettings {
  downloadDirectory: string;
  saveAs?: boolean;
  downloadIdFactory?: () => string;
  /**
   * Extension beyond the frozen contract: site flag that keeps the master query string on
   * segment URLs (`CARRY_GET_PARAMS_WEBSITES`, F7). Defaults to false like the common case.
   */
  carryGetParams?: boolean;
}

/** Default id factory; tests inject a deterministic one. */
export function defaultDownloadIdFactory(): string {
  return `download_${crypto.randomUUID()}`;
}

/**
 * Build the preview download plan (`_p`, F23). Preview rendering is the only consumer of the
 * 480/260/last default rendition rule. The shipped preview plan uses a literal `"unused"`
 * basename and the configured download directory as its subdirectory.
 */
export function buildPreviewPlan(
  item: MediaItem,
  settings: PreviewPlanSettings,
): Result<DownloadPlan, string> {
  const downloadIdFactory = settings.downloadIdFactory ?? defaultDownloadIdFactory;
  const carryGetParams = settings.carryGetParams ?? false;
  const base = {
    download_id: downloadIdFactory(),
    headers: new Headers(item.sent_headers),
    good_basename: "unused",
    subdir: settings.downloadDirectory,
    save_as: settings.saveAs ?? false,
    is_youtube: item.is_youtube,
    throttle: false,
    cache: item.cache,
    carry_get_params: carryGetParams,
  } as const;

  if (item.type === "m3u8_playlist") {
    const selected = defaultPreviewEntry(item);
    if (selected === undefined) return err("HLS master playlist has no renditions");
    const av = selected.entry.av;
    if (av === undefined || av.video === false) return err("HLS preview rendition has no video URL");
    const container = extensionForDemuxer(selected.entry.demuxer, "mp4");
    return ok({
      ...base,
      duration: item.duration,
      will_use_jsfetch: !carryGetParams, // execution-time override for HLS (F7)
      strategy: TransferStrategy.HlsVideoPreview,
      url: av.video,
      extension: container,
      muxer: container,
    });
  }
  if (item.type === "m3u8") {
    if (item.url === undefined) return err("m3u8 media item is missing its media playlist URL");
    const container = extensionForDemuxer(item.demuxer ?? "mp4", "mp4");
    return ok({
      ...base,
      duration: item.duration,
      will_use_jsfetch: !carryGetParams,
      strategy: TransferStrategy.HlsVideoPreview,
      url: item.url,
      extension: container,
      muxer: container,
    });
  }
  if (item.type === "mpd_playlist") {
    if (item.master_url === undefined) return err("mpd media item is missing its master URL");
    const selected = defaultPreviewEntry(item);
    if (selected === undefined) return err("mpd media item has no playlist entries");
    return ok({
      ...base,
      duration: item.duration,
      will_use_jsfetch: true,
      strategy: TransferStrategy.DashVideoPreview,
      url: item.master_url,
      entry: selected.entry.index ?? selected.index,
      extension: "mp4",
      muxer: "mp4",
    });
  }
  if (item.type === "http_playlist") {
    const entry = item.playlist?.[0];
    const video = entry?.av?.video;
    if (entry === undefined || video === undefined || video === false) {
      return err("http media item is missing its video URL");
    }
    return ok({
      ...base,
      will_use_jsfetch: true,
      strategy: TransferStrategy.HttpVideoPreview,
      url: video,
      extension: "mp4",
      muxer: "mp4",
      size: entry.size,
    });
  }
  if (item.type === "youtube_format") {
    const selected = defaultPreviewEntry(item);
    if (selected === undefined) return err("youtube media item has no formats");
    const av = selected.entry.av;
    if (av === undefined || av.video === false) return err("youtube preview format has no video URL");
    const container = extensionForDemuxer(selected.entry.demuxer, "mp4");
    return ok({
      ...base,
      duration: item.duration,
      will_use_jsfetch: false,
      strategy: TransferStrategy.YoutubeVideoPreview,
      url: av.video,
      extension: container,
      muxer: container,
      content_length: selected.entry.size,
    });
  }
  return err(`unsupported media type for preview: ${item.type}`);
}
