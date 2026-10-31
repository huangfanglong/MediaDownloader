/**
 * Download-plan assembly.
 *
 * Evidence: analysis/evidence/03-manifest-resolution.md
 *  - F36: the exact plan field set produced by the shipped `kt` dispatch (svc:10039-10050) and
 *    the five producers `Hv`/`Gv`/`Vv`/`Bv`/`Zv` (svc:9508-10035). Fields that the shipped
 *    progressive-http producer omitted (`muxer` on `http_audio_video_one_source`) are filled
 *    here because the frozen `DownloadPlan` type requires them; documented deviation.
 *  - F7: HLS `will_use_jsfetch` is the execution-time value `!carry_get_params`.
 *  - F22/F25: MPD plans carry `url = master_url`, `entry = representation index`, and are
 *    always jsfetch (the transfer is libav's dash demuxer).
 *  - F30/F32: duration comes from the media item, size only exists for progressive http.
 *  - F35/F38: plan ids are `download_<uuid>`; headers are a clone of the captured request
 *    headers (the shipped builder round-trips them through the serde, svc:7176-7178).
 *
 * Naming is NOT reimplemented here: `renderBasename` from naming/render.ts owns basename and
 * subdirectory rendering, exactly as the shipped `Ar` did.
 */
import { err, ok, type Result } from "../core/option.js";
import type { DownloadPlan, MediaItem, TabMeta } from "../core/types.js";
import { renderBasename } from "../naming/render.js";
import {
  VIDEO_DEMUXERS,
  chooseStrategy,
  defaultDownloadIdFactory,
  extensionForDemuxer,
  selectPlaylistEntry,
  selectSubtitleTrack,
} from "./strategies.js";

/** Inputs to plan construction; mirrors the settings the shipped `kt` received. */
export interface BuildPlanInput {
  media: MediaItem;
  meta: TabMeta;
  audioOnly: boolean;
  preferredQuality?: number;
  /** Explicit playlist entry for direct HTTP items (quality dropdown). */
  preferredEntry?: number;
  /**
   * Audio strategy/languages are consumed during discovery (the shipped `Lm` rendition choice,
   * F13); plan assembly receives an already-resolved `av.audio` URL and keeps the fields only so
   * the caller can pass one settings object. They are intentionally unused here.
   */
  preferredAudioStrategy: "original" | "user_language";
  preferredAudioLanguages: Set<string>;
  preferredAvMuxer: "mp4" | "mkv";
  downloadDirectory: string;
  saveAs?: boolean;
  /** Extensions beyond the frozen contract (site behaviour / user settings). */
  carryGetParams?: boolean;
  youtubeThrottle?: boolean;
  subtitleLanguages?: Set<string>;
  downloadIdFactory?: () => string;
}

/** Container demuxers libav can remux from (`Nm`, svc:7263). */
const VIDEO_CONTAINERS: ReadonlySet<string> = VIDEO_DEMUXERS;

/** Common fields shared by every plan produced by this builder. */
interface PlanBase {
  download_id: string;
  headers: Headers;
  headers_origin: string;
  good_basename: string;
  subdir: string;
  save_as: boolean;
  is_youtube: boolean;
  throttle: boolean;
  cache: "default" | "reload";
  carry_get_params: boolean;
}

function planBase(input: BuildPlanInput, downloadIdFactory: () => string): PlanBase {
  const rendered = renderBasename(
    { title: input.media.title, filename: input.media.filename },
    { title: input.meta.title, url: input.meta.url?.href },
    input.meta.smartnaming_rule,
  );
  return {
    download_id: downloadIdFactory(),
    // Clone, never share: the execution step strips browser-managed headers from the plan (F2).
    headers: new Headers(input.media.sent_headers),
    headers_origin: input.media.master_url?.origin ?? input.media.url?.origin ?? "",
    good_basename: rendered.basename,
    subdir: rendered.subdir !== "" ? rendered.subdir : input.downloadDirectory,
    save_as: input.saveAs ?? false,
    is_youtube: input.media.is_youtube,
    throttle: input.media.is_youtube && (input.youtubeThrottle ?? false),
    cache: input.media.cache,
    carry_get_params: input.carryGetParams ?? false,
  };
}

/**
 * Build a download plan for a discovered media item.
 *
 * HLS/MPD rows delegate the strategy matrix to `chooseStrategy` (§3.2); progressive-http and
 * youtube-shaped rows are resolved here because they are outside the strategy contract but are
 * required for a complete plan builder (F19 enumeration).
 */
