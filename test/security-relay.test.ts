import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService } from "../src/extension/service-worker.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { itemFromHint } from "../src/extension/content-script.js";
import { WorkerClient } from "../src/extension/worker-client.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { RELAY_MESSAGES } from "../src/protocol/rebuild-messages.js";
import { encode } from "../src/protocol/serde.js";
import type { Envelope } from "../src/extension/gateways.js";
import type { FetchLike } from "../src/transfer/fetch.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";
import {
  FakeChannelHub,
  createFakeGateway,
  createHarness,
  fetchMapFor,
  flush,
  fmp4MediaPlaylist,
} from "./helpers/service-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CDN header replay (live YouTube 403 regression)", () => {
  it("replays non-credential Referer through an exact session DNR rule and never replays Cookie", async () => {
    const mediaUrl = "https://cdn.test/videoplayback?id=abc&itag=18";
    const entries = fetchMapFor({ [mediaUrl]: "x".repeat(1200) });
    const gateway = createFakeGateway("https://site.test/watch", entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const fetchImpl = createFetch(entries);
    const worker = new DownloadWorker({ channel: hub.endpoint("worker"), fetchImpl, openRoot: async () => opfs.root });
    worker.start();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:replay");
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl,
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_replay",
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    await service.start();
    gateway.triggerSendHeaders({
      requestId: "req-media",
      url: mediaUrl + "&range=0-1000",
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [
        { name: "cookie", value: "SID=secret" },
        { name: "referer", value: "https://www.youtube.com/watch?v=abc" },
        { name: "origin", value: "https://www.youtube.com" },
        { name: "accept", value: "*/*" },
      ],
    });
    const hinted = itemFromHint(
      { url: mediaUrl, source: "player-response", kind: "file" },
      "https://www.youtube.com/watch?v=abc",
    );
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: { name: MSG.contentToService.DoDownload, data: { tab_id: 7, media_hash: hinted?.hash } },
      channel: Channel.FromContentToService,
    } as Envelope);
    expect(gateway.dnrAdds).toHaveLength(1);
    const rule = gateway.dnrAdds[0] as {
      action: { requestHeaders: Array<{ header: string; value: string }> };
      condition: { regexFilter?: string; urlFilter?: string };
    };
    const replayed = Object.fromEntries(
      rule.action.requestHeaders.map((header) => [header.header.toLowerCase(), header.value]),
    );
    expect(replayed["cookie"]).toBeUndefined();
    expect(replayed["referer"]).toContain("youtube.com");
    expect(rule.condition.regexFilter).toBe("^https://cdn\\.test/videoplayback\\?id=abc&itag=18$");
    expect(rule.condition.urlFilter).toBeUndefined();
    expect(gateway.dnrRemovals).toHaveLength(1);
    expect(gateway.downloadRequestsLog).toHaveLength(1);
    service.stop();
  });
});

