/**
 * Offscreen download worker (module worker).
 *
 * Evidence: 04-download-transfer.md Â§2.1-Â§2.3 and 01-messaging-runtime.md Â§2. The original
 * worker answers `is_ready` on `BroadcastChannel("worker_service")`, receives serde-encoded
 * download plans (`download`), fetches/assembles them (HLS segment path or libav js-fetch path),
 * stages the output in OPFS, then posts `download_result` with a blob URL, or `download_error`.
 *
 * The worker assembles progressive HTTP responses and HLS segment lists, with FFmpeg used for
 * remuxing, muxing, and format conversion. DASH segment resolution is not implemented, so those
 * plans are rejected before any transfer rather than producing a broken file.
 */
import { Channel } from "../protocol/channels.js";
import { MSG, type DownloadProgressPayload } from "../protocol/messages.js";
import { RELAY_MESSAGES } from "../protocol/rebuild-messages.js";
import { decode } from "../protocol/serde.js";
import type { BroadcastChannelLike } from "./gateways.js";
import type { DownloadPlan, DownloadProgress, TransferOutcome } from "../core/types.js";
import { httpFailureReason, isHlsStrategy, otherFailureReason } from "../core/types.js";
import { err, ok, type Result } from "../core/option.js";
import { MAX_HLS_MANIFEST_BYTES, parsePlaylist } from "../manifests/hls.js";
import {
  MAX_FAILED_SEGMENT_RATIO,
  MIN_OUTPUT_BYTES,
  buildSegmentRequests,
  classifySegmentFailure,
  computePercent,
  concatenate,
  isTooManyFailedSegments,
} from "../transfer/assemble.js";
import type { HlsInitSegment, HlsSegment as TransferSegment, SegmentDescriptor } from "../transfer/assemble.js";
import type { HlsSegment as ParsedSegment } from "../manifests/hls.js";
import { headersForPlan, fetchBytes, scopedHeadersFor, type FetchLike } from "../transfer/fetch.js";
import { RANGE_CHUNK_BYTES, fetchRanged, isRangeBoundCdn } from "../transfer/ranged.js";
import { muxFragmentedMp4 } from "../transfer/mux-fmp4.js";
import { normalizeMediaOutputExtension } from "../transfer/sniff.js";
import { convertArgs, mergeArgs, mp3Args, type FfmpegRunnerLike } from "../transfer/ffmpeg.js";
import { sleepWithAbort } from "../transfer/retry.js";
import { isSafeSegmentUrl } from "../transfer/url-safety.js";
import {
  createStagedFile,
  openOpfsRoot,
  purgeStaging,
  removeStagedFile,
  type OpfsRoot,
  type StagedFile,
} from "./staging.js";

/** Segment fetch concurrency proven in the original (semaphore 4, 1 when throttled). */
export const SEGMENT_CONCURRENCY = 4;
export const THROTTLED_SEGMENT_CONCURRENCY = 1;
/** Progress is pushed at most twice per second. */
export const PROGRESS_INTERVAL_MS = 500;

/** In-browser transcode budget: beyond this, VP8/x264 conversion is far slower than a download. */
const MAX_TRANSCODE_SECONDS = 180;
/** ffmpeg.wasm single-thread has a 2 GiB heap; keep the combined MEMFS inputs well below it. */
const MAX_FFMPEG_INPUT_BYTES = 600 * 1024 * 1024;

