/**
 * The overall transfer deadline has to cover the service-owned ranged path too. Without it a
 * server that keeps answering just under the per-read timeout keeps the transfer (and the MV3
 * service worker) alive far beyond the advertised 30-minute budget.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService } from "../src/extension/service-worker.js";
import type { WorkerClient } from "../src/extension/worker-client.js";
import { itemFromHint } from "../src/extension/content-script.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { encode } from "../src/protocol/serde.js";
import type { Envelope } from "../src/extension/gateways.js";
import type { MediaItem, TabMeta } from "../src/core/types.js";
import type { FetchLike, FetchResponseLike } from "../src/transfer/fetch.js";
import { createFakeOpfs } from "./helpers/transfer-fakes.js";
import { createFakeGateway, flush } from "./helpers/service-harness.js";

const PAGE_URL = "https://www.youtube.com/watch?v=abc";
const MEDIA_URL = "https://cdn.test/videoplayback?id=abc&itag=18&clen=4194304";
const CHUNK_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_ID = "download_ranged_deadline";

afterEach(() => {
  vi.restoreAllMocks();
});

function chunkResponse(bytes: Uint8Array): FetchResponseLike {
  let sent = false;
  return {
    status: 206,
    ok: true,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-range"
          ? `bytes 0-${bytes.byteLength - 1}/4194304`
          : null,
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: bytes };
        },
        cancel: async () => undefined,
      }),
    },
  };
}

/** First chunk succeeds; every later request stalls until the abort signal rejects it. */
function stallsAfterFirstChunk(): FetchLike {
  let calls = 0;
  return async (_url, init) => {
    calls += 1;
    if (calls === 1) return chunkResponse(new Uint8Array(CHUNK_BYTES).fill(1));
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
  };
}

interface WorkerProbe {
  streams: number;
  cancels: number;
  aborts: number;
  relayAborts: number;
}

function fakeWorker(): { probe: WorkerProbe; client: WorkerClient } {
  const probe: WorkerProbe = { streams: 0, cancels: 0, aborts: 0, relayAborts: 0 };
  let resolveFirst: ((value: unknown) => void) | undefined;
  const client = {
    streamDownload: () => {
      probe.streams += 1;
      if (probe.streams === 1) {
        return new Promise<unknown>((resolve) => {
          resolveFirst = resolve;
        });
      }
      // The page-relay retry has no producer in this test; resolve without a blob so it errors
      // out immediately instead of waiting.
      return Promise.resolve({ download_id: DOWNLOAD_ID });
    },
    sendRelayChunk: () => undefined,
    endRelay: () => resolveFirst?.({ download_id: DOWNLOAD_ID, internal_bloburl: "blob:deadline" }),
    abortRelay: () => {
      probe.relayAborts += 1;
    },
    cancel: () => {
      probe.cancels += 1;
    },
    abort: () => {
      probe.aborts += 1;
    },
    revokeBlobUrl: () => undefined,
    dispose: () => undefined,
    isReady: () => true,
    ensureReady: async () => undefined,
  } as unknown as WorkerClient;
  return { probe, client };
}

function makeService(
  gateway: ReturnType<typeof createFakeGateway>,
  fetchImpl: FetchLike,
  worker: WorkerClient,
  transferDeadlineMs: number,
): MediaDownloaderService {
  return new MediaDownloaderService({
    gateway,
    fetchImpl,
    opfsRoot: async () => createFakeOpfs().root,
    downloadIdFactory: () => DOWNLOAD_ID,
    now: () => 1_700_000_000_000,
    workerClient: worker,
    transferDeadlineMs,
  });
}

function plan(): never {
  return {
    download_id: DOWNLOAD_ID,
    headers: new Headers(),
    good_basename: "ranged-deadline",
    subdir: "",
    save_as: false,
    will_use_jsfetch: false,
    strategy: "http_audio_video_one_source",
    url: new URL(MEDIA_URL),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    is_youtube: true,
    throttle: true,
    cache: "default",
  } as never;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("condition was never reached");
}

describe("transfer deadline on the service-owned ranged path", () => {
  it("fails the stuck ranged transfer with a timeout instead of running forever", async () => {
    const gateway = createFakeGateway(PAGE_URL, new Map());
    const worker = fakeWorker();
    const service = makeService(gateway, stallsAfterFirstChunk(), worker.client, 50);
    const controller = new AbortController();
    // Mirrors the production lifecycle: the per-download controller is registered before the
    // attempt starts, and it is what the deadline aborts.
    (service as unknown as { transferAborts: Map<string, AbortController> }).transferAborts.set(
      DOWNLOAD_ID,
      controller,
    );
    const result = (await Promise.race([
      (
        service as unknown as {
          executeDownloadAttempt(
            plan: never,
            media: MediaItem,
            meta: TabMeta,
            signal: AbortSignal,
          ): Promise<{ tag: string; error?: string }>;
        }
      ).executeDownloadAttempt(plan(), { sent_headers: new Headers() } as MediaItem, {} as TabMeta, controller.signal),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ])) as { tag: string; error?: string } | "hung";
    await flush();
    await flush();

    expect(result).not.toBe("hung");
    if (result === "hung") return;
    expect(result.tag).toBe("Err");
    expect(result.error).toBe("transfer timed out");
    // The deadline aborts the service-owned work and tears down the worker relay staging.
    expect(worker.probe.cancels).toBeGreaterThan(0);
    expect(worker.probe.aborts).toBeGreaterThan(0);
    expect(worker.probe.relayAborts).toBeGreaterThan(0);
    expect(gateway.downloadRequestsLog).toHaveLength(0);
    service.stop();
  });

  it("clears the download row on a timeout instead of keeping it downloading", async () => {
    const gateway = createFakeGateway(PAGE_URL, new Map());
    const worker = fakeWorker();
    const service = makeService(gateway, stallsAfterFirstChunk(), worker.client, 50);
    await service.start();

    const hinted = itemFromHint({ url: MEDIA_URL, source: "player-response", kind: "file" }, PAGE_URL) as MediaItem;
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: { name: MSG.contentToService.DoDownload, data: { tab_id: 7, media_hash: hinted.hash } },
      channel: Channel.FromContentToService,
    } as Envelope);
    const cleared = await Promise.race([
      waitFor(() => service.getSession().downloading.size === 0).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);

    expect(cleared).toBe(true);
    expect(gateway.downloadRequestsLog).toHaveLength(0);
    // The deadline is terminal: no second transfer window through the page relay.
    expect(worker.probe.streams).toBe(1);
    const notifications = [...service.getSession().notifications.values()];
    expect(notifications.some((entry) => /timed out/i.test(String(entry.details)))).toBe(true);
    service.stop();
  });
});
