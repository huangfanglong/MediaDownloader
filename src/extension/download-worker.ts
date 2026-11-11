/**
 * Offscreen download worker (module worker).
 *
 * Evidence: 04-download-transfer.md §2.1-§2.3 and 01-messaging-runtime.md §2. The original
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
import {
  PROGRESS_INTERVAL_MS,
  httpFailureReason,
  isHlsStrategy,
  otherFailureReason,
} from "../core/types.js";
import { IN_PROGRESS_PERCENT_MAX, percentFromBytes, percentFromRatio } from "../core/progress.js";
import { err, ok, type Result } from "../core/option.js";
import { MAX_HLS_MANIFEST_BYTES, parsePlaylist } from "../manifests/hls.js";
import { looksLikeJsonText, parseJsonMediaManifest } from "../manifests/json-manifest.js";
import {
  MIN_OUTPUT_BYTES,
  buildSegmentRequests,
  checkOutputCompleteness,
  classifySegmentFailure,
  concatenate,
  isTooManyFailedSegments,
} from "../transfer/assemble.js";
import type { HlsInitSegment, HlsSegment as TransferSegment, SegmentDescriptor } from "../transfer/assemble.js";
import type { HlsSegment as ParsedSegment } from "../manifests/hls.js";
import { headersForPlan, fetchBytes, scopedHeadersFor, type FetchLike } from "../transfer/fetch.js";
import { resolveTransferLimits, type TransferLimits } from "../transfer/limits.js";
import {
  convertArgs,
  defaultVendorBase,
  FfmpegInputTooLargeError,
  FfmpegOutputTooLargeError,
  FfmpegRunner,
  mergeArgs,
  mp3Args,
  type FfmpegJob,
  type FfmpegRunnerLike,
} from "../transfer/ffmpeg.js";
import { declaredSize, fetchRanged, isRangeBoundCdn } from "../transfer/ranged.js";
import { endingReasonToMessage } from "../transfer/save.js";
import { muxFragmentedMp4ToSink } from "../transfer/mux-fmp4.js";
import { normalizeMediaOutputExtension } from "../transfer/sniff.js";
import { DEFAULT_SEGMENT_CONCURRENCY, sleepWithAbort, withSegmentRetry, withManifestRetry } from "../transfer/retry.js";
import { isSafeManifestChildUrl, isSafeSegmentUrl } from "../transfer/url-safety.js";
import {
  createStagedFile,
  openOpfsRoot,
  openStagedFile,
  purgeStaging,
  removeStagedFile,
  STAGING_DIRECTORY,
  type OpfsRoot,
  type StagedFile,
} from "./staging.js";

/** Segment fetch concurrency proven in the original (semaphore 4, 1 when throttled). */
export const SEGMENT_CONCURRENCY = DEFAULT_SEGMENT_CONCURRENCY;
export const THROTTLED_SEGMENT_CONCURRENCY = 1;

/** In-browser transcode budget: beyond this, VP8/x264 conversion is far slower than a download. */
const MAX_TRANSCODE_SECONDS = 180;

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
  /** In-memory body ceilings; production uses the defaults, tests may shrink them. */
  limits?: Partial<TransferLimits>;
}

interface ActiveDownload {
  controller: AbortController;
  lastProgressAt: number;
  lastProgressWasKnown?: boolean;
}

/** A finished staged file plus the metadata the transfer paths need. */
interface StagedTransfer {
  filename: string;
  blobUrl: string;
  file: File;
  extension: string;
  totalBytes: number;
}

/** A staged source that will feed an FFmpeg conversion instead of being saved directly. */
interface ConversionInput {
  name: string;
  file: File;
  filename: string;
  blobUrl: string;
  totalBytes: number;
  cleanup: () => Promise<void>;
}

type TrackProgress = (fetchedBytes: number, totalBytes?: number) => void;

export class DownloadWorker {
  private readonly deps: DownloadWorkerDeps;
  private readonly active = new Map<string, ActiveDownload>();
  /** In-progress page-relay transfers (chunks streamed from a content script). */
  private readonly relay = new Map<string, {
    staged: StagedFile;
    plan: DownloadPlan;
    bytes: number;
    totalBytes?: number;
  }>();
  private readonly now: () => number;
  private readonly limits: TransferLimits;
  /**
   * Plan whose ffmpeg job owns the runner right now. ffmpeg.wasm reports its advancement as
   * log lines, which are the only liveness signal during a silent remux: forwarding them as
   * that plan's progress re-arms the transfer's silence window (service side) and keeps the
   * panel's finalizing state current.
   */
  private activeFfmpegPlanId: string | undefined;
  private lastFfmpegReportAt = 0;

  constructor(deps: DownloadWorkerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.limits = resolveTransferLimits(deps.limits);
  }

  /** Announce readiness and start serving the worker channel. */
  start(): void {
    this.post(MSG.worker.IsReadySuccess, null, Channel.FromWorkerToService);
    this.deps.channel.addEventListener("message", (event) => {
      void this.onMessage(event.data);
    });
  }