export function buildPlan(input: BuildPlanInput): Result<DownloadPlan, string> {
  const downloadIdFactory = input.downloadIdFactory ?? defaultDownloadIdFactory;
  // An explicit quality-dropdown index must also steer manifest/YouTube selection. The strategy
  // helpers read `media.preferred_entry`, so bind it before choosing a strategy.
  const media =
    input.preferredEntry !== undefined
      ? { ...input.media, preferred_entry: input.preferredEntry }
      : input.media;
  const base = planBase(input, downloadIdFactory);

  if (media.type === "m3u8_playlist" || media.type === "m3u8" || media.type === "mpd_playlist") {
    const choice = chooseStrategy(media, {
      audioOnly: input.audioOnly,
      ...(input.preferredQuality === undefined ? {} : { preferredQuality: input.preferredQuality }),
    });
    if (choice.tag === "Err") return err(choice.error);
    const selected = choice.value.playlistEntry;
    const isDash = media.type === "mpd_playlist";
    const strategy = choice.value.strategy;
    const isAudioOnly = strategy === "m3u8_audio_only" || strategy === "mpd_audio_only";
    const isAv =
      strategy === "m3u8_audio_video_one_source" ||
      strategy === "m3u8_audio_video_two_sources" ||
      strategy === "mpd_audio_video_one_source";

    let extension: string;
    let muxer: string;
    if (isAudioOnly) {
      extension = "mp3";
      muxer = "mp3";
    } else if (isDash) {
      // F22: MPD plans use the user's preferred muxer directly (FFmpeg decides the container).
      extension = input.preferredAvMuxer;
      muxer = input.preferredAvMuxer;
    } else {
      extension = extensionForDemuxer(selected?.demuxer ?? "mp4", input.preferredAvMuxer);
      muxer = extension;
    }

    const subtitles = isAv ? selectSubtitleTrack(media.subtitles, input.subtitleLanguages) : undefined;
    // F20/F22: audio language is carried on HLS-master and MPD plans, not on media-playlist plans.
    const audioLanguage =
      isDash || media.type === "m3u8_playlist" ? selected?.audio_language : undefined;

    return ok<DownloadPlan>({
      ...base,
      will_use_jsfetch: isDash ? true : !base.carry_get_params, // F7
      strategy,
      url: choice.value.url,
      ...(choice.value.url_audio === undefined ? {} : { url_audio: choice.value.url_audio }),
      ...(choice.value.entry === undefined ? {} : { entry: choice.value.entry }),
      extension,
      muxer,
      ...(media.duration === undefined ? {} : { duration: media.duration }),
      ...(subtitles === undefined ? {} : { subtitles }),
      ...(audioLanguage === undefined ? {} : { audio_language: audioLanguage }),
      ...(isDash && selected?.audio_id !== undefined ? { audio_track_id: selected.audio_id } : {}),
    });
  }

  if (media.type === "http_playlist") {
    const entry =
      media.playlist?.[
        typeof input.preferredEntry === "number" && Number.isInteger(input.preferredEntry) && input.preferredEntry >= 0
          ? input.preferredEntry
          : 0
      ] ?? media.playlist?.[0];
    const video = entry?.av?.video;
    if (entry === undefined || video === undefined || video === false) {
      return err("http media item is missing its video URL");
    }
    // F33/F30: the js-fetch branch needs a known container demuxer with byte-range support,
    // or an flv whose size is unknown (Zv, svc:9945-9952).
    const libavDemuxer = media.libav_demuxer;
    const canJsFetch =
      (libavDemuxer !== undefined && VIDEO_CONTAINERS.has(libavDemuxer) && media.supports_byte_ranges === true) ||
      (media.extension === "flv" && entry.size === undefined);

    if (input.audioOnly) {
      return ok<DownloadPlan>({
        ...base,
        will_use_jsfetch: true,
        strategy: "http_strip_audio_jsfetch",
        url: video,
        extension: "mp3",
        muxer: "mp3",
      });
    }
    const sourceDemuxer = entry.demuxer;
    const hasAudio = entry.av?.audio !== undefined && entry.av.audio !== false;
    // WebM can hold VP8/VP9 video with Opus/Vorbis audio, but Instagram's DASH audio track is
    // AAC. Copying that pair into WebM needs an Opus re-encode, which repeatedly traps the
    // single-thread ffmpeg.wasm core. Use Matroska for mixed WebM/AAC pairs; it copies both
    // streams unchanged. A video-only WebM stays WebM.
    const jsFetchContainer =
      input.preferredAvMuxer === "mkv"
        ? "mkv"
        : sourceDemuxer === "webm"
          ? hasAudio
            ? "mkv"
            : "webm"
          : libavDemuxer !== undefined && VIDEO_CONTAINERS.has(libavDemuxer)
            ? extensionForDemuxer(libavDemuxer, input.preferredAvMuxer)
            : input.preferredAvMuxer;
    const sizeField = entry.size === undefined ? {} : { size: entry.size };
    if (canJsFetch) {
      const audio = entry.av?.audio;
      if (audio !== undefined && audio !== false) {
        return ok<DownloadPlan>({
          ...base,
          will_use_jsfetch: true,
          strategy: "http_audio_video_two_sources_jsfetch",
          url: video,
          url_audio: audio,
          extension: jsFetchContainer,
          muxer: jsFetchContainer,
          source_demuxer: sourceDemuxer,
          ...sizeField,
          ...(media.duration === undefined ? {} : { duration: media.duration }),
        });
      }
      return ok<DownloadPlan>({
        ...base,
        will_use_jsfetch: true,
        strategy: "http_audio_video_one_source_jsfetch",
        url: video,
        extension: jsFetchContainer,
        muxer: jsFetchContainer,
        source_demuxer: sourceDemuxer,
        ...sizeField,
      });
    }
    const extension = media.extension ?? "mp4";
    return ok<DownloadPlan>({
      ...base,
      will_use_jsfetch: false,
      strategy: "http_audio_video_one_source",
      url: video,
      extension,
      // Deviation: the shipped producer omitted this field; DownloadPlan requires it.
      muxer: extension,
      source_demuxer: sourceDemuxer,
      ...sizeField,
    });
  }

  if (media.type === "youtube_format") {
    const selected = selectPlaylistEntry(media, input.preferredQuality);
    if (selected === undefined) return err("youtube media item has no formats");
    const av = selected.entry.av;
    if (av === undefined) return err("youtube format is missing its av sources");
    const subtitles = selectSubtitleTrack(media.subtitles, input.subtitleLanguages);
    const contentLength = selected.entry.size;
    const durationField = media.duration === undefined ? {} : { duration: media.duration };
    const audioLanguageField =
      selected.entry.audio_language === undefined ? {} : { audio_language: selected.entry.audio_language };
    const contentLengthField = contentLength === undefined ? {} : { content_length: contentLength };

    if (av.video === false) {
      if (av.audio === false) return err("youtube format has neither audio nor video");
      return ok<DownloadPlan>({
        ...base,
        will_use_jsfetch: false,
        strategy: "youtube_audio_only",
        muxer: "mp3",
        url: av.audio,
        extension: "mp3",
        ...durationField,
        ...audioLanguageField,
        ...contentLengthField,
      });
    }
    if (input.audioOnly) {
      return ok<DownloadPlan>({
        ...base,
        will_use_jsfetch: false,
        strategy: "youtube_audio_only",
        muxer: "mp3",
        url: av.audio === false ? av.video : av.audio,
        extension: "mp3",
        ...durationField,
        ...audioLanguageField,
        ...contentLengthField,
      });
    }
    const container = extensionForDemuxer(selected.entry.demuxer, input.preferredAvMuxer);
    if (av.audio !== false) {
      return ok<DownloadPlan>({
        ...base,
        will_use_jsfetch: false,
        strategy: "youtube_audio_video_two_sources",
        muxer: container,
        url: av.video,
        url_audio: av.audio,
        extension: container,
        ...durationField,
        ...audioLanguageField,
        ...contentLengthField,
        ...(contentLength === undefined ? {} : { audio_content_length: contentLength }),
        ...(subtitles === undefined ? {} : { subtitles }),
      });
    }
    return ok<DownloadPlan>({
      ...base,
      will_use_jsfetch: false,
      strategy: "youtube_audio_video_one_source",
      muxer: container,
      url: av.video,
      extension: container,
      ...durationField,
      ...audioLanguageField,
      ...contentLengthField,
      ...(subtitles === undefined ? {} : { subtitles }),
    });
  }

  return err(`unsupported media type for plan building: ${media.type}`);
}
