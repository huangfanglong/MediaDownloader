import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService } from "../src/extension/service-worker.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { itemFromHint } from "../src/extension/content-script.js";
import { WorkerClient } from "../src/extension/worker-client.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { REBUILD_MESSAGES } from "../src/protocol/rebuild-messages.js";
import { decode, encode } from "../src/protocol/serde.js";
import type { Envelope } from "../src/extension/gateways.js";
import type { MediaItem } from "../src/core/types.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";
import {
  FakeChannelHub,
  createFakeGateway,
  createHarness,
  flush,
  fmp4MediaPlaylist,
  sniffDetails,
} from "./helpers/service-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("panel + adapter integration", () => {
  it("registers media reported by the page adapter and serves a panel snapshot", async () => {
    const entries = new Map<string, string | Uint8Array>();
    const gateway = createFakeGateway("https://site.test/watch", entries);
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
    const adapterItem = {
      type: "http_playlist",
      hash: "media_hash_adapter",
      is_youtube: false,
      sent_headers: new Headers(),
      playlist: [{ demuxer: "mp4", quality: {}, av: { video: new URL("https://cdn.test/page.mp4"), audio: false } }],
      extension: "mp4",
      discovery_timestamp_ms: 1,
      cache: "default",
    } as MediaItem;
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(adapterItem) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    expect(service.getEngine().mediaForTab(7).size).toBe(1);

    await gateway.deliverToService({
      msg: { name: REBUILD_MESSAGES.RequestSession, data: null },
      channel: Channel.FromContentToService,
    } as Envelope);
    const response = gateway.contentSends.at(-1);
    expect(response?.channel).toBe(Channel.FromServiceToContent);
    expect(response?.msg.name).toBe(REBUILD_MESSAGES.SessionSnapshot);
    const snapshot = decode(response?.msg.data) as { media: Array<{ hash: string; label: string }> };
    expect(snapshot.media).toHaveLength(1);
    expect(snapshot.media[0]?.hash).toBe("media_hash_adapter");
    service.stop();
  });
});

describe("MV3 lifecycle hardening", () => {
  it("registers event listeners synchronously (before start resolves)", async () => {
    const entries = new Map<string, string | Uint8Array>();
    const gateway = createFakeGateway("https://site.test/watch", entries);
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
    expect(gateway.runtimeHandlerCount()).toBeGreaterThan(0);
    expect(gateway.webRequestHandlerCount()).toBe(2);
    await service.start();
    service.stop();
  });

  it("persists session state JSON-safe so a restarted worker can restore it", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 1,
      initBytes: "INIT",
    });
    await harness.service.start();
    harness.gateway.triggerSendHeaders({
      requestId: "req-master",
      url: "https://cdn.test/master.m3u8",
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [],
    });
    await harness.gateway.triggerResponseStarted(
      sniffDetails("https://cdn.test/master.m3u8", "application/vnd.apple.mpegurl"),
    );
    await flush();
    const stored = (await harness.gateway.storage.session.get("global_session_state")) as Record<string, unknown>;
    const serialised = JSON.stringify(stored);
    expect(serialised).toContain("media_hash_");
    harness.service.stop();
  });
});

describe("panel updates without explicit requests", () => {
  it("pushes a session snapshot when media is detected", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 1,
      initBytes: "INIT",
    });
    await harness.service.start();
    harness.gateway.triggerSendHeaders({
      requestId: "req-master",
      url: "https://cdn.test/master.m3u8",
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [],
    });
    await harness.gateway.triggerResponseStarted(
      sniffDetails("https://cdn.test/master.m3u8", "application/vnd.apple.mpegurl"),
    );
    await flush();
    const pushed = harness.gateway.contentSends.filter(
      (envelope) => envelope.msg.name === REBUILD_MESSAGES.SessionSnapshot,
    );
    expect(pushed.length).toBeGreaterThan(0);
    const last = pushed.at(-1);
    const snapshot = decode(last?.msg.data) as { media: Array<{ hash: string }> };
    expect(snapshot.media.length).toBeGreaterThan(0);
    harness.service.stop();
  });
});

describe("focus filtering in the panel snapshot (QOL parity)", () => {
  it("shows only the focused media item after the page reports focus", async () => {
    const entries = new Map<string, string | Uint8Array>();
    const gateway = createFakeGateway("https://www.instagram.com/p/abc", entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const worker = new DownloadWorker({
      channel: hub.endpoint("worker"),
      fetchImpl: createFetch(entries),
      openRoot: async () => opfs.root,
    });
    worker.start();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl: createFetch(entries),
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_focus",
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    await service.start();
    const first = itemFromHint(
      { url: "https://scontent.test/v/t2/f2/m86/A.mp4", source: "resource-entry", kind: "file" },
      "https://www.instagram.com/p/abc",
    );
    const second = itemFromHint(
      { url: "https://scontent.test/v/t2/f2/m86/B.mp4", source: "resource-entry", kind: "file" },
      "https://www.instagram.com/p/abc",
    );
    for (const media of [first, second]) {
      await gateway.deliverToService({
        msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(media) } },
        channel: Channel.FromInjectedToService,
      } as Envelope);
    }
    await gateway.deliverToService({
      msg: {
        name: REBUILD_MESSAGES.MediaFocus,
        data: { urls: ["https://scontent.test/v/t2/f2/m86/B.mp4?efg=1"] },
      },
      channel: Channel.FromContentToService,
    } as Envelope);
    const snapshot = service.panelSnapshot();
    expect(snapshot.media.map((row) => row.hash)).toEqual([second?.hash]);
    expect(gateway.badgeTextLog.at(-1)).toBe("1");
    service.stop();
  });
});

