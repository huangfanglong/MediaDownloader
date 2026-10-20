/**
 * Service-side client for the offscreen download worker.
 *
 * Evidence: 01-messaging-runtime.md §2 and 04-download-transfer.md §2.1/§2.2. The original
 * (`Hn`, `ru`, `Xt`) creates the offscreen document on first use, waits for an `is_ready`
 * handshake with a 10 s timeout, posts serde-encoded download plans over
 * `BroadcastChannel("worker_service")` (channel 2), and correlates worker state updates by
 * `download_id` (channel 3).
 *
 * Browser surfaces are injected so the whole client is testable with a fake channel.
 */
import { Channel, WORKER_SERVICE_CHANNEL, type ChannelValue } from "../protocol/channels.js";
import { MSG } from "../protocol/messages.js";
import type { DownloadPlan, DownloadProgress, TransferOutcome } from "../core/types.js";
import type { DownloadProgressPayload } from "../protocol/messages.js";
import type { BroadcastChannelLike, OffscreenGateway } from "./gateways.js";
import { decode, encode } from "../protocol/serde.js";
import { RELAY_MESSAGES } from "../protocol/rebuild-messages.js";

/** Handshake timeout for the offscreen worker (proven: 10 000 ms). */
export const WORKER_READY_TIMEOUT_MS = 10_000;
/** Channel used for `is_ready` / `is_ready_success`. */
export const WORKER_ENVELOPE_CHANNEL: ChannelValue = Channel.FromServiceToWorker;

export interface WorkerEnvelope {
  msg: { name: string; data: unknown };
  channel: ChannelValue;
}

export interface PendingDownload {
  resolve: (outcome: TransferOutcome) => void;
  reject: (error: unknown) => void;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface WorkerClientOptions {
  channel: BroadcastChannelLike;
  offscreen: OffscreenGateway;
  /** URL of the offscreen document that hosts the worker. */
  offscreenUrl: string;
  /** Poll interval for the readiness handshake. */
  readyTimeoutMs?: number;
}

export class WorkerClient {
  private readonly channel: BroadcastChannelLike;
  private readonly offscreen: OffscreenGateway;
  private readonly offscreenUrl: string;
  private readonly readyTimeoutMs: number;
  private readonly pending = new Map<string, PendingDownload>();
  private ready = false;
  private preparing?: Promise<void>;
  private detach?: () => void;

  constructor(options: WorkerClientOptions) {
    this.channel = options.channel;
    this.offscreen = options.offscreen;
    this.offscreenUrl = options.offscreenUrl;
    this.readyTimeoutMs = options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS;
    this.listen();
  }

  /** True once the worker answered `is_ready_success`. */
  isReady(): boolean {
    return this.ready;
  }

  /** Ensure the offscreen document and worker exist; idempotent and concurrency-safe. */
  async ensureReady(): Promise<void> {
    if (this.ready) return;
    this.preparing ??= this.prepare();
    try {
      await this.preparing;
    } finally {
      if (this.ready) this.preparing = undefined;
    }
  }

