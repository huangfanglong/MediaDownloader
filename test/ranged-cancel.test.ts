/**
 * The service worker owns the bounded-range YouTube path: it fetches 2 MiB chunks itself and
 * relays them to the download worker for staging. Cancelling a download must stop that loop, not
 * merely mark the row as cancelled while the fetches and staging writes continue to the end.
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
const MEDIA_URL = "https://cdn.test/videoplayback?id=abc&itag=18&clen=6291456";
const CHUNK_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_ID = "download_ranged_cancel";

afterEach(() => {
  vi.restoreAllMocks();
});

interface WorkerProbe {
  sentChunks: number;
  ended: boolean;
  relayAborts: number;
  cancels: number;
}

function fakeWorker(): { probe: WorkerProbe; client: WorkerClient } {
  const probe: WorkerProbe = { sentChunks: 0, ended: false, relayAborts: 0, cancels: 0 };
  let resolveOutcome: ((value: unknown) => void) | undefined;
  const client = {
    streamDownload: () =>
      new Promise<unknown>((resolve) => {
        resolveOutcome = resolve;
      }),
    sendRelayChunk: () => {
      probe.sentChunks += 1;
    },
    endRelay: () => {
      probe.ended = true;
      resolveOutcome?.({
        download_id: DOWNLOAD_ID,
        internal_bloburl: "blob:ranged",
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
    cancel: () => {
      probe.cancels += 1;
    },
    abort: () => undefined,
    revokeBlobUrl: () => undefined,
    dispose: () => undefined,
    isReady: () => true,
    ensureReady: async () => undefined,
  } as unknown as WorkerClient;
  return { probe, client };
}

function chunkResponse(bytes: Uint8Array): FetchResponseLike {
  let sent = false;
  return {
    status: 206,
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

/** Let a test hold every chunk after the first until it decides to release them. */
interface FetchGate {
  calls: number[];
  release: () => void;
}

function gatedRangedFetch(): { fetchImpl: FetchLike; gate: FetchGate } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate: FetchGate = { calls: [], release: () => release() };
  const fetchImpl: FetchLike = async (_url, init) => {
    const range = new Headers(init?.headers).get("range");
    const start = Number(/^bytes=(\d+)-/u.exec(range ?? "")?.[1] ?? 0);
    gate.calls.push(start);
    if (start > 0) await released;
    return chunkResponse(new Uint8Array(CHUNK_BYTES).fill(7));
  };
  return { fetchImpl, gate };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("condition was never reached");
}

describe("cancelling the service-owned ranged transfer", () => {
  it("stops fetching and aborting staging instead of downloading to the end", async () => {
    const gateway = createFakeGateway(PAGE_URL, new Map());
    const worker = fakeWorker();
    const opfs = createFakeOpfs();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ranged-cancel");
    const { fetchImpl, gate } = gatedRangedFetch();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl,
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => DOWNLOAD_ID,
      now: () => 1_700_000_000_000,
      workerClient: worker.client,
    });
    await service.start();

    const hinted = itemFromHint(
      { url: MEDIA_URL, source: "player-response", kind: "file" },
      PAGE_URL,
    ) as MediaItem;
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: { name: MSG.contentToService.DoDownload, data: { tab_id: 7, media_hash: hinted.hash } },
      channel: Channel.FromContentToService,
    } as Envelope);

    // The first 2 MiB chunk has been fetched and relayed; the next one is held by the gate.
    await waitFor(() => worker.probe.sentChunks === 1);
    const callsAtCancel = gate.calls.length;
    expect(callsAtCancel).toBe(2);

    await gateway.deliverToService({
      msg: { name: MSG.contentToService.AbortDownload, data: { download_id: DOWNLOAD_ID } },
      channel: Channel.FromContentToService,
    } as Envelope);
    gate.release();
    await waitFor(() => service.getSession().downloading.size === 0);

    // No chunk request was started after the cancel (the held one is the last).
    expect(gate.calls.length).toBe(callsAtCancel);
    // No further chunk was handed to the worker, so its relay staging stops growing.
    expect(worker.probe.sentChunks).toBe(1);
    // The loop must not finish the relay or reach the save path for a cancelled transfer.
    expect(worker.probe.ended).toBe(false);
    expect(worker.probe.relayAborts).toBeGreaterThan(0);
    expect(gateway.downloadRequestsLog).toHaveLength(0);
    // A cancel is not a failure; it must not surface a notification.
    expect(gateway.notificationLog).toHaveLength(0);
    service.stop();
  });
});
