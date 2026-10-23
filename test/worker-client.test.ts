import { describe, expect, it, vi } from "vitest";
import { WorkerClient, type WorkerEnvelope } from "../src/extension/worker-client.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import type { DownloadPlan, TransferOutcome } from "../src/core/types.js";

class FakeWorkerChannel implements BroadcastChannelLike {
  readonly posted: WorkerEnvelope[] = [];
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  postMessage(message: unknown): void {
    const envelope = message as WorkerEnvelope;
    this.posted.push(envelope);
    if (envelope.msg.name === MSG.worker.IsReady) {
      queueMicrotask(() => this.emit(MSG.worker.IsReadySuccess, null));
    }
  }

  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {}

  emit(name: string, data: unknown): void {
    const event = { data: { msg: { name, data }, channel: Channel.FromWorkerToService } };
    for (const listener of listenersSnapshot(this.listeners)) listener(event);
  }
}

function listenersSnapshot(
  listeners: Set<(event: { data: unknown }) => void>,
): Array<(event: { data: unknown }) => void> {
  return [...listeners];
}

const plan = {
  download_id: "download_timeout",
  headers: new Headers(),
  good_basename: "clip",
  subdir: "",
  save_as: false,
  will_use_jsfetch: false,
  strategy: "http_audio_video_one_source",
  url: new URL("https://cdn.test/clip.mp4"),
  carry_get_params: false,
  extension: "mp4",
  muxer: "mp4",
  is_youtube: false,
  throttle: false,
  cache: "default",
} as DownloadPlan;

describe("worker download cancellation", () => {
  it("settles a cancelled download and cleans up its late result", async () => {
    const channel = new FakeWorkerChannel();
    const onLateOutcome = vi.fn();
    const client = new WorkerClient({
      channel,
      offscreen: { ensureDocument: async () => undefined },
      offscreenUrl: "chrome-extension://fake/factory/factory.html",
      onLateOutcome,
    });
    const completion = client.download(plan);
    await client.ensureReady();

    client.cancel(plan.download_id);
    await expect(completion).rejects.toThrow("download cancelled");

    const outcome = {
      download_id: plan.download_id,
      internal_bloburl: "blob:late-result",
      internal_filename: "clip.mp4",
    } as TransferOutcome;
    channel.emit(MSG.worker.DownloadResult, outcome);

    expect(onLateOutcome).toHaveBeenCalledWith(outcome);
    expect(channel.posted).toContainEqual({
      msg: { name: MSG.worker.RevokeBlobUrl, data: { blob_url: "blob:late-result" } },
      channel: Channel.FromServiceToWorker,
    });
    client.dispose();
  });
});