describe("page-context relay (live YouTube 403 regression)", () => {
  it("retries a rejected transfer through the content script and saves the streamed file", async () => {
    const mediaUrl = "https://cdn.test/videoplayback?id=abc&itag=18";
    const entries = new Map<string, string | Uint8Array>();
    const baseFetch = createFetch(entries);
    let directAttempts = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.startsWith(mediaUrl)) {
        directAttempts += 1;
        return { status: 403, ok: false, body: null };
      }
      return baseFetch(url, init);
    };
    const gateway = createFakeGateway("https://www.youtube.com/watch?v=abc", entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const worker = new DownloadWorker({ channel: hub.endpoint("worker"), fetchImpl, openRoot: async () => opfs.root });
    worker.start();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:relay");
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
    await service.start();
    const hinted = itemFromHint(
      { url: mediaUrl, source: "player-response", kind: "file" },
      "https://www.youtube.com/watch?v=abc",
    );
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    const done = gateway.deliverToService({
      msg: { name: MSG.contentToService.DoDownload, data: { tab_id: 7, media_hash: hinted?.hash } },
      channel: Channel.FromContentToService,
    } as Envelope);
    let relayRequest: { request_id: string; url: string } | undefined;
    for (let attempt = 0; attempt < 50 && relayRequest === undefined; attempt += 1) {
      await flush();
      const envelope = gateway.tabMessages.find(
        (candidate) => candidate.msg.name === RELAY_MESSAGES.MediaStreamRequest,
      );
      relayRequest = envelope?.msg.data as { request_id: string; url: string } | undefined;
    }
    expect(relayRequest?.url).toBe(mediaUrl);
    const body = "relay-" + "z".repeat(2200);
    await gateway.deliverToService({
      msg: {
        name: RELAY_MESSAGES.MediaStreamChunk,
        data: { request_id: relayRequest?.request_id, seq: 0, data: Buffer.from(body).toString("base64") },
      },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: { name: RELAY_MESSAGES.MediaStreamEnd, data: { request_id: relayRequest?.request_id, total: body.length } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await done;
    expect(directAttempts).toBeGreaterThan(0);
    expect(gateway.downloadRequestsLog).toHaveLength(1);
    expect(gateway.downloadRequestsLog[0]?.url).toBe("blob:relay");
    const chunks = [...opfs.removed.values()].flat();
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const staged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      staged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(new TextDecoder().decode(staged)).toContain("relay-");
    service.stop();
  });
});

describe("stale DNR cleanup on service-worker restart (review round 2)", () => {
  it("removes session rules left behind by a previous worker lifetime", async () => {
    const entries = new Map<string, string | Uint8Array>();
    const gateway = createFakeGateway("https://site.test/watch", entries);
    gateway.seedDnrSessionRules([42, 43]);
    const hub = new FakeChannelHub();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl: createFetch(entries),
      opfsRoot: async () => createFakeOpfs().root,
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    await service.start();
    expect(gateway.dnrRemovals).toEqual(expect.arrayContaining([42, 43]));
    service.stop();
  });
});

describe("service-side ranged relay (YouTube itag=18 download)", () => {
  it("fetches bounded ranges from the service worker, streams to the worker and saves the file", async () => {
    const size = 1 * 1024 * 1024 + 321;
    const payload = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) payload[index] = index % 251;
    const rangedFetch: FetchLike = async (_url, init) => {
      const range = new Headers(init?.headers).get("range");
      if (!range) return { status: 403, ok: false, body: null };
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
      if (!match) return { status: 403, ok: false, body: null };
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), payload.length - 1);
      if (start >= payload.length) return { status: 416, ok: false, body: null };
      const slice = payload.slice(start, end + 1);
      let sent = false;
      return {
        status: 206,
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (sent) return { done: true };
              sent = true;
              return { done: false, value: slice };
            },
            cancel: async () => undefined,
          }),
        },
      };
    };
    const entries = new Map<string, string | Uint8Array>();
    const gateway = createFakeGateway("https://www.youtube.com/watch?v=abc", entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const worker = new DownloadWorker({ channel: hub.endpoint("worker"), fetchImpl: rangedFetch, openRoot: async () => opfs.root });
    worker.start();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ranged");
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl: rangedFetch,
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_svc_ranged",
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    await service.start();
    const hinted = itemFromHint(
      {
        url: `https://rr2---sn-x.googlevideo.com/videoplayback?id=1&itag=18&clen=${size}`,
        source: "player-response",
        kind: "file",
      },
      "https://www.youtube.com/watch?v=abc",
    );
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: { name: MSG.contentToService.DoDownload, data: { tab_id: 7, media_hash: hinted?.hash } },
      channel: Channel.FromContentToService,
    } as Envelope);
    for (let attempt = 0; attempt < 200 && gateway.downloadRequestsLog.length === 0; attempt += 1) await flush();
    expect(gateway.downloadRequestsLog).toHaveLength(1);
    expect(gateway.downloadRequestsLog[0]?.url).toBe("blob:ranged");
    const staged = [...(opfs.removed.get(`download_svc_ranged.mp4`) ?? [])];
    const total = staged.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(total).toBe(size);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of staged) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(merged).toEqual(payload);
    service.stop();
  });
});

