/**
 * A bounded-range transfer must not save a file it cannot assemble honestly.
 *
 * When a server or proxy ignores the `Range` header, every request returns the same body. The
 * loop used to concatenate that body until the advertised size and report a complete download,
 * so the user got a corrupt file. The response checks must fail the transfer instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService } from "../src/extension/service-worker.js";
import type { WorkerClient } from "../src/extension/worker-client.js";
import { itemFromHint } from "../src/extension/content-script.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { encode } from "../src/protocol/serde.js";
import type { Envelope } from "../src/extension/gateways.js";
import type { MediaItem } from "../src/core/types.js";
import type { FetchLike, FetchResponseLike } from "../src/transfer/fetch.js";
import { createFakeOpfs } from "./helpers/transfer-fakes.js";
import { createFakeGateway, flush } from "./helpers/service-harness.js";

const PAGE_URL = "https://www.youtube.com/watch?v=abc";
const MEDIA_URL = "https://cdn.test/videoplayback?id=abc&itag=18&clen=4194304";
const CHUNK_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_ID = "download_ranged_integrity";

afterEach(() => {
  vi.restoreAllMocks();
});

function chunkResponse(bytes: Uint8Array): FetchResponseLike {
  let sent = false;
  return {
    status: 200,
    ok: true,
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

/** A server that ignores Range: every request gets the same 2 MiB body with HTTP 200. */
const ignoresRange: FetchLike = async () => chunkResponse(new Uint8Array(CHUNK_BYTES).fill(5));

interface WorkerProbe {
  streams: number;
  relayAborts: number;
}

function fakeWorker(): { probe: WorkerProbe; client: WorkerClient } {
  const probe: WorkerProbe = { streams: 0, relayAborts: 0 };
  let resolveFirst: ((value: unknown) => void) | undefined;
  const client = {
    streamDownload: () => {
      probe.streams += 1;
      if (probe.streams === 1) {
        return new Promise<unknown>((resolve) => {
          resolveFirst = resolve;
        });
      }
      // The page-relay retry has no real producer in this test; resolve without a blob so the
      // attempt ends as an error instead of waiting for a content script.
      return Promise.resolve({ download_id: DOWNLOAD_ID });
    },
    sendRelayChunk: () => undefined,
    endRelay: () => {
      resolveFirst?.({
        download_id: DOWNLOAD_ID,
        internal_bloburl: "blob:ranged-corrupt",
        ending_reason: {
          user_abort: false,
          e4XX_5XX_failure: false,
          percentage_incomplete: false,
          other_failure: false,
        },
      });
    },
    abortRelay: () => {
      probe.relayAborts += 1;
    },
    cancel: () => undefined,
    abort: () => undefined,
    revokeBlobUrl: () => undefined,
    dispose: () => undefined,
    isReady: () => true,
    ensureReady: async () => undefined,
  } as unknown as WorkerClient;
  return { probe, client };
}

function makeService(fetchImpl: FetchLike, worker: WorkerClient): MediaDownloaderService {
  return new MediaDownloaderService({
    gateway: createFakeGateway(PAGE_URL, new Map()),
    fetchImpl,
    opfsRoot: async () => createFakeOpfs().root,
    downloadIdFactory: () => DOWNLOAD_ID,
    now: () => 1_700_000_000_000,
    workerClient: worker,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("condition was never reached");
}

describe("service-owned ranged response integrity", () => {
  it("reports the range problem instead of relaying a repeated body", async () => {
    const gateway = createFakeGateway(PAGE_URL, new Map());
    const worker = fakeWorker();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl: ignoresRange,
      opfsRoot: async () => createFakeOpfs().root,
      now: () => 1_700_000_000_000,
      workerClient: worker.client,
    });
    const plan = {
      download_id: DOWNLOAD_ID,
      headers: new Headers(),
      good_basename: "ranged-integrity",
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
    const result = (await (
      service as unknown as {
        rangedDownloadThroughWorker(
          plan: never,
          signal: AbortSignal,
        ): Promise<{ tag: string; error?: string }>;
      }
    ).rangedDownloadThroughWorker(plan, new AbortController().signal)) as { tag: string; error?: string };
    expect(result.tag).toBe("Err");
    expect(result.error).toMatch(/range|200|advertis/i);
    expect(worker.probe.relayAborts).toBeGreaterThan(0);
    service.stop();
  });

  it("does not save a file assembled from ignored-range responses", async () => {
    const gateway = createFakeGateway(PAGE_URL, new Map());
    const worker = fakeWorker();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl: ignoresRange,
      opfsRoot: async () => createFakeOpfs().root,
      downloadIdFactory: () => DOWNLOAD_ID,
      now: () => 1_700_000_000_000,
      workerClient: worker.client,
    });
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
    await waitFor(() => service.getSession().downloading.size === 0);

    expect(gateway.downloadRequestsLog).toHaveLength(0);
    expect([...service.getSession().notifications.values()].some((entry) => entry.type === "download_error")).toBe(true);
    service.stop();
  });
});
