/**
 * The page relay is a checked stream: the service worker answers every relayed message with an
 * accepted verdict, and the content script stops as soon as the consumer no longer owns it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService } from "../src/extension/service-worker.js";
import { WorkerClient } from "../src/extension/worker-client.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { handleMediaStreamRequest, itemFromHint } from "../src/extension/content-script.js";
import { RELAY_MESSAGES } from "../src/protocol/rebuild-messages.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { encode } from "../src/protocol/serde.js";
import type { Envelope } from "../src/extension/gateways.js";
import type { MediaItem } from "../src/core/types.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";
import { FakeChannelHub, createFakeGateway, flush } from "./helpers/service-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type RelayCall = { kind: "chunk" | "end" | "abort"; downloadId: string; bytes?: number };

function makeStubService(
  gateway: ReturnType<typeof createFakeGateway>,
  relayCalls: RelayCall[],
): MediaDownloaderService {
  const workerStub = {
    streamDownload: () => new Promise<never>(() => undefined),
    sendRelayChunk: (downloadId: string, chunk: Uint8Array) =>
      relayCalls.push({ kind: "chunk", downloadId, bytes: chunk.byteLength }),
    endRelay: (downloadId: string) => relayCalls.push({ kind: "end", downloadId }),
    abortRelay: (downloadId: string) => relayCalls.push({ kind: "abort", downloadId }),
    abort: () => undefined,
    cancel: () => undefined,
    revokeBlobUrl: () => undefined,
    dispose: () => undefined,
    isReady: () => true,
    ensureReady: async () => undefined,
  } as unknown as WorkerClient;
  return new MediaDownloaderService({
    gateway,
    fetchImpl: async () => ({ status: 404, ok: false, body: null }),
    opfsRoot: async () => createFakeOpfs().root,
    now: () => 1_700_000_000_000,
    workerClient: workerStub,
  });
}

const chunkEnvelope = (requestId: string, data: string): Envelope =>
  ({
    msg: { name: RELAY_MESSAGES.MediaStreamChunk, data: { request_id: requestId, data } },
    channel: Channel.FromInjectedToService,
  }) as Envelope;

describe("page relay acknowledgement", () => {
  it("accepts messages only for a request the service still owns", async () => {
    const gateway = createFakeGateway("https://site.test/watch", new Map());
    const relayCalls: RelayCall[] = [];
    const service = makeStubService(gateway, relayCalls);
    await service.start();
    const internals = service as unknown as { relayRequests: Map<string, { downloadId: string }> };
    internals.relayRequests.set("live", { downloadId: "download_live" });
    const data = Buffer.from(new Uint8Array(12).fill(1)).toString("base64");

    await gateway.deliverToService(chunkEnvelope("live", data));
    expect(gateway.lastServiceResponse()).toEqual({ accepted: true });
    expect(relayCalls).toContainEqual({ kind: "chunk", downloadId: "download_live", bytes: 12 });

    // Unknown ids are rejected explicitly instead of being dropped in silence.
    await gateway.deliverToService(chunkEnvelope("gone", data));
    expect(gateway.lastServiceResponse()).toEqual({ accepted: false });
    expect(relayCalls).toHaveLength(1);

    // Malformed payloads are rejected too.
    await gateway.deliverToService(chunkEnvelope("live", undefined as never));
    expect(gateway.lastServiceResponse()).toEqual({ accepted: false });
    expect(relayCalls).toHaveLength(1);

    await gateway.deliverToService({
      msg: { name: RELAY_MESSAGES.MediaStreamEnd, data: { request_id: "live", total: 12 } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    expect(gateway.lastServiceResponse()).toEqual({ accepted: true });
    expect(relayCalls).toContainEqual({ kind: "end", downloadId: "download_live" });

    await gateway.deliverToService({
      msg: { name: RELAY_MESSAGES.MediaStreamError, data: { request_id: "gone", error: "boom" } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    expect(gateway.lastServiceResponse()).toEqual({ accepted: false });
    service.stop();
  });

  it("rejects the relay a restarted service worker inherited", async () => {
    const gateway = createFakeGateway("https://site.test/watch", new Map());
    const relayCalls: RelayCall[] = [];
    const first = makeStubService(gateway, relayCalls);
    await first.start();
    const internals = first as unknown as { relayRequests: Map<string, { downloadId: string }> };
    internals.relayRequests.set("inherited", { downloadId: "download_old" });
    // A terminated worker runs no cleanup code; only its listeners stop mattering.
    const disposers = (first as unknown as { disposers: Array<() => void> }).disposers;
    for (const dispose of disposers.splice(0)) dispose();

    const restarted = makeStubService(gateway, []);
    await restarted.start();
    await gateway.deliverToService(
      chunkEnvelope("inherited", Buffer.from(new Uint8Array(8).fill(2)).toString("base64")),
    );
    expect(gateway.lastServiceResponse()).toEqual({ accepted: false });
    restarted.stop();
  });
});

describe("page relay end to end", () => {
  const mediaUrl = "https://cdn.test/videoplayback?id=abc&itag=18";
  const pageUrl = "https://www.youtube.com/watch?v=abc";

  function createRelayHarness() {
    const entries = new Map<string, string | Uint8Array>();
    const baseFetch = createFetch(entries);
    const fetchImpl = (async (url: string, init?: unknown) => {
      if (url.startsWith(mediaUrl)) return { status: 403, ok: false, body: null };
      return baseFetch(url, init as never);
    }) as never;
    const gateway = createFakeGateway(pageUrl, entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:relay-ack");
    const worker = new DownloadWorker({ channel: hub.endpoint("worker"), fetchImpl, openRoot: async () => opfs.root });
    worker.start();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl,
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_youtube",
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    return { gateway, opfs, service };
  }

  async function startRelay(
    harness: ReturnType<typeof createRelayHarness>,
  ): Promise<{ request_id: string; url: string }> {
    const { gateway, service } = harness;
    await service.start();
    const hinted = itemFromHint({ url: mediaUrl, source: "player-response", kind: "file" }, pageUrl) as MediaItem;
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: { name: MSG.contentToService.DoDownload, data: { tab_id: 7, media_hash: hinted.hash } },
      channel: Channel.FromContentToService,
    } as Envelope);
    let relayRequest: { request_id: string; url: string } | undefined;
    for (let attempt = 0; attempt < 100 && relayRequest === undefined; attempt += 1) {
      await flush();
      relayRequest = gateway.tabMessages.find(
        (candidate) => candidate.msg.name === RELAY_MESSAGES.MediaStreamRequest,
      )?.msg.data as { request_id: string; url: string } | undefined;
    }
    expect(relayRequest?.url).toBe(mediaUrl);
    return relayRequest as { request_id: string; url: string };
  }

  function serveRanges(payload: Uint8Array): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { headers?: HeadersInit }) => {
        const match = /^bytes=(\d+)-(\d+)$/u.exec(new Headers(init?.headers).get("range") ?? "");
        const start = match ? Number(match[1]) : 0;
        const end = match ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1;
        const slice = payload.slice(start, end + 1);
        return {
          ok: true,
          status: 206,
          arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
        };
      }),
    );
  }

  /** Route the content script's sends into the fake gateway and feed the verdicts back. */
  const bridgeRuntime = (gateway: ReturnType<typeof createFakeGateway>) => ({
    sendMessage: async (message: unknown) => {
      await gateway.deliverToService(message as Envelope);
      return gateway.lastServiceResponse();
    },
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
  });

  it("streams the request/response loop into the worker and saves the file", async () => {
    const harness = createRelayHarness();
    const relayRequest = await startRelay(harness);
    const payload = new Uint8Array(3 * 1024 * 1024).fill(5);
    serveRanges(payload);

    await handleMediaStreamRequest(bridgeRuntime(harness.gateway) as never, relayRequest);
    for (let attempt = 0; attempt < 200 && harness.gateway.downloadRequestsLog.length === 0; attempt += 1) {
      await flush();
    }

    expect(harness.gateway.downloadRequestsLog).toHaveLength(1);
    const staged = [...harness.opfs.removed.values()].flat();
    const total = staged.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(total).toBe(payload.length);
    harness.service.stop();
  });

  it("stops the relay on cancel without saving or retrying", async () => {
    const harness = createRelayHarness();
    const relayRequest = await startRelay(harness);

    await harness.gateway.deliverToService({
      msg: { name: MSG.contentToService.AbortDownload, data: { download_id: "download_youtube" } },
      channel: Channel.FromContentToService,
    } as Envelope);
    // The producer's next chunk and end message are rejected, which is its stop signal.
    await harness.gateway.deliverToService(
      chunkEnvelope(relayRequest.request_id, Buffer.from(new Uint8Array(8).fill(3)).toString("base64")),
    );
    expect(harness.gateway.lastServiceResponse()).toEqual({ accepted: false });
    await harness.gateway.deliverToService({
      msg: { name: RELAY_MESSAGES.MediaStreamEnd, data: { request_id: relayRequest.request_id, total: 8 } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    expect(harness.gateway.lastServiceResponse()).toEqual({ accepted: false });

    for (let attempt = 0; attempt < 200 && harness.service.getSession().downloading.size > 0; attempt += 1) {
      await flush();
    }
    expect(harness.service.getSession().downloading.size).toBe(0);
    expect(harness.gateway.downloadRequestsLog).toHaveLength(0);
    // A cancel is not a failure and must not start a second relay attempt.
    const relayRequests = harness.gateway.tabMessages.filter(
      (candidate) => candidate.msg.name === RELAY_MESSAGES.MediaStreamRequest,
    );
    expect(relayRequests).toHaveLength(1);
    expect(harness.gateway.notificationLog).toHaveLength(0);
    harness.service.stop();
  });
});
