/**
 * Output container/codec decision and remux boundary.
 *
 * Evidence: `analysis/evidence/04-download-transfer.md`
 *  - E24 — container mapping helpers (`Nm`/`Rm`/`it`/`fv`/`Gn`) and codec tables `gv`/`hv`
 *    (service__main.js.pretty.js lines 7263-7303). The codec tables and extension lists live in
 *    `src/discovery/classify.ts` (detect-analyst); this module imports them instead of copying.
 *  - E25 — strategy → container truth table, including audio-only (always MP3 transcode) and the
 *    progressive single-request route (`http_audio_video_one_source`) which saves source bytes
 *    verbatim without remuxing.
 *  - E21 — audio-only is a transcode (`libmp3lame`, 128 kbps, 44.1 kHz for the JS HLS path);
 *    everything else libav touches is packet/variant copy (`-c copy`).
 *  - E21/`muxer == "mkv" ? "matroska" : muxer` (download_worker lines 4309, 4403).
 */
import {
  AUDIO_EXTENSIONS,
  AUDIO_CODEC_DEMUXER_ROWS,
  CODEC_DEMUXER_ROWS,
  VIDEO_CODEC_DEMUXER_ROWS,
  VIDEO_EXTENSIONS,
  codecToDemuxer,
  containerToMuxer,
} from "../discovery/classify.js";
import { TransferStrategy } from "../core/types.js";

export {
  AUDIO_EXTENSIONS,
  AUDIO_CODEC_DEMUXER_ROWS,
  CODEC_DEMUXER_ROWS,
  VIDEO_CODEC_DEMUXER_ROWS,
  VIDEO_EXTENSIONS,
  codecToDemuxer,
};

/** The user's preferred container for mp4-family inputs (settings `preferred_av_muxer`). */
export type PreferredMuxer = "mp4" | "mkv";

/** Audio-only output always becomes MP3, transcoded (`libmp3lame`). Evidence E25/E21. */
export const AUDIO_ONLY_EXTENSION = "mp3";
export const AUDIO_ONLY_TRANSCODE = {
  codec: "mp3",
  sampleRate: 44_100,
  bitrateKbps: 128,
} as const;

export interface AudioTranscode {
  codec: "mp3";
  sampleRate: number;
  bitrateKbps: number;
}

/** Outcome of the container decision. */
export interface OutputDecision {
  /** File extension appended by the saver. */
  extension: string;
  /** Muxer/container name handed to libav (`mp4`, `mkv`, `mp3`); see {@link muxerFormatName}. */
  muxer: string;
  /** `false` only for the verbatim progressive-HTTP copy route. */
  remux: boolean;
  /** Present when the output is an audio-only MP3 transcode rather than a copy. */
  audioTranscode?: AudioTranscode;
}

export interface DecideOutputInput {
  /** Source container demuxer (`mp4`, `webm`, `mkv`, or an audio demuxer). */
  demuxer: string;
  preferredMuxer: PreferredMuxer;
  /** The "download audio only" action was chosen. */
  audioOnly: boolean;
  /** Plan transport: `true` ⇒ libav `jsfetch:` does the HTTP work. */
  willUseJsFetch: boolean;
  /**
   * Transfer strategy. The only route that skips remuxing entirely is the progressive
   * single-request strategy `http_audio_video_one_source` (E21/E25).
   */
  strategy?: TransferStrategy;
  /** Source extension for the direct-copy route (plan `extension`). Falls back to `demuxer`. */
  sourceExtension?: string;
}

/** The one strategy whose bytes are written verbatim (E25). */
export const DIRECT_COPY_STRATEGY: TransferStrategy =
  TransferStrategy.HttpAudioVideoOneSource;

/** `it()`/`fv()` semantics via the shared discovery table; throws `Unreachable` like the original. */
export function muxerForDemuxer(
  demuxer: string,
  preferredMuxer: PreferredMuxer,
): string {
  if (!(VIDEO_EXTENSIONS as readonly string[]).includes(demuxer)) {
    // `it()` was only ever called for video containers; audio inputs are handled by audioOnly.
    throw new Error("Unreachable");
  }
  return containerToMuxer(demuxer, preferredMuxer);
}

const isAudioContainer = (value: string): boolean =>
  (AUDIO_EXTENSIONS as readonly string[]).includes(value);

/**
 * The proven container/remux truth table (E25):
 *
 * | input                                                   | extension        | remux |
 * |---------------------------------------------------------|------------------|-------|
 * | audio-only action                                       | mp3 (transcode)  | yes   |
 * | progressive `http_audio_video_one_source`               | source extension | no    |
 * | mp4 source                                              | preferred muxer  | yes   |
 * | webm / mkv source                                       | mkv              | yes   |
 *
 * Unknown video containers throw `Unreachable`, mirroring `it()`.
 */
export function decideOutput(input: DecideOutputInput): OutputDecision {
  if (input.audioOnly) {
    return {
      extension: AUDIO_ONLY_EXTENSION,
      muxer: AUDIO_ONLY_EXTENSION,
      remux: true,
      audioTranscode: { ...AUDIO_ONLY_TRANSCODE },
    };
  }

  if (input.strategy === DIRECT_COPY_STRATEGY) {
    const extension = input.sourceExtension ?? input.demuxer;
    if (!extension) throw new Error("Unreachable");
    return { extension, muxer: input.demuxer, remux: false };
  }

  if (isAudioContainer(input.demuxer)) {
    // Non-audio-only plan with an audio demuxer cannot happen in the recovered builders: they set
    // the audio-only flag whenever the demuxer is an audio container (E26). Treat it as the
    // MP3 transcode rather than silently producing a video plan with an audio container.
    return {
      extension: AUDIO_ONLY_EXTENSION,
      muxer: AUDIO_ONLY_EXTENSION,
      remux: true,
      audioTranscode: { ...AUDIO_ONLY_TRANSCODE },
    };
  }

  const muxer = muxerForDemuxer(input.demuxer, input.preferredMuxer);
  return { extension: muxer, muxer, remux: true };
}

/** Whether the decision requires libav (i.e. anything except the direct-copy route). */
export function shouldRemux(decision: OutputDecision): boolean {
  return decision.remux;
}

/** `true` when bytes are saved verbatim with no libav involvement (E21 progressive copy). */
export function isDirectCopy(decision: OutputDecision): boolean {
  return !decision.remux;
}

/**
 * libav muxer name for a decision. The worker rewrites `mkv` to `matroska`; `mp4` and `mp3` pass
 * through (E21; download_worker lines 2135-2141, 4309, 4403).
 */
export function muxerFormatName(muxer: string): string {
  return muxer === "mkv" ? "matroska" : muxer;
}

/** Blob MIME type for the saved file, when the browser needs one (E20, download_worker 2132-2142). */
export function blobMimeType(extension: string): string | undefined {
  if (extension === "mkv") return "video/x-matroska";
  if (extension === "flv") return "video/x-flv";
  return undefined;
}

/** Convenience: remux is needed for every strategy except the progressive copy (E25). */
export function strategyNeedsRemux(strategy: TransferStrategy): boolean {
  return strategy !== DIRECT_COPY_STRATEGY;
}