  private async prepare(): Promise<void> {
    await this.offscreen.ensureDocument(
      this.offscreenUrl,
      "WORKERS",
      "Needed to create workers",
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.channel.removeEventListener("message", onMessage);
        console.error(
          "[media-downloader] worker handshake timed out after",
          this.readyTimeoutMs,
          "ms — check the offscreen document console for worker errors",
        );
        reject(new Error("Timed out waiting for the worker to start"));
      }, this.readyTimeoutMs);
      const onMessage = (event: { data: unknown }): void => {
        const envelope = event.data as WorkerEnvelope;
        if (envelope?.channel !== Channel.FromWorkerToService) return;
        if (envelope.msg?.name !== MSG.worker.IsReadySuccess) return;
        clearTimeout(timer);
        this.channel.removeEventListener("message", onMessage);
        console.info("[media-downloader] download worker ready");
        this.ready = true;
        resolve();
      };
      this.channel.addEventListener("message", onMessage);
      this.post(MSG.worker.IsReady, null);
    });
  }

  /** Run one download plan; resolves with the worker's outcome. */
  async download(plan: DownloadPlan, onProgress?: (progress: DownloadProgress) => void): Promise<TransferOutcome> {
    await this.ensureReady();
    const downloadId = plan.download_id;
    const completion = new Promise<TransferOutcome>((resolve, reject) => {
      this.pending.set(downloadId, { resolve, reject, onProgress });
    });
    this.post(MSG.worker.Download, { download_args: encode(plan) });
    return completion;
  }

  /** Page-context relay: the worker stages chunks forwarded by the service worker. */
  async streamDownload(plan: DownloadPlan): Promise<TransferOutcome> {
    await this.ensureReady();
    const completion = new Promise<TransferOutcome>((resolve, reject) => {
      this.pending.set(plan.download_id, { resolve, reject });
    });
    this.post(RELAY_MESSAGES.WorkerRelayStart, { download_args: encode(plan) });
    return completion;
  }

  /** Forward one relayed body chunk to the worker. */
  sendRelayChunk(downloadId: string, chunk: Uint8Array): void {
    this.post(RELAY_MESSAGES.WorkerRelayChunk, { download_id: downloadId, data: chunk });
  }

  endRelay(downloadId: string): void {
    this.post(RELAY_MESSAGES.WorkerRelayEnd, { download_id: downloadId });
  }

  abortRelay(downloadId: string): void {
    this.post(RELAY_MESSAGES.WorkerRelayAbort, { download_id: downloadId });
  }

  /** Ask the worker to abort a running download. */
  abort(downloadId: string): void {
    this.post(MSG.worker.AbortDownload, { download_id: downloadId });
  }

  /** Release the blob URL created by the worker for a finished download. */
  revokeBlobUrl(blobUrl: string): void {
    this.post(MSG.worker.RevokeBlobUrl, { blob_url: blobUrl });
  }

  dispose(): void {
    this.detach?.();
    this.detach = undefined;
    this.pending.clear();
  }

  private post(name: string, data: unknown): void {
    this.channel.postMessage({ msg: { name, data }, channel: Channel.FromServiceToWorker });
  }

  private listen(): void {
    const listener = (event: { data: unknown }): void => {
      const envelope = event.data as WorkerEnvelope;
      if (envelope?.channel !== Channel.FromWorkerToService) return;
      const name = envelope.msg?.name;
      const data = envelope.msg?.data;
      if (name === MSG.worker.IsReadySuccess) {
        this.ready = true;
        return;
      }
      if (name === MSG.worker.DownloadProgress) {
        const payload = data as DownloadProgressPayload;
        this.pending.get(payload.download_id)?.onProgress?.(payload.progress);
        return;
      }
      if (name === MSG.worker.DownloadResult) {
        const outcome = unwrapMaybeSerde(data) as TransferOutcome;
        const entry = outcome?.download_id ? this.pending.get(outcome.download_id) : undefined;
        // The original correlates results by download_id when present; the worker also includes
        // it in its payload. Fall back to the only pending entry to stay tolerant.
        const pending = entry ?? (this.pending.size === 1 ? [...this.pending.values()][0] : undefined);
        if (!pending) return;
        for (const [id, candidate] of this.pending) {
          if (candidate === pending) this.pending.delete(id);
        }
        pending.resolve(outcome);
        return;
      }
      if (name === MSG.worker.DownloadError) {
        const payload = data as { download_id?: string; error?: unknown };
        const pending = payload.download_id ? this.pending.get(payload.download_id) : undefined;
        if (!pending) return;
        this.pending.delete(payload.download_id as string);
        pending.reject(payload.error);
      }
    };
    this.channel.addEventListener("message", listener);
    this.detach = () => this.channel.removeEventListener("message", listener);
  }
}

/** Worker payloads may be plain objects or serde-tagged; accept both. */
function unwrapMaybeSerde(data: unknown): unknown {
  if (data && typeof data === "object" && "__serde_tag" in (data as Record<string, unknown>)) {
    return decode(data);
  }
  return data;
}

/** Convenience factory that opens the shared worker channel. */
export function createWorkerChannel(open: (name: string) => BroadcastChannelLike): BroadcastChannelLike {
  return open(WORKER_SERVICE_CHANNEL);
}