describe("duplicate adapter rows after tab switch (regression)", () => {
  it("keeps one item and refreshes its signed URL when only the signature rotates", async () => {
    const entries = new Map<string, string | Uint8Array>();
    const gateway = createFakeGateway("https://www.youtube.com/watch?v=abc123", entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const worker = new DownloadWorker({
      channel: hub.endpoint("worker"),
      fetchImpl: createFetch(entries),
      openRoot: async () => opfs.root,
    });
    worker.start();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl: createFetch(entries),
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_dup",
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    await service.start();
    const makeHint = (id: string, sig: string) =>
      itemFromHint(
        {
          url: `https://rr1---sn-x.googlevideo.com/videoplayback?id=o-${id}&itag=136&sig=${sig}`,
          audio_url: `https://rr1---sn-x.googlevideo.com/videoplayback?id=o-${id}&itag=140&sig=${sig}`,
          source: "player-response",
          kind: "file",
        },
        "https://www.youtube.com/watch?v=abc123",
      );
    const first = makeHint("A1", "old");
    const second = makeHint("B2", "new");
    for (const media of [first, second]) {
      await gateway.deliverToService({
        msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(media) } },
        channel: Channel.FromInjectedToService,
      } as Envelope);
    }
    const snapshot = service.panelSnapshot();
    expect(snapshot.media).toHaveLength(1);
    const stored = service.getSession().discovered.get(7)?.media.get(first?.hash ?? "");
    const storedVideo = stored?.playlist?.[0]?.av?.video;
    expect(storedVideo !== undefined && storedVideo !== false ? storedVideo.href : undefined).toContain("sig=new");
    service.stop();
  });
});

describe("content-script healing after extension updates", () => {
  it("force-injects the page hook and bridge into tabs that predate the update", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 3,
    });
    await harness.service.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.gateway.injectedFiles.length = 0;
    for (const handler of harness.gateway.installedHandlers) handler({ reason: "update" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const files = harness.gateway.injectedFiles.flatMap((entry) => entry.files);
    expect(files).toContain("page-hook.js");
    expect(files).toContain("content-script.js");
    expect(harness.gateway.injectedFiles.every((entry) => entry.tabId === 7)).toBe(true);
  });
});

describe("manifest preview fallback (non-mainstream/Twitter)", () => {
  it("gives an HLS row the direct video track detected on the same page", async () => {
    const pageUrl = "https://x.com/PaulGolding/status/2111588792050262257/video/1";
    const base = "https://video.twimg.com/amplify_video/2112224026076553216";
    const entries = new Map<string, string | Uint8Array>();
    const gateway = createFakeGateway(pageUrl, entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const worker = new DownloadWorker({
      channel: hub.endpoint("worker"),
      fetchImpl: createFetch(entries),
      openRoot: async () => opfs.root,
    });
    worker.start();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl: createFetch(entries),
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_preview",
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    await service.start();
    const hls = itemFromHint(
      { url: `${base}/pl/71FFpZO5ox3DX7Ff.m3u8?tag=16`, source: "player-response", kind: "hls" },
      pageUrl,
    );
    const direct = itemFromHint(
      { url: `${base}/vid/avc1/0/0/576x1024/Jtb05T0cejV2TnkD.mp4`, source: "player-response", kind: "file" },
      pageUrl,
    );
    for (const media of [hls, direct]) {
      await gateway.deliverToService({
        msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(media) } },
        channel: Channel.FromInjectedToService,
      } as Envelope);
    }
    const snapshot = service.panelSnapshot();
    const hlsRow = snapshot.media.find((row) => row.type === "m3u8");
    expect(hlsRow?.preview).toBe(`${base}/vid/avc1/0/0/576x1024/Jtb05T0cejV2TnkD.mp4`);

    const secondBase = "https://video.twimg.com/amplify_video/9999999999999999999";
    const secondDirect = itemFromHint(
      { url: `${secondBase}/vid/avc1/0/0/640x360/second.mp4`, source: "player-response", kind: "file" },
      pageUrl,
    );
    const unrelatedHls = itemFromHint(
      { url: "https://video.twimg.com/amplify_video/8888888888888888888/pl/unrelated.m3u8", source: "player-response", kind: "hls" },
      pageUrl,
    );
    for (const media of [secondDirect, unrelatedHls]) {
      await gateway.deliverToService({
        msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(media) } },
        channel: Channel.FromInjectedToService,
      } as Envelope);
    }
    const after = service.panelSnapshot();
    const unrelatedRow = after.media.find((row) => row.type === "m3u8" && row.preview === undefined);
    expect(unrelatedRow).toBeDefined();
    service.stop();
  });
});