describe("YouTube header replay regression (0.5.x)", () => {
  it("skips captured-header replay for self-authorising googlevideo URLs", async () => {
    const mediaUrl = "https://rr1---sn-x.googlevideo.com/videoplayback?id=1&itag=18&clen=1200";
    const entries = new Map<string, string | Uint8Array>();
    const failingFetch: FetchLike = async () => ({ status: 403, ok: false, body: null });
    const gateway = createFakeGateway("https://www.youtube.com/watch?v=abc", entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const worker = new DownloadWorker({ channel: hub.endpoint("worker"), fetchImpl: failingFetch, openRoot: async () => opfs.root });
    worker.start();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl: failingFetch,
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_replay_skip",
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    await service.start();
    const hinted = itemFromHint(
      { url: mediaUrl, source: "player-response", kind: "file" },
      "https://www.youtube.com/watch?v=abc",
    );
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: { name: MSG.contentToService.DoDownload, data: { tab_id: 7, media_hash: hinted?.hash } },
      channel: Channel.FromContentToService,
    } as Envelope);
    expect(gateway.dnrAdds).toHaveLength(0);
    const relayRequest = gateway.tabMessages.find((envelope) => envelope.msg.name === RELAY_MESSAGES.MediaStreamRequest);
    expect(relayRequest).toBeDefined();
    service.stop();
  });
});

describe("header replay context binding (P1 hardening)", () => {
  it("does not replay headers captured in a different tab", async () => {
    const mediaUrl = "https://cdn.test/context?id=abc&itag=18";
    const entries = fetchMapFor({ [mediaUrl]: "x".repeat(1200) });
    const gateway = createFakeGateway("https://site.test/watch", entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const fetchImpl = createFetch(entries);
    const worker = new DownloadWorker({ channel: hub.endpoint("worker"), fetchImpl, openRoot: async () => opfs.root });
    worker.start();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:context");
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl,
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_context",
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    await service.start();
    gateway.triggerSendHeaders({
      requestId: "req-context",
      url: mediaUrl,
      tabId: 8,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [{ name: "cookie", value: "SID=other-tab" }],
    });
    const hinted = itemFromHint(
      { url: mediaUrl, source: "player-response", kind: "file" },
      "https://site.test/watch",
    );
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: { name: MSG.contentToService.DoDownload, data: { tab_id: 7, media_hash: hinted?.hash } },
      channel: Channel.FromContentToService,
    } as Envelope);
    expect(gateway.dnrAdds).toHaveLength(0);
    service.stop();
  });
});

describe("manifest auto-enrichment trust gate (P1 hardening)", () => {
  it("does not fetch an unobserved cross-origin adapter HLS manifest", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/gate/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 1,
    });
    await harness.service.start();
    const hinted = itemFromHint(
      {
        url: "https://cdn.test/gate/master.m3u8",
        source: "player-response",
        kind: "hls",
        referer: "https://site.test/watch",
      },
      "https://site.test/watch",
    );
    await harness.gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    const media = [...harness.service.getEngine().mediaForTab(7).values()];
    expect(media[0]?.type).toBe("m3u8");
    expect(media[0]?.playlist).toBeUndefined();
    harness.service.stop();
  });

  it("does not enrich an already-known sniffer HLS item from an unobserved adapter hint", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/gate3/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/720/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/720/",
      segments: 1,
    });
    await harness.service.start();
    const hinted = itemFromHint(
      { url: "https://cdn.test/gate3/master.m3u8", source: "player-response", kind: "hls" },
      "https://site.test/watch",
    );
    harness.service.getEngine().insertExternal(hinted!, 7);
    await harness.gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    const media = [...harness.service.getEngine().mediaForTab(7).values()];
    expect(media[0]?.type).toBe("m3u8");
    expect(media[0]?.playlist).toBeUndefined();
    harness.service.stop();
  });

  it("never auto-fetches a literal private-network manifest", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/gate2/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 1,
    });
    await harness.service.start();
    const hinted = itemFromHint(
      { url: "http://127.0.0.1:9/master.m3u8", source: "player-response", kind: "hls" },
      "https://site.test/watch",
    );
    await harness.gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    const media = [...harness.service.getEngine().mediaForTab(7).values()];
    expect(media[0]?.type).toBe("m3u8");
    expect(media[0]?.playlist).toBeUndefined();
    harness.service.stop();
  });
});