function extensionForUrl(url: URL): string | undefined {
  const match = /\.(mp4|m4v|m4a|webm|mkv|mov|mp3|ogg|ts)(?:[?#]|$)/iu.exec(url.pathname);
  return match?.[1]?.toLowerCase();
}

export interface DownloadWorkerDeps {
  channel: BroadcastChannelLike;
  fetchImpl: FetchLike;
  /** OPFS root; when absent the worker reports a staging error. */
  openRoot: () => Promise<OpfsRoot | undefined>;
  now?: () => number;
  /** ffmpeg.wasm runner for 1080p+/4K merges and MP4/MKV/WebM/MP3 outputs. */
  ffmpeg?: FfmpegRunnerLike;
}

interface ActiveDownload {
  controller: AbortController;
  lastProgressAt: number;
}

export class DownloadWorker {
  private readonly deps: DownloadWorkerDeps;
  private readonly active = new Map<string, ActiveDownload>();
  /** In-progress page-relay transfers (chunks streamed from a content script). */
  private readonly relay = new Map<string, { staged: StagedFile; plan: DownloadPlan; bytes: number }>();
  private readonly now: () => number;

  constructor(deps: DownloadWorkerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Announce readiness and start serving the worker channel. */
  start(): void {
    this.post(MSG.worker.IsReadySuccess, null, Channel.FromWorkerToService);
    this.deps.channel.addEventListener("message", (event) => {
      void this.onMessage(event.data);
    });
  }

  private async onMessage(raw: unknown): Promise<void> {
    const envelope = raw as { msg?: { name?: string; data?: unknown }; channel?: number };
    if (!envelope?.msg) return;
    if (envelope.channel === Channel.FromServiceToWorker) {
      if (envelope.msg.name === MSG.worker.IsReady) {
        this.post(MSG.worker.IsReadySuccess, null, Channel.FromWorkerToService);
        return;
      }
      if (envelope.msg.name === MSG.worker.Download) {
        await this.onDownload(envelope.msg.data);
        return;
      }
      if (envelope.msg.name === RELAY_MESSAGES.WorkerRelayStart) {
        const relayData = envelope.msg.data;
        this.enqueueRelay(() => this.onRelayStart(relayData));
        return;
      }
      if (envelope.msg.name === RELAY_MESSAGES.WorkerRelayChunk) {
        const relayData = envelope.msg.data;
        this.enqueueRelay(() => this.onRelayChunk(relayData));
        return;
      }
      if (envelope.msg.name === RELAY_MESSAGES.WorkerRelayEnd) {
        const relayData = envelope.msg.data;
        this.enqueueRelay(() => this.onRelayEnd(relayData));
        return;
      }
      if (envelope.msg.name === RELAY_MESSAGES.WorkerRelayAbort) {
        const relayData = envelope.msg.data;
        this.enqueueRelay(() => this.onRelayAbort(relayData));
        return;
      }
      if (envelope.msg.name === MSG.worker.AbortDownload) {
        const data = envelope.msg.data as { download_id: string };
        this.active.get(data.download_id)?.controller.abort();
        return;
      }
      if (envelope.msg.name === MSG.worker.RevokeBlobUrl) {
        const data = envelope.msg.data as { blob_url: string };
        URL.revokeObjectURL(data.blob_url);
      }
    }
  }

  private async onDownload(data: unknown): Promise<void> {
    const payload = data as { download_args: unknown };
    let plan: DownloadPlan;
    try {
      plan = decode(payload.download_args) as DownloadPlan;
    } catch (error) {
      this.post(MSG.worker.DownloadError, { download_id: "unknown", error: String(error) }, Channel.FromWorkerToService);
      return;
    }
    const controller = new AbortController();
    this.active.set(plan.download_id, { controller, lastProgressAt: 0 });
    this.emitProgress(plan.download_id, { status: "downloading" });
    try {
      const outcome = await this.runPlan(plan, controller.signal);
      if (outcome.tag === "Ok") {
        this.emitProgress(plan.download_id, { status: "finalizing" });
        this.post(MSG.worker.DownloadResult, outcome.value, Channel.FromWorkerToService);
      } else {
        this.post(
          MSG.worker.DownloadError,
          { download_id: plan.download_id, error: outcome.error },
          Channel.FromWorkerToService,
        );
      }
    } catch (error) {
      this.post(
        MSG.worker.DownloadError,
        { download_id: plan.download_id, error: String(error) },
        Channel.FromWorkerToService,
      );
    } finally {
      this.active.delete(plan.download_id);
    }
  }

  /** Relay messages must run in arrival order (append then finish); they arrive on one channel. */
  private relayQueue: Promise<void> = Promise.resolve();

  private enqueueRelay(task: () => Promise<void>): void {
    this.relayQueue = this.relayQueue.then(task).catch((error) => {
      console.warn("[media-downloader] relay task failed", error);
    });
  }

  private async onRelayStart(raw: unknown): Promise<void> {
    const payload = raw as { download_args?: unknown };
    let plan: DownloadPlan;
    try {
      plan = decode(payload.download_args) as DownloadPlan;
    } catch (error) {
      this.post(MSG.worker.DownloadError, { download_id: "unknown", error: String(error) }, Channel.FromWorkerToService);
      return;
    }
    const root = await this.deps.openRoot();
    if (!root) {
      this.post(MSG.worker.DownloadError, { download_id: plan.download_id, error: "staging unavailable" }, Channel.FromWorkerToService);
      return;
    }
    const extension = plan.extension || "mp4";
    const staged = await createStagedFile(root, `${plan.download_id}.${extension}`);
    this.relay.set(plan.download_id, { staged, plan, bytes: 0 });
    this.emitProgress(plan.download_id, { status: "downloading", fetched_bytes_count: 0 });
  }

  private async onRelayChunk(raw: unknown): Promise<void> {
    const payload = raw as { download_id?: string; data?: unknown };
    if (payload.download_id === undefined) return;
    const entry = this.relay.get(payload.download_id);
    if (!entry) return;
    const chunk = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data as ArrayBufferLike);
    await entry.staged.append(chunk);
    entry.bytes += chunk.byteLength;
    this.emitProgress(payload.download_id, {
      status: "downloading",
      fetched_bytes_count: entry.bytes,
      percent: { is_known: false, value: 0 },
    });
  }

  private async onRelayEnd(raw: unknown): Promise<void> {
    const payload = raw as { download_id?: string };
    if (payload.download_id === undefined) return;
    const entry = this.relay.get(payload.download_id);
    if (!entry) return;
    this.relay.delete(payload.download_id);
    try {
      if (entry.bytes < MIN_OUTPUT_BYTES) {
        const detail = `relayed response too small (${entry.bytes} bytes)`;
        console.warn("[media-downloader] relay too small", detail);
        await entry.staged.abort().catch(() => undefined);
        this.post(
          MSG.worker.DownloadError,
          { download_id: payload.download_id, error: detail },
          Channel.FromWorkerToService,
        );
        return;
      }
      const finished = await entry.staged.finish();
      this.emitProgress(payload.download_id, { status: "finalizing", fetched_bytes_count: entry.bytes });
      this.post(
        MSG.worker.DownloadResult,
        {
          download_id: payload.download_id,
          internal_filename: finished.filename,
          internal_bloburl: finished.blobUrl,
          output_extension: entry.plan.extension || "mp4",
          ending_reason: {
            user_abort: false,
            e4XX_5XX_failure: false,
            percentage_incomplete: false,
            other_failure: false,
          },
        },
        Channel.FromWorkerToService,
      );
    } catch (error) {
      this.post(
        MSG.worker.DownloadError,
        { download_id: payload.download_id, error: String(error) },
        Channel.FromWorkerToService,
      );
    }
  }

  private async onRelayAbort(raw: unknown): Promise<void> {
    const payload = raw as { download_id?: string };
    if (payload.download_id === undefined) return;
    const entry = this.relay.get(payload.download_id);
    this.relay.delete(payload.download_id);
    if (entry) await entry.staged.abort().catch(() => undefined);
    this.post(
      MSG.worker.DownloadError,
      { download_id: payload.download_id, error: "aborted" },
      Channel.FromWorkerToService,
    );
  }

  /** Best-effort native container from a direct URL path. */
  /** Fetch one whole track (bounded ranges for googlevideo-style URLs). */
  private async fetchSourceBytes(
    url: URL,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, string>> {
    if (isRangeBoundCdn(url)) {
      const ranged = await fetchRanged(this.deps.fetchImpl, url, headers, { signal });
      if (ranged.tag === "Err") {
        const status = ranged.error.status !== undefined ? ` ${ranged.error.status}` : "";
        return err(`${ranged.error.kind}${status}: ${ranged.error.message ?? "download failed"}`);
      }
      return ok(ranged.value.bytes);
    }
    const fetched = await fetchBytes(this.deps.fetchImpl, url.href, { headers }, { signal });
    if (fetched.tag === "Err") {
      const status = fetched.error.status !== undefined ? ` ${fetched.error.status}` : "";
      return err(`${fetched.error.kind}${status}: ${fetched.error.message ?? "download failed"}`);
    }
    return ok(fetched.value.bytes);
  }

  /** Stage a direct download without retaining a second complete copy in memory. */
  private async streamDirect(
    root: OpfsRoot,
    plan: DownloadPlan,
    headers: Headers,
    sourceExtension: string,
    signal?: AbortSignal,
  ): Promise<Result<TransferOutcome, string>> {
    let extension = sourceExtension;
    let staged: StagedFile | undefined;
    let total = 0;
    let totalSize = plan.size !== undefined && Number.isFinite(plan.size) && plan.size > 0
      ? plan.size
      : undefined;
    const downloadingProgress = (fetchedBytes: number): DownloadProgress => ({
      status: "downloading",
      fetched_bytes_count: fetchedBytes,
      ...(totalSize !== undefined
        ? { percent: { is_known: true, value: Math.min(100, fetchedBytes / totalSize * 100) } }
        : {}),
    });
    const onChunk = async (chunk: Uint8Array): Promise<void> => {
      if (staged === undefined) {
        extension = normalizeMediaOutputExtension(extension, chunk, true);
        staged = await createStagedFile(root, `${plan.download_id}.${extension}`);
      }
      await staged.append(chunk);
      total += chunk.byteLength;
      this.emitProgress(plan.download_id, downloadingProgress(total));
    };
    const onTotalSize = (size: number): void => {
      totalSize = size;
    };
    try {
      if (isRangeBoundCdn(plan.url)) {
        const ranged = await fetchRanged(this.deps.fetchImpl, plan.url, headers, {
          signal,
          onChunk,
          onBytes: (fetched) => {
            this.emitProgress(plan.download_id, downloadingProgress(fetched));
          },
        });
        if (ranged.tag === "Err") {
          if (staged !== undefined) await staged.abort().catch(() => undefined);
          const status = ranged.error.status !== undefined ? ` ${ranged.error.status}` : "";
          return err(`ranged ${ranged.error.kind}${status}: ${ranged.error.message ?? "download failed"}`);
        }
      } else {
        const directUrl = plan.url.href;
        let fetched = await fetchBytes(
          this.deps.fetchImpl,
          directUrl,
          { headers },
          { signal, onChunk, onTotalSize },
        );
        if (
          fetched.tag === "Err" &&
          total === 0 &&
          fetched.error.kind === "http" &&
          [400, 401, 403, 416].includes(fetched.error.status ?? 0)
        ) {
          console.info("[media-downloader] retrying direct request with Range: bytes=0-", directUrl);
          fetched = await fetchBytes(
            this.deps.fetchImpl,
            directUrl,
            { headers, range: "bytes=0-" },
            { signal, onChunk, onTotalSize },
          );
        }
        if (fetched.tag === "Err") {
          if (staged !== undefined) await staged.abort().catch(() => undefined);
          const status = fetched.error.status !== undefined ? ` ${fetched.error.status}` : "";
          return err(`${fetched.error.kind}${status}: ${fetched.error.message ?? "download failed"} (${directUrl})`);
        }
      }
      if (total < MIN_OUTPUT_BYTES || staged === undefined) {
        if (staged !== undefined) await staged.abort().catch(() => undefined);
        return err(`direct response too small (${total} bytes)`);
      }
      const finished = await staged.finish();
      this.emitProgress(plan.download_id, { status: "finalizing", fetched_bytes_count: total });
      console.info("[media-downloader] direct transfer ok", total, "bytes", plan.url.href);
      return ok({
        download_id: plan.download_id,
        internal_filename: finished.filename,
        internal_bloburl: finished.blobUrl,
        output_extension: extension,
        ending_reason: {
          user_abort: false,
          e4XX_5XX_failure: false,
          percentage_incomplete: false,
          other_failure: false,
        },
      } as TransferOutcome);
    } catch (error) {
      if (staged !== undefined) await staged.abort().catch(() => undefined);
      return err(String(error));
    }
  }

  /** Execute one plan into a staged file and a blob URL. */
  async runPlan(plan: DownloadPlan, signal?: AbortSignal): Promise<Result<TransferOutcome, string>> {
    const root = await this.deps.openRoot();
    if (!root) return err("staging unavailable");
    const headers = headersForPlan(plan.headers);

    if (plan.strategy.startsWith("mpd_")) {
      return err("DASH downloads require segment resolution, which is not supported yet");
    }

    let bytes = new Uint8Array();
    // Produced (source) extension; plan.extension is the *requested* target and may differ.
    let extension = plan.source_demuxer ?? extensionForUrl(plan.url) ?? plan.extension ?? "bin";
    let duration: number | undefined = typeof plan.duration === "number" ? plan.duration : undefined;

    if (plan.url_audio) {
      if (!isHlsStrategy(plan.strategy)) {
        // Direct adaptive tracks (YouTube): download both, then merge with ffmpeg when available.
        const target = plan.extension || "mp4";
        const ffmpeg = this.deps.ffmpeg;
        if (target === "mp3") {
          const audioOnly = await this.fetchSourceBytes(plan.url_audio, headers, signal);
          if (audioOnly.tag === "Err") return audioOnly;
          if (!ffmpeg) return err("ffmpeg unavailable: audio extraction unsupported");
          if (audioOnly.value.byteLength < MIN_OUTPUT_BYTES) {
            return err(`audio track too small (${audioOnly.value.byteLength} bytes)`);
          }
          this.emitProgress(plan.download_id, { status: "finalizing" });
          bytes = await ffmpeg.run({
            inputs: [{ name: "audio.m4a", bytes: audioOnly.value }],
            args: mp3Args("audio.m4a", "out.mp3"),
            outputName: "out.mp3",
          });
          extension = "mp3";
          console.info("[media-downloader] ffmpeg extracted mp3", bytes.byteLength, "bytes");
        } else {
          const videoBytes = await this.fetchSourceBytes(plan.url, headers, signal);
          if (videoBytes.tag === "Err") return videoBytes;
          const audioBytes = await this.fetchSourceBytes(plan.url_audio, headers, signal);
          if (audioBytes.tag === "Err") return audioBytes;
          if (!ffmpeg) {
            const muxed = muxFragmentedMp4(videoBytes.value, audioBytes.value);
            if (!muxed) return err("audio/video muxing: inputs are not fragmented MP4");
            if (muxed.byteLength < MIN_OUTPUT_BYTES) return err(`muxed output too small (${muxed.byteLength} bytes)`);
            bytes = muxed;
            extension = "mp4";
            console.info("[media-downloader] muxed adaptive tracks", bytes.byteLength, "bytes");
          } else {
            if (videoBytes.value.byteLength + audioBytes.value.byteLength > MAX_FFMPEG_INPUT_BYTES) {
              return err("rendition is too large for in-browser FFmpeg (2 GiB heap); pick a lower quality");
            }
            const container = target === "webm" ? "webm" : target === "mkv" ? "mkv" : "mp4";
            const sourceIsWebm = (plan.source_demuxer ?? "") === "webm";
            if (container === "webm" && !sourceIsWebm) {
              return err("WebM output needs a WEBM quality; choose a WEBM rendition or keep Auto");
            }
            const outputName = `out.${container}`;
            const runMerge = (transcode: boolean): Promise<Uint8Array> => {
              const args = mergeArgs("video.bin", "audio.bin", outputName, container, transcode);
              console.info(
                "[media-downloader] ffmpeg merge",
                container,
                "video",
                videoBytes.value.byteLength,
                "audio",
                audioBytes.value.byteLength,
                args.join(" "),
              );
              return ffmpeg.run({
                inputs: [
                  { name: "video.bin", bytes: videoBytes.value },
                  { name: "audio.bin", bytes: audioBytes.value },
                ],
                args,
                outputName,
              });
            };
            this.emitProgress(plan.download_id, { status: "finalizing" });
            if (container === "webm") {
              // Builder sends mixed WebM/AAC pairs to MKV; a WebM plan here should already be
              // VP8/VP9 + Opus/Vorbis, so copy both streams and never invoke libopus.
              try {
                bytes = await runMerge(false);
              } catch (error) {
                return err(`WebM mux failed; keep Auto to copy mixed audio into MKV: ${String(error)}`);
              }
            } else {
              try {
                bytes = await runMerge(false);
              } catch (error) {
                // Copy can fail for mixed codec families; one transcode retry is cheaper than failing.
                if (container === "mkv") return err(`ffmpeg merge failed: ${String(error)}`);
                if ((duration ?? 0) > MAX_TRANSCODE_SECONDS) {
                  return err(`ffmpeg merge failed and transcoding is limited to 3-minute clips: ${String(error)}`);
                }
                bytes = await runMerge(true);
              }
            }
            extension = container;
            console.info("[media-downloader] ffmpeg merged tracks", bytes.byteLength, "bytes", container);
          }
        }
      } else {
      const videoAssembled = await this.assembleHls(plan, headers, signal);
      if (videoAssembled.tag === "Err") return videoAssembled;
      const audioPlan = { ...plan, url: plan.url_audio };
      const audioAssembled = await this.assembleHls(audioPlan, headers, signal);
      if (audioAssembled.tag === "Err") return audioAssembled;
      const ffmpeg = this.deps.ffmpeg;
      if (ffmpeg !== undefined) {
        const container = plan.extension === "webm" ? "webm" : plan.extension === "mkv" ? "mkv" : "mp4";
        const sourceDemuxer = plan.source_demuxer ?? videoAssembled.value.extension;
        if (container === "webm" && sourceDemuxer !== "webm") {
          return err("WebM output needs a WEBM HLS rendition; choose a WEBM quality or keep Auto");
        }
        const outputName = `out.${container}`;
        this.emitProgress(plan.download_id, { status: "finalizing" });
        bytes = await ffmpeg.run({
          inputs: [
            { name: "video.bin", bytes: videoAssembled.value.bytes },
            { name: "audio.bin", bytes: audioAssembled.value.bytes },
          ],
          args: mergeArgs("video.bin", "audio.bin", outputName, container, false),
          outputName,
        });
        extension = container;
        console.info("[media-downloader] ffmpeg merged HLS tracks", bytes.byteLength, "bytes", container);
      } else {
        const muxed = muxFragmentedMp4(videoAssembled.value.bytes, audioAssembled.value.bytes);
        if (!muxed) return err("audio/video muxing: inputs are not fragmented MP4");
        bytes = muxed;
        extension = "mp4";
        console.info("[media-downloader] muxed audio+video", bytes.byteLength, "bytes");
      }
      duration = videoAssembled.value.duration ?? duration;
      }
    } else if (isHlsStrategy(plan.strategy)) {
      const stream = plan.output_format === undefined || plan.output_format === "mp4"
        ? { root, downloadId: plan.download_id }
        : undefined;
      const assembled = await this.assembleHls(plan, headers, signal, stream);
      if (assembled.tag === "Err") return assembled;
      duration = assembled.value.duration ?? duration;
      extension = assembled.value.extension;
      const staged = assembled.value.staged;
      const shouldRemux = extension === "m2ts" && plan.output_format === "mp4";
      if (shouldRemux && this.deps.ffmpeg === undefined) {
        await staged?.abort();
        return err("MP4 conversion requires FFmpeg. Choose M2TS to keep the original stream.");
      }
      const finished = staged !== undefined ? await staged.finish() : undefined;
      if (finished !== undefined && !shouldRemux) {
        this.emitProgress(plan.download_id, {
          status: "finalizing",
          fetched_bytes_count: assembled.value.totalBytes,
        });
        return ok({
          download_id: plan.download_id,
          internal_filename: finished.filename,
          internal_bloburl: finished.blobUrl,
          output_extension: extension,
          ending_reason: {
            user_abort: false,
            e4XX_5XX_failure: false,
            percentage_incomplete: false,
            other_failure: false,
          },
        } as TransferOutcome);
      }

      if (!shouldRemux || finished === undefined) {
        bytes = finished !== undefined
          ? new Uint8Array(await finished.file.arrayBuffer())
          : assembled.value.bytes;
      }
      // WORKERFS reads a staged File directly, so large inputs do not fill FFmpeg's memory filesystem.
      if (shouldRemux) {
        try {
          const remuxed = await this.deps.ffmpeg?.run({
            inputs: [{ name: "input.m2ts", ...(finished !== undefined ? { file: finished.file } : { bytes }) }],
            args: ["-hide_banner", "-y", "-i", "input.m2ts", "-map", "0", "-c", "copy", "-movflags", "+faststart", "output.mp4"],
            outputName: "output.mp4",
          });
          if (remuxed === undefined || remuxed.byteLength < MIN_OUTPUT_BYTES) {
            throw new Error("FFmpeg produced an empty MP4");
          }
          bytes = remuxed;
          extension = "mp4";
          console.info("[media-downloader] remuxed HLS TS to mp4", bytes.byteLength, "bytes");
        } catch (error) {
          if (finished !== undefined) {
            URL.revokeObjectURL(finished.blobUrl);
            await removeStagedFile(root, finished.filename).catch(() => undefined);
          }
          return err(`MP4 remux failed: ${String(error)}`);
        }
      }
      if (finished !== undefined) {
        if (extension === "m2ts") {
          return ok({
            download_id: plan.download_id,
            internal_filename: finished.filename,
            internal_bloburl: finished.blobUrl,
            output_extension: extension,
            ending_reason: {
              user_abort: false,
              e4XX_5XX_failure: false,
              percentage_incomplete: false,
              other_failure: false,
            },
          } as TransferOutcome);
        }
        URL.revokeObjectURL(finished.blobUrl);
        await removeStagedFile(root, finished.filename).catch(() => undefined);
      }
    } else if (plan.output_format === undefined) {
      return this.streamDirect(root, plan, headers, extension, signal);
    } else if (isRangeBoundCdn(plan.url)) {
      // googlevideo rejects plain GETs and open-ended ranges; the player itself uses bounded
      // byte ranges, so download the file as sequential 2 MiB chunks (live probe evidence).
      const ranged = await fetchRanged(this.deps.fetchImpl, plan.url, headers, {
        signal,
        onBytes: (fetched) => {
          this.emitProgress(plan.download_id, {
            status: "downloading",
            fetched_bytes_count: fetched,
          });
        },
      });
      if (ranged.tag === "Err") {
        const status = ranged.error.status !== undefined ? ` ${ranged.error.status}` : "";
        const detail = `ranged ${ranged.error.kind}${status}: ${ranged.error.message ?? "download failed"} headers=[${[...headers.keys()].join(",")}] chunk=${RANGE_CHUNK_BYTES} (${plan.url.href})`;
        console.warn("[media-downloader] ranged transfer failed", detail);
        return err(detail);
      }
      bytes = ranged.value.bytes;
      if (bytes.byteLength < MIN_OUTPUT_BYTES) {
        const detail = `direct response too small (${bytes.byteLength} bytes)`;
        console.warn("[media-downloader] direct transfer failed", detail, plan.url.href);
        return err(detail);
      }
      console.info("[media-downloader] ranged transfer ok", bytes.byteLength, "bytes", plan.url.href);
    } else {
      const directUrl = plan.url.href;
      let fetched = await fetchBytes(this.deps.fetchImpl, directUrl, { headers }, { signal });
      // Some CDNs (notably googlevideo) reject plain GETs and expect a byte range.
      if (
        fetched.tag === "Err" &&
        fetched.error.kind === "http" &&
        [400, 401, 403, 416].includes(fetched.error.status ?? 0)
      ) {
        console.info("[media-downloader] retrying direct request with Range: bytes=0-", directUrl);
        fetched = await fetchBytes(
          this.deps.fetchImpl,
          directUrl,
          { headers, range: "bytes=0-" },
          { signal },
        );
      }
      if (fetched.tag === "Err") {
        const status = fetched.error.status !== undefined ? ` ${fetched.error.status}` : "";
        const detail = `${fetched.error.kind}${status}: ${fetched.error.message ?? "download failed"} (${plan.url.href})`;
        console.warn("[media-downloader] direct transfer failed", detail);
        return err(detail);
      }
      bytes = fetched.value.bytes;
      // A tiny 200 response is an error page, not media (live: a 31-byte body was saved).
      if (bytes.byteLength < MIN_OUTPUT_BYTES) {
        const detail = `direct response too small (${bytes.byteLength} bytes)`;
        console.warn("[media-downloader] direct transfer failed", detail, directUrl);
        return err(detail);
      }
      console.info("[media-downloader] direct transfer ok", bytes.byteLength, "bytes", directUrl);
    }

    const requestedFormat = plan.output_format;
    if (requestedFormat !== undefined && extension !== requestedFormat) {
      const ffmpeg = this.deps.ffmpeg;
      if (ffmpeg === undefined) {
        return err(`ffmpeg unavailable: cannot convert ${extension} to ${requestedFormat}`);
      }
      const inputName = `input.${extension.length > 0 ? extension : "bin"}`;
      const outputName = `output.${requestedFormat}`;
      this.emitProgress(plan.download_id, { status: "finalizing" });
      if (requestedFormat === "mp3") {
        bytes = await ffmpeg.run({
          inputs: [{ name: inputName, bytes }],
          args: mp3Args(inputName, outputName),
          outputName,
        });
      } else {
        const sourceIsWebm = (plan.source_demuxer ?? extension) === "webm";
        if (requestedFormat === "webm" && !sourceIsWebm) {
          return err("WebM output needs a WEBM source; choose a WEBM quality or keep Auto");
        }
        const transcode =
          requestedFormat === "webm"
            ? false
            : requestedFormat === "mp4"
              ? extension !== "mp4"
              : false;
        if (transcode && (duration ?? 0) > MAX_TRANSCODE_SECONDS) {
          return err(`converting ${extension} to ${requestedFormat} is limited to 3-minute clips in the browser`);
        }
        bytes = await ffmpeg.run({
          inputs: [{ name: inputName, bytes }],
          args: convertArgs(inputName, outputName, requestedFormat, transcode),
          outputName,
        });
      }
      extension = requestedFormat;
      console.info("[media-downloader] ffmpeg converted output", bytes.byteLength, "bytes", extension);
    }
    if (bytes.byteLength < MIN_OUTPUT_BYTES) {
      return err(`output too small (${bytes.byteLength} bytes)`);
    }
    // Never name a video .txt/.html because a CDN mislabelled it. For Auto keep the sniffed
    // container; explicit output formats keep their requested extension when it is media.
    const normalizedExtension = normalizeMediaOutputExtension(
      extension,
      bytes,
      plan.output_format === undefined,
    );
    if (normalizedExtension !== extension) {
      console.info("[media-downloader] corrected output extension", extension, "->", normalizedExtension);
    }
    extension = normalizedExtension;
    const staged = await createStagedFile(root, `${plan.download_id}.${extension}`);
    try {
      await staged.append(bytes);
      const finished = await staged.finish();
      this.emitProgress(plan.download_id, {
        status: "finalizing",
        fetched_bytes_count: bytes.byteLength,
      });
      return ok({
        // The result must carry the download id so the service can correlate concurrent transfers
        // (proven: the original correlates `download_result` by `download_id`).
        download_id: plan.download_id,
        internal_filename: finished.filename,
        internal_bloburl: finished.blobUrl,
        output_extension: extension,
        ending_reason: { user_abort: false, e4XX_5XX_failure: false, percentage_incomplete: false, other_failure: false },
      } as TransferOutcome);
    } catch (error) {
      await staged.abort();
      return err(String(error));
    }
  }

  private async assembleHls(
    plan: DownloadPlan,
    headers: Headers,
    signal?: AbortSignal,
    stream?: { root: OpfsRoot; downloadId: string },
  ): Promise<Result<{
    bytes: Uint8Array;
    extension: string;
    duration?: number;
    staged?: StagedFile;
    totalBytes: number;
  }, string>> {
    const playlistResult = await this.fetchPlaylistText(plan.url.href, headers, signal);
    if (playlistResult.tag === "Err") {
      // treat "aborted" as user_abort
      return err(playlistResult.error === "aborted" ? "user_abort" : playlistResult.error);
    }
    let parsed = parsePlaylist(playlistResult.value, plan.url);
    if (parsed.kind === "invalid") return err(parsed.reason);

    // Master playlists are normally resolved before planning; resolve defensively anyway.
    if (parsed.kind === "master") {
      const variant = parsed.variants[0];
      if (!variant) return err("empty master playlist");
      const media = await this.fetchPlaylistText(variant.uri.href, headers, signal);
      if (media.tag === "Err") return media;
      parsed = parsePlaylist(media.value, variant.uri);
      if (parsed.kind === "invalid") return err(parsed.reason);
    }
    if (parsed.kind !== "media") return err("playlist is not downloadable");

    const segments = parsed.segments;
    if (segments.length === 0) return err("not a valid m3u8");
    // Encryption boundary: the rebuilt scope has no decrypter. Refuse explicitly instead of
    // saving ciphertext; AES-128 is the only standard scheme the original handled itself, and even
    // there we need a WebCrypto implementation that this rebuild deliberately omits.
    if (segments.some((segment) => segment.key !== undefined)) {
      const methods = new Set(segments.map((segment) => segment.key?.method ?? "NONE"));
      const unsupported = [...methods].filter((method) => method !== "NONE");
      return err(
        unsupported.includes("AES-128")
          ? "AES-128 encrypted HLS is not supported by this rebuild (no decrypter implemented)"
          : `Encrypted HLS is not supported (methods: ${unsupported.join(", ")})`,
      );
    }
    const initSegment = segments.find((segment) => segment.map !== undefined)?.map;
    const descriptors = buildSegmentRequests(toTransferSegments(segments), {
      masterUrl: plan.url,
      carryGetParams: plan.carry_get_params,
      ...(initSegment ? { initSegment: toTransferInit(initSegment) } : {}),
      mediaSequence: parsed.mediaSequence,
    });

    // Reject private-network segments unless same-origin with manifest.
    // Fail fast with a clear error showing only the refused host (not the full URL with tokens).
    const captureOrigin = plan.headers_origin ?? plan.url.origin;
    for (const descriptor of descriptors) {
      const segmentUrl = new URL(descriptor.url);
      if (!isSafeSegmentUrl(segmentUrl, plan.url)) {
        return err(`Segment host ${segmentUrl.hostname} refused by URL-safety gate`);
      }
    }

    // Scope credential-bearing headers by origin: same-origin segments get captured headers,
    // cross-origin segments (legitimate CDN pattern) get empty headers. Precompute once, reuse in loop.
    interface AnnotatedDescriptor extends SegmentDescriptor {
      requestHeaders: Headers;
    }
    const annotatedDescriptors: AnnotatedDescriptor[] = descriptors.map((d) => ({
      ...d,
      requestHeaders: scopedHeadersFor(d.url, captureOrigin, headers),
    }));

    // fMP4 HLS keeps the planned container. Raw MPEG-TS uses m2ts because .ts is also a
    // TypeScript/Qt source extension and browsers may treat it as text.
    const extension = initSegment ? plan.extension || "mp4" : "m2ts";
    const staged = stream === undefined
      ? undefined
      : await createStagedFile(stream.root, `${stream.downloadId}.${extension}`);
    const concurrency = plan.throttle ? THROTTLED_SEGMENT_CONCURRENCY : SEGMENT_CONCURRENCY;
    const chunks: Array<Uint8Array | null | undefined> = new Array(annotatedDescriptors.length);
    let fetchedBytes = 0;
    let failed = 0;
    let nextWrite = 0;
    let writeChain: Promise<void> = Promise.resolve();
    const flushReady = async (): Promise<void> => {
      const ready: Uint8Array[] = [];
      while (nextWrite < chunks.length && chunks[nextWrite] !== undefined) {
        const chunk = chunks[nextWrite];
        chunks[nextWrite] = undefined;
        nextWrite += 1;
        if (chunk) ready.push(chunk);
      }
      for (const chunk of ready) await staged?.append(chunk);
    };
    const queueFlush = (): Promise<void> => {
      writeChain = writeChain.then(flushReady);
      return writeChain;
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        // Check for abort before fetching next segment
        if (signal?.aborted) {
          return;
        }

        const index = nextIndex();
        if (index === undefined) return;
        const descriptor = annotatedDescriptors[index];
        if (!descriptor) return;
        if (descriptor.aes128) {
          throw new Error("Encrypted HLS is not supported by this rebuild");
        }
        const response = await fetchBytes(
          this.deps.fetchImpl,
          descriptor.url,
          { headers: descriptor.requestHeaders, ...(descriptor.range ? { range: descriptor.range } : {}) },
          { signal },
        );
        if (response.tag === "Err") {
          failed += 1;
          if (index === 0) throw new Error("Required segment was invalid, aborting download.");
          chunks[index] = null;
          if (staged !== undefined) await queueFlush();
          continue;
        }
        chunks[index] = response.value.bytes;
        fetchedBytes += response.value.bytes.byteLength;
        if (staged !== undefined) await queueFlush();
        this.emitProgress(plan.download_id, {
          status: "downloading",
          fetched_bytes_count: fetchedBytes,
          ...(typeof parsed.duration === "number"
            ? {
                percent: {
                  is_known: true,
                  value: Math.min(100, (index + 1) / annotatedDescriptors.length * 100),
                },
              }
            : { percent: { is_known: false, value: 0 } }),
        });
      }
    };

    let cursor = 0;
    const nextIndex = (): number | undefined => (cursor < annotatedDescriptors.length ? cursor++ : undefined);

    try {
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
      await writeChain;
    } catch (error) {
      if (staged !== undefined) await staged.abort().catch(() => undefined);
      // Check if error was due to abort
      if (signal?.aborted) {
        return err("user_abort");
      }
      return err(String(error));
    }

    // Final abort check (detect late abort after loop completes)
    if (signal?.aborted) {
      if (staged !== undefined) await staged.abort().catch(() => undefined);
      return err("user_abort");
    }

    if (isTooManyFailedSegments(failed, annotatedDescriptors.length) || fetchedBytes < 1_000) {
      if (staged !== undefined) await staged.abort().catch(() => undefined);
      return err(fetchedBytes < 1_000 ? "Downloaded content is too small" : "Too many invalid segments, aborting download.");
    }

    const available = chunks.filter((chunk): chunk is Uint8Array => chunk instanceof Uint8Array);
    return ok({
      bytes: staged === undefined ? concatenate(available) : new Uint8Array(),
      extension,
      totalBytes: fetchedBytes,
      ...(staged !== undefined ? { staged } : {}),
      ...(typeof parsed.duration === "number" ? { duration: parsed.duration } : {}),
    });
  }

  private async fetchPlaylistText(
    url: string,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<Result<string, string>> {
    const attempts = 5;
    let last = "manifest fetch failed";
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) return err("aborted");
      const response = await fetchBytes(
        this.deps.fetchImpl,
        url,
        { headers },
        { signal, maxBytes: MAX_HLS_MANIFEST_BYTES },
      );
      if (response.tag === "Ok") return ok(new TextDecoder().decode(response.value.bytes));
      last = response.error.message ?? "manifest fetch failed";
      if (response.error.kind === "http" && (response.error.status === 404 || response.error.status === 416)) {
        return err(last);
      }
      await sleepWithAbort(2 ** attempt * 500, signal).catch(() => undefined);
    }
    return err(last);
  }

  private emitProgress(downloadId: string, progress: DownloadProgress): void {
    const state = this.active.get(downloadId);
    if (state) {
      const now = this.now();
      if (progress.status === "downloading" && now - state.lastProgressAt < PROGRESS_INTERVAL_MS) return;
      state.lastProgressAt = now;
    }
    this.post(
      MSG.worker.DownloadProgress,
      { download_id: downloadId, progress } satisfies DownloadProgressPayload,
      Channel.FromWorkerToService,
    );
  }

  private post(name: string, data: unknown, channel: number): void {
    this.deps.channel.postMessage({ msg: { name, data }, channel });
  }
}

/** Map the parser's segment shape onto the transfer layer's descriptor input. */
export function toTransferSegments(segments: readonly ParsedSegment[]): TransferSegment[] {
  return segments.map((segment) => ({
    url: segment.uri,
    ...(segment.byterange ? { byte_range: { offset: segment.byterange.offset, length: segment.byterange.length } } : {}),
    ...(segment.key && segment.key.method === "AES-128" && segment.key.uri
      ? { encryption: { url: segment.key.uri, ...(segment.key.iv ? { iv: ivFromHex(segment.key.iv) } : {}) } }
      : {}),
    ...(segment.map
      ? {
          init: {
            url: segment.map.uri,
            ...(segment.map.byterange
              ? { byte_range: { offset: segment.map.byterange.offset, length: segment.map.byterange.length } }
              : {}),
          },
        }
      : {}),
    ...(segment.duration !== undefined ? { duration_s: segment.duration } : {}),
    ...(segment.discontinuity ? { is_live: false } : {}),
  }));
}

function toTransferInit(map: NonNullable<ParsedSegment["map"]>): HlsInitSegment {
  return {
    url: map.uri,
    ...(map.byterange ? { byte_range: { offset: map.byterange.offset, length: map.byterange.length } } : {}),
  };
}

function ivFromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < Math.min(16, clean.length / 2); i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Boot the worker in its real environment. Kept as a named function so the module has no
 * import-time side effects during tests.
 */
export function bootDownloadWorker(
  channel: BroadcastChannelLike,
  options: { ffmpeg?: FfmpegRunnerLike } = {},
): DownloadWorker {
  // Purge staging files left behind by a crashed previous worker instance (review 2.6).
  void openOpfsRoot()
    .then((root) => (root ? purgeStaging(root) : 0))
    .catch(() => undefined);
  const worker = new DownloadWorker({
    channel,
    fetchImpl: (input, init) => fetch(input, init as RequestInit) as never,
    openRoot: openOpfsRoot,
    ...(options.ffmpeg !== undefined ? { ffmpeg: options.ffmpeg } : {}),
  });
  worker.start();
  return worker;
}

export { removeStagedFile, computePercent, classifySegmentFailure, MAX_FAILED_SEGMENT_RATIO, httpFailureReason, otherFailureReason };