  /**
   * FFmpeg log lines double as its progress report: it emits them only while the job actually
   * advances, so each line is living progress for the plan currently remuxing. Throttled to the
   * same cadence as transfer progress so a chatty stderr does not flood the message channel.
   */
  onFfmpegLog(line: string): void {
    void line;
    const planId = this.activeFfmpegPlanId;
    if (planId === undefined) return;
    const now = this.now();
    if (now - this.lastFfmpegReportAt < PROGRESS_INTERVAL_MS) return;
    this.lastFfmpegReportAt = now;
    this.emitProgress(planId, { status: "finalizing" });
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
    const payload = raw as { download_id?: string; data?: unknown; total_bytes?: unknown };
    if (payload.download_id === undefined) return;
    const entry = this.relay.get(payload.download_id);
    if (!entry) return;
    const chunk = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data as ArrayBufferLike);
    await entry.staged.append(chunk);
    entry.bytes += chunk.byteLength;
    if (typeof payload.total_bytes === "number" && Number.isFinite(payload.total_bytes) && payload.total_bytes > 0) {
      entry.totalBytes = payload.total_bytes;
    }
    const percent = percentFromBytes(entry.bytes, entry.totalBytes, IN_PROGRESS_PERCENT_MAX);
    this.emitProgress(payload.download_id, {
      status: "downloading",
      fetched_bytes_count: entry.bytes,
      ...(percent === undefined ? {} : { percent: { is_known: true, value: percent } }),
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

  /** Fetch one whole track (bounded ranges for googlevideo-style URLs). */
  private async fetchSourceBytes(
    url: URL,
    headers: Headers,
    signal?: AbortSignal,
    onProgress?: TrackProgress,
  ): Promise<Result<Uint8Array, string>> {
    if (isRangeBoundCdn(url)) {
      const ranged = await fetchRanged(this.deps.fetchImpl, url, headers, {
        signal,
        onBytes: (fetched, total) => onProgress?.(fetched, total),
        maxBytes: this.limits.maxTrackBytes,
      });
      if (ranged.tag === "Err") {
        const status = ranged.error.status !== undefined ? ` ${ranged.error.status}` : "";
        return err(`${ranged.error.kind}${status}: ${ranged.error.message ?? "download failed"}`);
      }
      return ok(ranged.value.bytes);
    }
    const fetched = await fetchBytes(
      this.deps.fetchImpl,
      url.href,
      { headers },
      {
        signal,
        maxBytes: this.limits.maxTrackBytes,
        onTotalSize: (total) => {
          onProgress?.(0, total);
        },
        onBytes: (fetchedBytes, total) => {
          onProgress?.(fetchedBytes, total ?? declaredSize(url));
        },
      },
    );
    if (fetched.tag === "Err") {
      const status = fetched.error.status !== undefined ? ` ${fetched.error.status}` : "";
      return err(`${fetched.error.kind}${status}: ${fetched.error.message ?? "download failed"}`);
    }
    return ok(fetched.value.bytes);
  }

  /** Revoke the blob URL and remove the OPFS entry of a staged intermediate. */
  private async cleanupStagedTransfer(
    root: OpfsRoot,
    staged: Pick<StagedTransfer, "filename" | "blobUrl">,
  ): Promise<void> {
    URL.revokeObjectURL(staged.blobUrl);
    await removeStagedFile(root, staged.filename).catch(() => undefined);
  }

  /**
   * Stream a direct response into OPFS and return the finished file.
   *
   * Plain saves use {@link streamDirect}; conversions use the returned File as a WORKERFS input
   * so the whole source never has to sit in memory (nor in FFmpeg's memory filesystem).
   */
  private async stageDirectTransfer(
    root: OpfsRoot,
    plan: DownloadPlan,
    headers: Headers,
    sourceExtension: string,
    signal?: AbortSignal,
  ): Promise<Result<StagedTransfer, string>> {
    let extension = sourceExtension;
    let staged: StagedFile | undefined;
    let total = 0;
    const plannedSize = plan.size ?? plan.content_length;
    let totalSize = plannedSize !== undefined && Number.isFinite(plannedSize) && plannedSize > 0
      ? plannedSize
      : undefined;
    const downloadingProgress = (fetchedBytes: number): DownloadProgress => {
      const percent = percentFromBytes(fetchedBytes, totalSize);
      return {
        status: "downloading",
        fetched_bytes_count: fetchedBytes,
        ...(percent !== undefined ? { percent: { is_known: true, value: percent } } : {}),
      };
    };
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
      console.info("[media-downloader] direct transfer ok", total, "bytes", plan.url.href);
      return ok({ ...finished, extension, totalBytes: total });
    } catch (error) {
      if (staged !== undefined) await staged.abort().catch(() => undefined);
      return err(String(error));
    }
  }

  /** Stage a direct download without retaining a second complete copy in memory. */
  private async streamDirect(
    root: OpfsRoot,
    plan: DownloadPlan,
    headers: Headers,
    sourceExtension: string,
    signal?: AbortSignal,
  ): Promise<Result<TransferOutcome, string>> {
    const staged = await this.stageDirectTransfer(root, plan, headers, sourceExtension, signal);
    if (staged.tag === "Err") return staged;
    this.emitProgress(plan.download_id, { status: "finalizing", fetched_bytes_count: staged.value.totalBytes });
    return ok({
      download_id: plan.download_id,
      internal_filename: staged.value.filename,
      internal_bloburl: staged.value.blobUrl,
      output_extension: staged.value.extension,
      ending_reason: {
        user_abort: false,
        e4XX_5XX_failure: false,
        percentage_incomplete: false,
        other_failure: false,
      },
    } as TransferOutcome);
  }

  /** Stream one adaptive track into OPFS; it becomes a WORKERFS input for the merge. */
  private async stageSourceTrack(
    root: OpfsRoot,
    url: URL,
    headers: Headers,
    signal: AbortSignal | undefined,
    nameBase: string,
    onProgress?: TrackProgress,
  ): Promise<Result<StagedTransfer, string>> {
    const extension = extensionForUrl(url) ?? "bin";
    let staged: StagedFile;
    try {
      staged = await createStagedFile(root, `${nameBase}.${extension}`);
    } catch (error) {
      return err(String(error));
    }
    let total = 0;
    let totalSize: number | undefined;
    const onChunk = async (chunk: Uint8Array): Promise<void> => {
      await staged.append(chunk);
      total += chunk.byteLength;
    };
    try {
      if (isRangeBoundCdn(url)) {
        const ranged = await fetchRanged(this.deps.fetchImpl, url, headers, {
          signal,
          onChunk,
          onBytes: (fetched, reportedTotal) => {
            totalSize = reportedTotal;
            onProgress?.(fetched, totalSize);
          },
        });
        if (ranged.tag === "Err") {
          await staged.abort();
          const status = ranged.error.status !== undefined ? ` ${ranged.error.status}` : "";
          return err(`ranged ${ranged.error.kind}${status}: ${ranged.error.message ?? "download failed"}`);
        }
      } else {
        const fetched = await fetchBytes(
          this.deps.fetchImpl,
          url.href,
          { headers },
          {
            signal,
            onChunk: async (chunk) => {
              await onChunk(chunk);
              onProgress?.(total, totalSize);
            },
            onTotalSize: (reportedTotal) => {
              totalSize = reportedTotal;
            },
          },
        );
        if (fetched.tag === "Err") {
          await staged.abort();
          const status = fetched.error.status !== undefined ? ` ${fetched.error.status}` : "";
          return err(`${fetched.error.kind}${status}: ${fetched.error.message ?? "download failed"}`);
        }
      }
      const finished = await staged.finish();
      return ok({ ...finished, extension, totalBytes: total });
    } catch (error) {
      await staged.abort().catch(() => undefined);
      return err(String(error));
    }
  }

  /**
   * Merge two fragmented fMP4 tracks straight into a staged file.
   *
   * The muxer writes init boxes, patched `moof` boxes and `mdat` payloads to the sink as it goes,
   * so the merged file is never held in memory (nor copied fragment by fragment) — only the two
   * inputs and the current fragment header are resident.
   */
  private async muxStagedTracks(
    root: OpfsRoot,
    plan: DownloadPlan,
    video: Uint8Array,
    audio: Uint8Array,
  ): Promise<Result<StagedTransfer, string>> {
    const staged = await createStagedFile(root, `${plan.download_id}.mp4`);
    try {
      const written = await muxFragmentedMp4ToSink(video, audio, { write: (chunk) => staged.append(chunk) });
      if (written === undefined) {
        await staged.abort();
        return err("audio/video muxing: inputs are not fragmented MP4");
      }
      if (written < MIN_OUTPUT_BYTES) {
        await staged.abort();
        return err(`muxed output too small (${written} bytes)`);
      }
      const finished = await staged.finish();
      return ok({ ...finished, extension: "mp4", totalBytes: written });
    } catch (error) {
      await staged.abort().catch(() => undefined);
      return err(String(error));
    }
  }

  /** Result describing a finished staged output. */
  private stagedOutcome(plan: DownloadPlan, staged: StagedTransfer, extension: string): TransferOutcome {
    this.emitProgress(plan.download_id, { status: "finalizing", fetched_bytes_count: staged.totalBytes });
    return {
      download_id: plan.download_id,
      internal_filename: staged.filename,
      internal_bloburl: staged.blobUrl,
      output_extension: extension,
      ending_reason: { user_abort: false, e4XX_5XX_failure: false, percentage_incomplete: false, other_failure: false },
    } as TransferOutcome;
  }

  /**
   * Run an ffmpeg job whose output streams into OPFS, falling back to a memory run. The plan id
   * marks the job's ownership window: while it runs, runner log lines are progress for that plan.
   */
  private async runFfmpegStaged(
    job: FfmpegJob,
    root: OpfsRoot,
    filename: string,
    extension: string,
    planId: string,
  ): Promise<Result<StagedTransfer, string>> {
    this.activeFfmpegPlanId = planId;
    try {
      return await this.runStagedJob(job, root, filename, extension);
    } finally {
      if (this.activeFfmpegPlanId === planId) this.activeFfmpegPlanId = undefined;
    }
  }

  /** Body of a staged ffmpeg run; caller owns the active-plan marker. */
  private async runStagedJob(
    job: FfmpegJob,
    root: OpfsRoot,
    filename: string,
    extension: string,
  ): Promise<Result<StagedTransfer, string>> {
    const ffmpeg = this.deps.ffmpeg;
    if (ffmpeg === undefined) return err("ffmpeg unavailable");
    if (ffmpeg.runToStaging !== undefined) {
      try {
        await ffmpeg.runToStaging(job, { root, directory: STAGING_DIRECTORY, filename });
        const staged = await openStagedFile(root, filename);
        return ok({ ...staged, extension, totalBytes: staged.file.size });
      } catch (error) {
        if (error instanceof FfmpegInputTooLargeError || error instanceof FfmpegOutputTooLargeError) {
          return err(error.message);
        }
        // Staging unavailable: fall through to the legacy memory path below.
      }
    }
    const result = await this.runFfmpeg(job);
    if (result.tag === "Err") return result;
    const staged = await createStagedFile(root, filename);
    try {
      await staged.append(result.value);
      const finished = await staged.finish();
      return ok({ ...finished, extension, totalBytes: result.value.byteLength });
    } catch (error) {
      await staged.abort();
      return err(String(error));
    }
  }

  /** Run an ffmpeg job, turning the byte-input budget into a normal download error. */
  private async runFfmpeg(job: FfmpegJob): Promise<Result<Uint8Array, string>> {
    const ffmpeg = this.deps.ffmpeg;
    if (ffmpeg === undefined) return err("ffmpeg unavailable");
    try {
      return ok(await ffmpeg.run(job));
    } catch (error) {
      if (error instanceof FfmpegInputTooLargeError || error instanceof FfmpegOutputTooLargeError) {
        return err(error.message);
      }
      throw error;
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
    /** Staged source kept for the conversion step below instead of being saved as-is. */
    let conversionInput: ConversionInput | undefined;

    if (plan.url_audio) {
      const fetchedSources = [0, 0];
      const totalSources = [
        plan.content_length ?? plan.size ?? declaredSize(plan.url),
        plan.audio_content_length ?? declaredSize(plan.url_audio),
      ];
      const reportSourceProgress = (
        sourceIndex: number,
        activeSources: readonly number[] = [0, 1],
      ): TrackProgress =>
        (fetched, total) => {
          fetchedSources[sourceIndex] = fetched;
          if (total !== undefined) totalSources[sourceIndex] = total;
          const fetchedBytes = activeSources.reduce((sum, index) => sum + fetchedSources[index]!, 0);
          const totalBytes = activeSources.every((index) => totalSources[index] !== undefined)
            ? activeSources.reduce((sum, index) => sum + totalSources[index]!, 0)
            : undefined;
          const percent = percentFromBytes(fetchedBytes, totalBytes, IN_PROGRESS_PERCENT_MAX);
          this.emitProgress(plan.download_id, {
            status: "downloading",
            fetched_bytes_count: fetchedBytes,
            ...(percent === undefined ? {} : { percent: { is_known: true, value: percent } }),
          });
        };
      const ffmpeg = this.deps.ffmpeg;
      if (!isHlsStrategy(plan.strategy)) {
        // Direct adaptive tracks (YouTube and similar): stream both tracks to OPFS, then merge
        // the mounted files. Byte arrays are copied through MEMFS and need roughly three times
        // their size in memory, so staging is what lets large renditions merge at all.
        const target = plan.extension || "mp4";
        if (ffmpeg === undefined) {
          if (target === "mp3") return err("ffmpeg unavailable: audio extraction unsupported");
          // No FFmpeg: fetch both tracks and merge them into a staged file with the in-memory
          // fMP4 muxer (fragmented MP4 inputs only); the merged file is never buffered whole.
          const videoBytes = await this.fetchSourceBytes(plan.url, headers, signal, reportSourceProgress(0));
          if (videoBytes.tag === "Err") return videoBytes;
          const audioBytes = await this.fetchSourceBytes(plan.url_audio, headers, signal, reportSourceProgress(1));
          if (audioBytes.tag === "Err") return audioBytes;
          const muxed = await this.muxStagedTracks(root, plan, videoBytes.value, audioBytes.value);
          if (muxed.tag === "Err") return muxed;
          const requested = plan.output_format;
          if (requested !== undefined && requested !== "mp4") {
            await this.cleanupStagedTransfer(root, muxed.value);
            return err(`ffmpeg unavailable: cannot convert mp4 to ${requested}`);
          }
          console.info("[media-downloader] muxed adaptive tracks", muxed.value.totalBytes, "bytes");
          return ok(this.stagedOutcome(plan, muxed.value, "mp4"));
        } else if (target === "mp3") {
          const audioStaged = await this.stageSourceTrack(
            root,
            plan.url_audio,
            headers,
            signal,
            `${plan.download_id}-audio`,
            reportSourceProgress(1, [1]),
          );
          if (audioStaged.tag === "Err") return audioStaged;
          try {
            if (audioStaged.value.totalBytes < MIN_OUTPUT_BYTES) {
              return err(`audio track too small (${audioStaged.value.totalBytes} bytes)`);
            }
            this.emitProgress(plan.download_id, { status: "finalizing" });
            const extracted = await this.runFfmpegStaged(
              {
                inputs: [{ name: audioStaged.value.filename, file: audioStaged.value.file }],
                args: mp3Args(audioStaged.value.filename, "out.mp3"),
                outputName: "out.mp3",
              },
              root,
              `${plan.download_id}.mp3`,
              "mp3",
              plan.download_id,
            );
            if (extracted.tag === "Err") return extracted;
            console.info("[media-downloader] ffmpeg extracted mp3", extracted.value.totalBytes, "bytes");
            return ok(this.stagedOutcome(plan, extracted.value, "mp3"));
          } finally {
            await this.cleanupStagedTransfer(root, audioStaged.value);
          }
        } else {
          const videoStaged = await this.stageSourceTrack(
            root,
            plan.url,
            headers,
            signal,
            `${plan.download_id}-video`,
            reportSourceProgress(0),
          );
          if (videoStaged.tag === "Err") return videoStaged;
          const audioStaged = await this.stageSourceTrack(
            root,
            plan.url_audio,
            headers,
            signal,
            `${plan.download_id}-audio`,
            reportSourceProgress(1),
          );
          if (audioStaged.tag === "Err") {
            await this.cleanupStagedTransfer(root, videoStaged.value);
            return audioStaged;
          }
          try {
            const container = target === "webm" ? "webm" : target === "mkv" ? "mkv" : "mp4";
            const sourceIsWebm = (plan.source_demuxer ?? "") === "webm";
            if (container === "webm" && !sourceIsWebm) {
              return err("WebM output needs a WEBM quality; choose a WEBM rendition or keep Auto");
            }
            const outputName = `out.${container}`;
            const runMerge = (transcode: boolean): Promise<Result<StagedTransfer, string>> => {
              const args = mergeArgs(
                videoStaged.value.filename,
                audioStaged.value.filename,
                outputName,
                container,
                transcode,
              );
              console.info(
                "[media-downloader] ffmpeg merge",
                container,
                "video",
                videoStaged.value.totalBytes,
                "audio",
                audioStaged.value.totalBytes,
                args.join(" "),
              );
              return this.runFfmpegStaged(
                {
                  inputs: [
                    { name: videoStaged.value.filename, file: videoStaged.value.file },
                    { name: audioStaged.value.filename, file: audioStaged.value.file },
                  ],
                  args,
                  outputName,
                  expectedOutputBytes: videoStaged.value.totalBytes + audioStaged.value.totalBytes,
                },
                root,
                `${plan.download_id}.${container}`,
                container,
                plan.download_id,
              );
            };
            this.emitProgress(plan.download_id, { status: "finalizing" });
            let mergedStaged: StagedTransfer;
            if (container === "webm") {
              // Builder sends mixed WebM/AAC pairs to MKV; a WebM plan here should already be
              // VP8/VP9 + Opus/Vorbis, so copy both streams and never invoke libopus.
              const merged = await runMerge(false);
              if (merged.tag === "Err") {
                return err(`WebM mux failed; keep Auto to copy mixed audio into MKV: ${merged.error}`);
              }
              mergedStaged = merged.value;
            } else {
              const copied = await runMerge(false);
              if (copied.tag === "Ok") {
                mergedStaged = copied.value;
              } else {
                // Copy can fail for mixed codec families; one transcode retry is cheaper than failing.
                if (container === "mkv") return err(`ffmpeg merge failed: ${copied.error}`);
                if ((duration ?? 0) > MAX_TRANSCODE_SECONDS) {
                  return err(`ffmpeg merge failed and transcoding is limited to 3-minute clips: ${copied.error}`);
                }
                const transcoded = await runMerge(true);
                if (transcoded.tag === "Err") return transcoded;
                mergedStaged = transcoded.value;
              }
            }
            console.info("[media-downloader] ffmpeg merged tracks", mergedStaged.totalBytes, "bytes", container);
            if (plan.output_format !== undefined && plan.output_format !== container) {
              conversionInput = {
                name: mergedStaged.filename,
                file: mergedStaged.file,
                filename: mergedStaged.filename,
                blobUrl: mergedStaged.blobUrl,
                totalBytes: mergedStaged.totalBytes,
                cleanup: () => this.cleanupStagedTransfer(root, mergedStaged),
              };
              extension = container;
            } else {
              return ok(this.stagedOutcome(plan, mergedStaged, container));
            }
          } finally {
            await this.cleanupStagedTransfer(root, videoStaged.value);
            await this.cleanupStagedTransfer(root, audioStaged.value);
          }
        }
      } else if (ffmpeg === undefined) {
        // No FFmpeg: assemble both playlists and merge the assembled tracks straight into a staged
        // file, so only the two tracks are resident instead of the merged output as well.
        const videoAssembled = await this.assembleHls(plan, headers, signal);
        if (videoAssembled.tag === "Err") return videoAssembled;
        const audioPlan = { ...plan, url: plan.url_audio };
        const audioAssembled = await this.assembleHls(audioPlan, headers, signal);
        if (audioAssembled.tag === "Err") return audioAssembled;
        const muxed = await this.muxStagedTracks(
          root,
          plan,
          videoAssembled.value.bytes,
          audioAssembled.value.bytes,
        );
        if (muxed.tag === "Err") return muxed;
        const requested = plan.output_format;
        if (requested !== undefined && requested !== "mp4") {
          await this.cleanupStagedTransfer(root, muxed.value);
          return err(`ffmpeg unavailable: cannot convert mp4 to ${requested}`);
        }
        duration = videoAssembled.value.duration ?? duration;
        console.info("[media-downloader] muxed audio+video", muxed.value.totalBytes, "bytes");
        return ok(this.stagedOutcome(plan, muxed.value, "mp4"));
      } else {
        // HLS with a separate audio rendition: stream both playlists into OPFS, then merge the
        // staged files instead of buffering the complete video and audio first.
        const streamBase = { root, downloadId: plan.download_id };
        const videoAssembled = await this.assembleHls(plan, headers, signal, { ...streamBase, suffix: "-video" });
        if (videoAssembled.tag === "Err") return videoAssembled;
        const audioPlan = { ...plan, url: plan.url_audio };
        const audioAssembled = await this.assembleHls(audioPlan, headers, signal, {
          ...streamBase,
          suffix: "-audio",
        });
        if (audioAssembled.tag === "Err") {
          await videoAssembled.value.staged?.abort();
          return audioAssembled;
        }
        const videoStaged = videoAssembled.value.staged;
        const audioStaged = audioAssembled.value.staged;
        if (videoStaged === undefined || audioStaged === undefined) {
          await videoStaged?.abort();
          await audioStaged?.abort();
          return err("staging unavailable");
        }
        const videoFinished = await videoStaged.finish();
        let audioFinished;
        try {
          audioFinished = await audioStaged.finish();
        } catch (error) {
          await this.cleanupStagedTransfer(root, videoFinished);
          return err(String(error));
        }
        try {
          const container = plan.extension === "webm" ? "webm" : plan.extension === "mkv" ? "mkv" : "mp4";
          const sourceDemuxer = plan.source_demuxer ?? videoAssembled.value.extension;
          if (container === "webm" && sourceDemuxer !== "webm") {
            return err("WebM output needs a WEBM HLS rendition; choose a WEBM quality or keep Auto");
          }
          const outputName = `out.${container}`;
          this.emitProgress(plan.download_id, { status: "finalizing" });
          const merged = await this.runFfmpegStaged(
            {
              inputs: [
                { name: videoFinished.filename, file: videoFinished.file },
                { name: audioFinished.filename, file: audioFinished.file },
              ],
              args: mergeArgs(videoFinished.filename, audioFinished.filename, outputName, container, false),
              outputName,
              expectedOutputBytes: videoAssembled.value.totalBytes + audioAssembled.value.totalBytes,
            },
            root,
            `${plan.download_id}.${container}`,
            container,
            plan.download_id,
          );
          if (merged.tag === "Err") return merged;
          console.info("[media-downloader] ffmpeg merged HLS tracks", merged.value.totalBytes, "bytes", container);
          if (plan.output_format !== undefined && plan.output_format !== container) {
            conversionInput = {
              name: merged.value.filename,
              file: merged.value.file,
              filename: merged.value.filename,
              blobUrl: merged.value.blobUrl,
              totalBytes: merged.value.totalBytes,
              cleanup: () => this.cleanupStagedTransfer(root, merged.value),
            };
            extension = container;
          } else {
            return ok(this.stagedOutcome(plan, merged.value, container));
          }
        } finally {
          await this.cleanupStagedTransfer(root, videoFinished);
          await this.cleanupStagedTransfer(root, audioFinished);
        }
        duration = videoAssembled.value.duration ?? duration;
      }
    } else if (isHlsStrategy(plan.strategy)) {
      // Always stage the assembled playlist: plain saves hand the file on untouched, and the
      // conversion/remux paths read a WORKERFS-mounted File instead of buffering the media.
      const assembled = await this.assembleHls(plan, headers, signal, { root, downloadId: plan.download_id });
      if (assembled.tag === "Err") return assembled;
      duration = assembled.value.duration ?? duration;
      extension = assembled.value.extension;
      const staged = assembled.value.staged;
      const requestedFormat = plan.output_format;
      const shouldRemux = extension === "m2ts" && requestedFormat === "mp4";
      const needsConversion = requestedFormat !== undefined && extension !== requestedFormat;
      if (shouldRemux && this.deps.ffmpeg === undefined) {
        await staged?.abort();
        return err("MP4 conversion requires FFmpeg. Choose M2TS to keep the original stream.");
      }
      const finished = staged !== undefined ? await staged.finish() : undefined;
      if (finished !== undefined && !shouldRemux && !needsConversion) {
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
      if (shouldRemux) {
        if (finished === undefined) bytes = assembled.value.bytes;
        try {
          const inputName = finished !== undefined ? finished.filename : "input.m2ts";
          const remuxed = await this.runFfmpegStaged(
            {
              inputs: [finished !== undefined ? { name: inputName, file: finished.file } : { name: inputName, bytes }],
              args: ["-hide_banner", "-y", "-i", inputName, "-map", "0", "-c", "copy", "-movflags", "+faststart", "output.mp4"],
              outputName: "output.mp4",
              expectedOutputBytes: finished !== undefined ? assembled.value.totalBytes : bytes.byteLength,
            },
            root,
            `${plan.download_id}.mp4`,
            "mp4",
            plan.download_id,
          );
          if (remuxed.tag === "Err") throw new Error(remuxed.error);
          if (remuxed.value.totalBytes < MIN_OUTPUT_BYTES) throw new Error("FFmpeg produced an empty MP4");
          console.info("[media-downloader] remuxed HLS TS to mp4", remuxed.value.totalBytes, "bytes");
          return ok(this.stagedOutcome(plan, remuxed.value, "mp4"));
        } catch (error) {
          return err(`MP4 remux failed: ${String(error)}`);
        } finally {
          if (finished !== undefined) await this.cleanupStagedTransfer(root, finished);
        }
      } else if (needsConversion && finished !== undefined) {
        // Keep the staged File for the conversion step; it is cleaned up after the job.
        conversionInput = {
          name: finished.filename,
          file: finished.file,
          filename: finished.filename,
          blobUrl: finished.blobUrl,
          totalBytes: assembled.value.totalBytes,
          cleanup: () => this.cleanupStagedTransfer(root, finished),
        };
      } else {
        if (finished !== undefined) await this.cleanupStagedTransfer(root, finished);
        bytes = assembled.value.bytes;
      }
    } else if (plan.output_format === undefined || plan.output_format === extension) {
      return this.streamDirect(root, plan, headers, extension, signal);
    } else {
      // Conversion requested: stage the source, then hand FFmpeg the mounted File so the whole
      // download never has to sit in memory as a byte array.
      const staged = await this.stageDirectTransfer(root, plan, headers, extension, signal);
      if (staged.tag === "Err") return staged;
      extension = staged.value.extension;
      if (plan.output_format === extension) {
        this.emitProgress(plan.download_id, { status: "finalizing", fetched_bytes_count: staged.value.totalBytes });
        return ok({
          download_id: plan.download_id,
          internal_filename: staged.value.filename,
          internal_bloburl: staged.value.blobUrl,
          output_extension: extension,
          ending_reason: {
            user_abort: false,
            e4XX_5XX_failure: false,
            percentage_incomplete: false,
            other_failure: false,
          },
        } as TransferOutcome);
      }
      conversionInput = {
        name: staged.value.filename,
        file: staged.value.file,
        filename: staged.value.filename,
        blobUrl: staged.value.blobUrl,
        totalBytes: staged.value.totalBytes,
        cleanup: () => this.cleanupStagedTransfer(root, staged.value),
      };
    }

    const requestedFormat = plan.output_format;
    if (requestedFormat !== undefined && extension !== requestedFormat) {
      const ffmpeg = this.deps.ffmpeg;
      if (ffmpeg === undefined) {
        await conversionInput?.cleanup();
        return err(`ffmpeg unavailable: cannot convert ${extension} to ${requestedFormat}`);
      }
      const inputName = conversionInput?.name ?? `input.${extension.length > 0 ? extension : "bin"}`;
      const outputName = `output.${requestedFormat}`;
      const inputs = conversionInput !== undefined
        ? [{ name: inputName, file: conversionInput.file }]
        : [{ name: inputName, bytes }];
      this.emitProgress(plan.download_id, { status: "finalizing" });
      try {
        if (requestedFormat === "mp3") {
          if (conversionInput !== undefined) {
            const converted = await this.runFfmpegStaged(
              { inputs, args: mp3Args(inputName, outputName), outputName },
              root,
              `${plan.download_id}.${requestedFormat}`,
              requestedFormat,
              plan.download_id,
            );
            if (converted.tag === "Err") return converted;
            console.info("[media-downloader] ffmpeg converted output", converted.value.totalBytes, "bytes", requestedFormat);
            return ok(this.stagedOutcome(plan, converted.value, requestedFormat));
          }
          const converted = await this.runFfmpeg({
            inputs,
            args: mp3Args(inputName, outputName),
            outputName,
          });
          if (converted.tag === "Err") return converted;
          bytes = converted.value;
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
          if (conversionInput !== undefined) {
            const converted = await this.runFfmpegStaged(
              {
                inputs,
                args: convertArgs(inputName, outputName, requestedFormat, transcode),
                outputName,
              },
              root,
              `${plan.download_id}.${requestedFormat}`,
              requestedFormat,
              plan.download_id,
            );
            if (converted.tag === "Err") return converted;
            console.info("[media-downloader] ffmpeg converted output", converted.value.totalBytes, "bytes", requestedFormat);
            return ok(this.stagedOutcome(plan, converted.value, requestedFormat));
          }
          const converted = await this.runFfmpeg({
            inputs,
            args: convertArgs(inputName, outputName, requestedFormat, transcode),
            outputName,
          });
          if (converted.tag === "Err") return converted;
          bytes = converted.value;
        }
      } finally {
        await conversionInput?.cleanup();
        conversionInput = undefined;
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
    stream?: { root: OpfsRoot; downloadId: string; suffix?: string },
  ): Promise<Result<{
    bytes: Uint8Array;
    extension: string;
    duration?: number;
    staged?: StagedFile;
    totalBytes: number;
  }, string>> {
    // Credentials were captured for the URL that produced this plan (or for its master). Playlist
    // URLs resolved from that manifest may only replay them to the same origin, and a plan URL
    // that came from a master is itself manifest-resolved, so it obeys the same gate.
    const captureOrigin =
      plan.headers_origin !== undefined && plan.headers_origin !== ""
        ? plan.headers_origin
        : plan.url.origin;
    const playlistResult = await this.fetchPlaylistText(plan.url, captureOrigin, headers, signal);
    if (playlistResult.tag === "Err") {
      // fetchPlaylistText now returns "user_abort" for aborted requests
      return err(playlistResult.error);
    }
    let parsed = parsePlaylist(playlistResult.value, plan.url);
    if (parsed.kind === "invalid" && looksLikeJsonText(playlistResult.value)) {
      // DASH-in-JSON manifests (the `master.json` class) ride the HLS pipeline: map the JSON onto
      // the media-playlist shape the segment machinery consumes.
      const json = parseJsonMediaManifest(playlistResult.value, plan.url);
      if (json.tag === "Ok") parsed = json.value.playlist;
    }
    if (parsed.kind === "invalid") return err(parsed.reason);

    // Master playlists are normally resolved before planning; resolve defensively anyway.
    if (parsed.kind === "master") {
      const variant = parsed.variants[0];
      if (!variant) return err("empty master playlist");
      const media = await this.fetchPlaylistText(variant.uri, captureOrigin, headers, signal);
      if (media.tag === "Err") return media;
      parsed = parsePlaylist(media.value, variant.uri);
      if (parsed.kind === "invalid") return err(parsed.reason);
    }
    if (parsed.kind !== "media") return err("playlist is not downloadable");

    // JSON manifests mark DRM structurally (no EXT-X-KEY), so the key scan below cannot catch
    // them; refuse before any transfer, exactly like the key-based boundary.
    if (parsed.hasDrm) {
      return err("Encrypted media is not supported by this rebuild (no decrypter implemented)");
    }

    const segments = parsed.segments;
    if (segments.length === 0) return err("not a valid m3u8");
    // Encryption boundary: the rebuilt scope has no decrypter. Refuse explicitly instead of
    // saving ciphertext; AES-128 is the only standard scheme the original handled itself, and even
    // there we need a WebCrypto implementation that this rebuild deliberately omits.
    // An `#EXT-X-KEY` also covers the initialization section declared by a preceding `#EXT-X-MAP`
    // (RFC 8216 §4.3.2.5), so the map's key belongs to the same boundary. Checking only the media
    // segments let a keyed init be fetched raw and saved as part of a "successful" download.
    const encryptionKeys = segments.flatMap((segment) =>
      [segment.key, segment.map?.key].filter((key) => key !== undefined),
    );
    const methods = [...new Set(encryptionKeys.map((key) => key.method))];
    if (methods.length > 0) {
      return err(
        methods.includes("AES-128")
          ? "AES-128 encrypted HLS is not supported by this rebuild (no decrypter implemented)"
          : `Encrypted HLS is not supported (methods: ${methods.join(", ")})`,
      );
    }
    const initSegment = segments.find((segment) => segment.map !== undefined)?.map;
    const descriptors = buildSegmentRequests(toTransferSegments(segments), {
      masterUrl: plan.url,
      carryGetParams: plan.carry_get_params,
      ...(initSegment ? { initSegment: toTransferInit(initSegment) } : {}),
      mediaSequence: parsed.mediaSequence,
    });

    // Reject segments that leave http(s) or reach a private host without being same-origin with
    // the manifest. Fail fast with a clear error showing only the refused target (not the full URL
    // with tokens).
    for (const descriptor of descriptors) {
      const segmentUrl = new URL(descriptor.url);
      if (!isSafeSegmentUrl(segmentUrl, plan.url)) {
        return err(`Segment ${refusedTarget(segmentUrl)} refused by URL-safety gate`);
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
      : await createStagedFile(stream.root, `${stream.downloadId}${stream.suffix ?? ""}.${extension}`);
    const concurrency = plan.throttle ? THROTTLED_SEGMENT_CONCURRENCY : SEGMENT_CONCURRENCY;
    const chunks: Array<Uint8Array | null | undefined> = new Array(annotatedDescriptors.length);
    let fetchedBytes = 0;
    let failed = 0;
    let settledSegments = 0;
    /**
     * Planned vs fetched segment duration, used by the E19 completeness gate. Init sections have
     * no duration and drop out of both sums; streams whose playlist has unknown durations keep
     * `totalDurationS = 0` and skip the duration gate instead of guessing.
     */
    const totalDurationS = annotatedDescriptors.reduce(
      (sum, descriptor) => sum + (typeof descriptor.duration_s === "number" ? descriptor.duration_s : 0),
      0,
    );
    let fetchedDurationS = 0;
    let nextWrite = 0;
    /** Bytes of completed segments waiting for the ordered write head. */
    let retainedBytes = 0;
    /** Set when a segment cannot be buffered: the whole download stops instead of skipping it. */
    let fatal: string | undefined;
    let flushWaiters: Array<() => void> = [];
    const wakeFlushWaiters = (): void => {
      const waiters = flushWaiters;
      flushWaiters = [];
      for (const wake of waiters) wake();
    };
    let writeChain: Promise<void> = Promise.resolve();
    const flushReady = async (): Promise<void> => {
      const ready: Uint8Array[] = [];
      let released = 0;
      while (nextWrite < chunks.length && chunks[nextWrite] !== undefined) {
        const chunk = chunks[nextWrite];
        chunks[nextWrite] = undefined;
        nextWrite += 1;
        if (chunk) {
          ready.push(chunk);
          released += chunk.byteLength;
        }
      }
      for (const chunk of ready) await staged?.append(chunk);
      if (released > 0) {
        retainedBytes -= released;
        wakeFlushWaiters();
      }
    };
    const queueFlush = (): Promise<void> => {
      writeChain = writeChain.then(flushReady);
      return writeChain;
    };
    // Only the contiguous playlist prefix can be written to the staged file, so one slow early
    // segment lets the other workers accumulate finished segments in `chunks`. Wait for a flush
    // before fetching more, so retention is bounded by policy instead of by playlist length. The
    // missing head is always being fetched by its own worker, so waiting here cannot deadlock.
    const waitForFlush = (): Promise<void> =>
      new Promise((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        flushWaiters.push(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    const waitForRetentionBudget = async (): Promise<void> => {
      while (
        staged !== undefined &&
        retainedBytes > this.limits.maxRetainedSegmentBytes &&
        fatal === undefined &&
        !signal?.aborted
      ) {
        await waitForFlush();
      }
    };

    // Segment workers finish out of order, so progress must count completed attempts instead of
    // the worker's assigned index; otherwise the reported percentage can jump and fall back.
    const reportSegmentProgress = (): void => {
      settledSegments += 1;
      this.emitProgress(plan.download_id, {
        status: "downloading",
        fetched_bytes_count: fetchedBytes,
        ...(typeof parsed.duration === "number"
          ? {
              percent: {
                is_known: true,
                value: percentFromRatio(
                  settledSegments / annotatedDescriptors.length,
                  IN_PROGRESS_PERCENT_MAX,
                ),
              },
            }
          : { percent: { is_known: false, value: 0 } }),
      });
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        // Check for abort before fetching next segment
        if (signal?.aborted || fatal !== undefined) return;
        await waitForRetentionBudget();
        if (signal?.aborted || fatal !== undefined) return;

        const index = nextIndex();
        if (index === undefined) return;
        const descriptor = annotatedDescriptors[index];
        if (!descriptor) return;
        if (descriptor.aes128) {
          throw new Error("Encrypted HLS is not supported by this rebuild");
        }
        // wrap segment fetch in withSegmentRetry (5 attempts, 0/500/1000/1500ms backoff)
        const response = await withSegmentRetry(async () => {
          return fetchBytes(
            this.deps.fetchImpl,
            descriptor.url,
            { headers: descriptor.requestHeaders, ...(descriptor.range ? { range: descriptor.range } : {}) },
            { signal, maxBytes: this.limits.maxSegmentBytes },
          );
        }, signal);
        if (response.tag === "Err") {
          // An over-ceiling body is not a transient failure and must not be skipped like one: the
          // saved file would be missing a segment while still reported as complete. Stop instead.
          if (response.error.kind === "too_large") {
            fatal =
              `Segment ${index + 1} of ${annotatedDescriptors.length} exceeds the ` +
              `${this.limits.maxSegmentBytes} byte in-memory limit; refusing to buffer it`;
            throw new Error(fatal);
          }
          failed += 1;
          // The shared policy decides whether this failure is tolerable: the first segment is
          // mandatory, and too many failures abort instead of being skipped into a short file.
          const failure = classifySegmentFailure({
            failedSegments: failed,
            totalSegments: annotatedDescriptors.length,
            isFirst: index === 0,
          });
          if (failure.tag === "Err") {
            // Report the recovered message verbatim: the service maps it back to the original
            // ending-reason taxonomy, so an "Error:" prefix would break the match.
            fatal = failure.error.message ?? "segment failure";
            throw new Error(fatal);
          }
          chunks[index] = null;
          if (staged !== undefined) await queueFlush();
          reportSegmentProgress();
          continue;
        }
        chunks[index] = response.value.bytes;
        if (typeof descriptor.duration_s === "number") fetchedDurationS += descriptor.duration_s;
        retainedBytes += response.value.bytes.byteLength;
        fetchedBytes += response.value.bytes.byteLength;
        if (staged !== undefined) {
          await queueFlush();
        } else if (fetchedBytes > this.limits.maxUnstagedHlsBytes) {
          // No staging means every segment stays in RAM for the final concatenate/mux step.
          fatal = `Playlist output exceeds the ${this.limits.maxUnstagedHlsBytes} byte in-memory limit`;
          throw new Error(fatal);
        }
        reportSegmentProgress();
      }
    };

    let cursor = 0;
    const nextIndex = (): number | undefined => (cursor < annotatedDescriptors.length ? cursor++ : undefined);

    try {
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
      await writeChain;
    } catch (error) {
      wakeFlushWaiters();
      if (staged !== undefined) await staged.abort().catch(() => undefined);
      // Check if error was due to abort
      if (signal?.aborted) {
        return err("user_abort");
      }
      return err(fatal ?? String(error));
    }

    // Final abort check (detect late abort after loop completes)
    if (signal?.aborted) {
      if (staged !== undefined) await staged.abort().catch(() => undefined);
      return err("user_abort");
    }

    if (isTooManyFailedSegments(failed, annotatedDescriptors.length)) {
      if (staged !== undefined) await staged.abort().catch(() => undefined);
      return err("Too many invalid segments, aborting download.");
    }
    // Output acceptance gates (E19): a completed download whose fetched duration covers less than
    // 95 % of the planned one (with at least 5 % progress) is reported as incomplete instead of
    // being saved as a silently short file; under 1000 bytes is a hard failure.
    const completeness = checkOutputCompleteness({
      outputBytes: fetchedBytes,
      ...(totalDurationS > 0 ? { durationS: totalDurationS, outputDurationMs: fetchedDurationS * 1000 } : {}),
    });
    if (completeness.tag === "Err") {
      if (staged !== undefined) await staged.abort().catch(() => undefined);
      return err(endingReasonToMessage(completeness.error));
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
    url: URL,
    captureOrigin: string,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<Result<string, string>> {
    // A playlist this transfer was pointed at obeys the segment policy: unsafe URLs are refused
    // before any request, and captured credentials never leave the origin they were captured for.
    if (!isSafeManifestChildUrl(url, captureOrigin)) {
      return err(`Playlist ${refusedTarget(url)} refused by URL-safety gate`);
    }
    const scoped = scopedHeadersFor(url.href, captureOrigin, headers);
    // use tested withManifestRetry instead of hand-rolled loop
    const response = await withManifestRetry(async () => {
      return fetchBytes(
        this.deps.fetchImpl,
        url.href,
        { headers: scoped },
        { signal, maxBytes: MAX_HLS_MANIFEST_BYTES },
      );
    }, signal);

    if (response.tag === "Err") {
      // Convert RetryError to string, treating aborted as special marker
      if (response.error.kind === "aborted") {
        return err("user_abort");
      }
      return err(response.error.message ?? "manifest fetch failed");
    }

    return ok(new TextDecoder().decode(response.value.bytes));
  }

  private emitProgress(downloadId: string, progress: DownloadProgress): void {
    const state = this.active.get(downloadId);
    if (state) {
      const now = this.now();
      const progressIsKnown = progress.percent?.is_known === true;
      if (
        progress.status === "downloading" &&
        now - state.lastProgressAt < PROGRESS_INTERVAL_MS &&
        !(progressIsKnown && state.lastProgressWasKnown !== true)
      ) {
        return;
      }
      state.lastProgressAt = now;
      if (progress.status === "downloading") state.lastProgressWasKnown = progressIsKnown;
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

/** Name a refused URL in an error: the host when it has one, otherwise the scheme. */
function refusedTarget(url: URL): string {
  return url.hostname === "" ? `scheme ${url.protocol}` : `host ${url.hostname}`;
}

/**
 * AES-128 reference for one parser key, or `undefined` when the transfer layer cannot use it.
 * The worker refuses encrypted HLS before building descriptors; carrying the reference keeps the
 * transfer model honest (an init and a media segment use the same shape) instead of silently
 * dropping the key of an `#EXT-X-MAP`.
 */
function aes128Of(
  key: ParsedSegment["key"],
): { url: URL; iv?: Uint8Array } | undefined {
  if (key === undefined || key.method !== "AES-128" || key.uri === undefined) return undefined;
  return { url: key.uri, ...(key.iv ? { iv: ivFromHex(key.iv) } : {}) };
}

/** Map the parser's segment shape onto the transfer layer's descriptor input. */
export function toTransferSegments(segments: readonly ParsedSegment[]): TransferSegment[] {
  return segments.map((segment) => {
    const encryption = aes128Of(segment.key);
    const initEncryption = aes128Of(segment.map?.key);
    return {
      url: segment.uri,
      ...(segment.byterange ? { byte_range: { offset: segment.byterange.offset, length: segment.byterange.length } } : {}),
      ...(encryption ? { encryption } : {}),
      ...(segment.map
        ? {
            init: {
              url: segment.map.uri,
              ...(segment.map.byterange
                ? { byte_range: { offset: segment.map.byterange.offset, length: segment.map.byterange.length } }
                : {}),
              ...(initEncryption ? { encryption: initEncryption } : {}),
            },
          }
        : {}),
      ...(segment.duration !== undefined ? { duration_s: segment.duration } : {}),
    };
  });
}

function toTransferInit(map: NonNullable<ParsedSegment["map"]>): HlsInitSegment {
  const encryption = aes128Of(map.key);
  return {
    url: map.uri,
    ...(map.byterange ? { byte_range: { offset: map.byterange.offset, length: map.byterange.length } } : {}),
    ...(encryption ? { encryption } : {}),
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

/** Boot the worker in its real environment. Kept as a named function so the module has no
 * import-time side effects during tests. The ffmpeg runner is constructed here with its log
 * stream forwarded into the worker's progress reporting (see `onFfmpegLog`). */
export function bootDownloadWorker(
  channel: BroadcastChannelLike,
  options: { ffmpeg?: FfmpegRunnerLike } = {},
): DownloadWorker {
  // Purge staging files left behind by a crashed previous worker instance (review 2.6).
  void openOpfsRoot()
    .then((root) => (root ? purgeStaging(root) : 0))
    .catch(() => undefined);
  const runner: FfmpegRunnerLike =
    options.ffmpeg ??
    new FfmpegRunner(defaultVendorBase(), (line) => worker.onFfmpegLog(line));
  const worker = new DownloadWorker({
    channel,
    fetchImpl: (input, init) => fetch(input, init as RequestInit) as never,
    openRoot: openOpfsRoot,
    ffmpeg: runner,
  });
  worker.start();
  return worker;
}

export { removeStagedFile, httpFailureReason, otherFailureReason };

