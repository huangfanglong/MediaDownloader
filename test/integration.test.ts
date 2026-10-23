import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService, type SessionState } from "../src/extension/service-worker.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { itemFromHint } from "../src/extension/content-script.js";
import { hlsPlaylistHash } from "../src/discovery/engine.js";
import { setFlag } from "../src/settings/flags.js";
import { WorkerClient } from "../src/extension/worker-client.js";
import { Channel, WORKER_SERVICE_CHANNEL } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { encode } from "../src/protocol/serde.js";
import type { Envelope } from "../src/extension/gateways.js";
import type { DownloadPlan, MediaItem, TabMeta } from "../src/core/types.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";
import {
  FakeChannelHub,
  createFakeGateway,
  createHarness,
  doDownloadEnvelope,
  fetchMapFor,
  fmp4MediaPlaylist,
  masterPlaylist,
  sniffDetails,
  tsMediaPlaylist,
} from "./helpers/service-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// End-to-end loop
// ---------------------------------------------------------------------------

describe("end-to-end: sniff â†’ playlist â†’ plan â†’ transfer â†’ save", () => {
  it("downloads an fMP4 HLS stream discovered from a master playlist", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 3,
      initBytes: "INIT",
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-output");
    await harness.service.start();

    harness.gateway.triggerSendHeaders({
      requestId: "req-master",
      url: "https://cdn.test/master.m3u8",
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [{ name: "referer", value: "https://site.test/watch" }],
    });
    await harness.gateway.triggerResponseStarted(
      sniffDetails("https://cdn.test/master.m3u8", "application/vnd.apple.mpegurl"),
    );

    // Discovery: the master is enriched into a playlist with both variants.
    const discovered = harness.service.getSession().discovered.get(7);
    const item = [...(discovered?.media.values() ?? [])][0];
    expect(item?.type).toBe("m3u8_playlist");
    expect(item?.playlist?.map((entry) => entry.quality.size?.height)).toEqual([1080, 720]);
    expect(item?.duration).toBe(6);

    const meta = harness.service.getSession().discovered.get(7)?.meta;
    expect(meta?.title).toBe("Test Page");

    // Download: panel sends do_download with media+meta; the service builds the plan.
    await harness.gateway.deliverToService(doDownloadEnvelope(item as MediaItem, meta as TabMeta));

    // Save request mirrors the original: subdir+basename+extension, uniquify, blob URL.
    expect(harness.gateway.downloadRequestsLog).toHaveLength(1);
    const request = harness.gateway.downloadRequestsLog[0];
    expect(request?.filename).toBe("Test Page.mp4");
    expect(request?.conflictAction).toBe("uniquify");
    expect(request?.url).toBe("blob:fake-output");

    // Assembled bytes: init segment first, then the three media segments. The service removes the
    // staged OPFS entry after saving, so the fake snapshots it on removal.
    const stagedName = "download_test.mp4";
    const staged = harness.opfs.removed.get(stagedName);
    expect(staged).toBeDefined();
    expect(staged).toHaveLength(4);
    const assembled = new TextDecoder().decode(
      new Uint8Array((staged ?? []).flatMap((chunk) => [...chunk])),
    );
    expect(assembled.startsWith("INIT")).toBe(true);
    expect(assembled).toContain("0:");
    expect(assembled).toContain("2:");
    expect(harness.opfs.files.size).toBe(0);

    // Bookkeeping: history record, no notifications, download no longer in flight.
    const session: SessionState = harness.service.getSession();
    expect(session.downloading.size).toBe(0);
    expect(session.transient_history).toHaveLength(1);
    expect(session.transient_history[0]?.path).toContain("Test Page.mp4");
    expect(harness.gateway.notificationLog).toHaveLength(1);
    expect(harness.gateway.notificationLog[0]?.title).toBe("Download complete");
    harness.service.stop();
  });

  it("downloads the HLS alternative when the panel selects the HLS source", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/source-master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 2,
      initBytes: "INIT",
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:source-hls");
    await harness.service.start();
    harness.gateway.triggerSendHeaders({
      requestId: "req-source-master",
      url: "https://cdn.test/source-master.m3u8",
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [{ name: "referer", value: "https://site.test/watch" }],
    });
    await harness.gateway.triggerResponseStarted(
      sniffDetails("https://cdn.test/source-master.m3u8", "application/vnd.apple.mpegurl"),
    );
    const meta = harness.service.getSession().discovered.get(7)?.meta as TabMeta;
    const direct = itemFromHint(
      {
        url: "https://cdn.test/direct.mp4",
        hls_url: "https://cdn.test/source-master.m3u8",
        source: "player-response",
        kind: "file",
        referer: "https://site.test/watch",
      },
      "https://site.test/watch",
    );
    const envelope = doDownloadEnvelope(direct as MediaItem, meta);
    (envelope.msg.data as { source?: string }).source = "hls";
    await harness.gateway.deliverToService(envelope);
    expect(harness.gateway.downloadRequestsLog).toHaveLength(1);
    expect(harness.gateway.downloadRequestsLog[0]?.filename).toBe("Test Page.mp4");
    expect(harness.gateway.downloadRequestsLog[0]?.url).toBe("blob:source-hls");
    harness.service.stop();
  });

  it("keeps one enriched HLS row when the same manifest response repeats", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/repeat/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 1,
      initBytes: "INIT",
    });
    await harness.service.start();
    harness.gateway.triggerSendHeaders({
      requestId: "req-repeat",
      url: "https://cdn.test/repeat/master.m3u8",
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [{ name: "referer", value: "https://site.test/watch" }],
    });
    const details = sniffDetails("https://cdn.test/repeat/master.m3u8", "application/vnd.apple.mpegurl");
    await harness.gateway.triggerResponseStarted(details);
    const first = [...harness.service.getEngine().mediaForTab(7).values()];
    expect(first).toHaveLength(1);
    expect(first[0]?.playlist).toBeDefined();
    await harness.gateway.triggerResponseStarted(details);
    const again = [...harness.service.getEngine().mediaForTab(7).values()];
    expect(again).toHaveLength(1);
    expect(again[0]?.hash).toBe(first[0]?.hash);
    expect(again[0]?.playlist).toBeDefined();
    harness.service.stop();
  });

  it("saves MPEG-TS HLS without an init segment as .m2ts", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/ts/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/ts/low/index.m3u8",
      mediaPlaylist: tsMediaPlaylist,
      segmentPrefix: "https://cdn.test/ts/low/",
      segments: 2,
    });
    // Turn the master into a single low variant so the TS playlist is selected.
    const entries = new Map<string, string | Uint8Array>([
      ["https://cdn.test/ts/master.m3u8", masterPlaylist.replace(/1920x1080[\s\S]*$/u, "")],
      ["https://cdn.test/720/index.m3u8", tsMediaPlaylist],
      ["https://cdn.test/720/seg0.ts", `0:${"x".repeat(700)}`],
      ["https://cdn.test/720/seg1.ts", `1:${"x".repeat(700)}`],
    ]);
    // Rebuild fetch + worker plumbing with the TS map.
    const gateway = createFakeGateway("https://site.test/watch", entries);
    const opfs = createFakeOpfs();
    const hub = new FakeChannelHub();
    const fetchImpl = createFetch(entries);
    const worker = new DownloadWorker({ channel: hub.endpoint("worker"), fetchImpl, openRoot: async () => opfs.root });
    worker.start();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl,
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_ts",
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-ts");
    await service.start();
    gateway.triggerSendHeaders({
      requestId: "req",
      url: "https://cdn.test/ts/master.m3u8",
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [],
    });
    await gateway.triggerResponseStarted(sniffDetails("https://cdn.test/ts/master.m3u8", "application/vnd.apple.mpegurl"));
    const item = [...(service.getSession().discovered.get(7)?.media.values() ?? [])][0];
    expect(item?.type).toBe("m3u8_playlist");
    const meta = service.getSession().discovered.get(7)?.meta as TabMeta;
    await gateway.deliverToService(doDownloadEnvelope(item as MediaItem, meta));
    expect(gateway.downloadRequestsLog[0]?.filename).toBe("Test Page.m2ts");
    service.stop();
  });

  it("refuses DRM-protected media before any transfer", async () => {
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
    const media = {
      type: "http_playlist",
      hash: "media_hash_1",
      is_youtube: false,
      sent_headers: new Headers(),
      has_drm: true,
      playlist: [{ demuxer: "mp4", quality: {}, av: { video: new URL("https://cdn.test/movie.mp4"), audio: false } }],
      discovery_timestamp_ms: 1,
      cache: "default",
    } as MediaItem;
    const meta: TabMeta = {
      incognito: false,
      tab_id: 7,
      default_action: "download",
      smartnaming_rule: {
        template: "%title",
        selector: null,
        max_length: 64,
        replace: [],
        subdir: "",
        force_doc_title: false,
      },
    };
    await gateway.deliverToService(doDownloadEnvelope(media, meta));
    expect(gateway.downloadRequestsLog).toHaveLength(0);
    const notifications = [...service.getSession().notifications.values()];
    expect(notifications[0]?.type).toBe("download_error");
    expect(notifications[0]?.has_drm).toBe(true);
    service.stop();
  });

  it("exposes a JSON-observable session snapshot for the panel", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 3,
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
    const session = harness.service.getSession();
    // The panel consumes the same document the service publishes to session storage.
    expect(Object.keys(Object.fromEntries(session.discovered))).toEqual(["7"]);
    expect(session.current_win_tab).toMatchObject({ tab_id: 7 });
    harness.service.stop();
  });
});

describe("worker transport", () => {
  it("uses the shared worker channel and correlates messages by download id", async () => {
    const hub = new FakeChannelHub();
    const seen: unknown[] = [];
    const workerSide = hub.endpoint("worker");
    workerSide.addEventListener("message", (event) => {
      seen.push(event.data);
      const envelope = event.data as { msg: { name: string }; channel: number };
      if (envelope.msg.name === MSG.worker.IsReady) {
        workerSide.postMessage({
          msg: { name: MSG.worker.IsReadySuccess, data: null },
          channel: Channel.FromWorkerToService,
        });
      }
    });
    const client = new WorkerClient({
      channel: hub.endpoint("service"),
      offscreen: { ensureDocument: async () => undefined },
      offscreenUrl: "chrome-extension://fake/factory/factory.html",
      readyTimeoutMs: 100,
    });
    await client.ensureReady();
    expect(seen[0]).toMatchObject({
      msg: { name: MSG.worker.IsReady },
      channel: Channel.FromServiceToWorker,
    });
    expect(WORKER_SERVICE_CHANNEL).toBe("worker_service");
    client.dispose();
  });
});





describe("concurrent transfer correlation", () => {
  it("correlates two in-flight downloads by download id", async () => {
    const entries = fetchMapFor({
      "https://cdn.test/a.mp4": `${"a".repeat(1200)}`,
      "https://cdn.test/b.mp4": `${"b".repeat(1200)}`,
    });
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const worker = new DownloadWorker({
      channel: hub.endpoint("worker"),
      fetchImpl: createFetch(entries),
      openRoot: async () => opfs.root,
    });
    worker.start();
    const client = new WorkerClient({
      channel: hub.endpoint("service"),
      offscreen: { ensureDocument: async () => undefined },
      offscreenUrl: "chrome-extension://fake/factory/factory.html",
      readyTimeoutMs: 200,
    });
    const planFor = (id: string, url: string): DownloadPlan => ({
      download_id: id,
      headers: new Headers(),
      good_basename: id,
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "http_audio_video_one_source",
      url: new URL(url),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:concurrent");
    const [first, second] = await Promise.all([
      client.download(planFor("download_a", "https://cdn.test/a.mp4")),
      client.download(planFor("download_b", "https://cdn.test/b.mp4")),
    ]);
    expect(first.download_id).toBe("download_a");
    expect(second.download_id).toBe("download_b");
    expect(first.output_extension).toBe("mp4");
    expect(second.output_extension).toBe("mp4");
    client.dispose();
  });
});


describe("behaviour flags are wired into the rebuilt loop", () => {
  it("re-keys HLS items with the body-seeded hash (manifest text included)", async () => {
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
    const item = [...harness.service.getEngine().mediaForTab(7).values()][0];
    expect(item?.hash).toBe(
      hlsPlaylistHash(masterPlaylist, new URL("https://cdn.test/master.m3u8")),
    );
    harness.service.stop();
  });

  it("strips query parameters when STRIP_GET_PARAM_WEBSITES is enabled for the page host", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/master.m3u8?token=abc",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 1,
      initBytes: "INIT",
    });
    await harness.service.start();
    // Settings are restored on start(), so mutate the live state afterwards.
    const settings = harness.service.getSettings();
    const updated = setFlag(settings.remote_behaviours, "STRIP_GET_PARAM_WEBSITES", "site.test", true);
    settings.remote_behaviours = { ...settings.remote_behaviours, websites: updated.websites };
    harness.gateway.triggerSendHeaders({
      requestId: "req-master",
      url: "https://cdn.test/master.m3u8?token=abc",
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [],
    });
    await harness.gateway.triggerResponseStarted(
      sniffDetails("https://cdn.test/master.m3u8?token=abc", "application/vnd.apple.mpegurl", {
        initiator: "https://site.test/watch",
      }),
    );
    const item = [...harness.service.getEngine().mediaForTab(7).values()][0];
    expect(item?.master_url?.search).toBe("");
    harness.service.stop();
  });
});

describe("page-adapter media becomes downloadable", () => {
  it("enriches an adapter-provided HLS hint into a playlist item", async () => {
    const harness = createHarness({
      masterUrl: "https://cdn.test/adapt/master.m3u8",
      mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
      mediaPlaylist: fmp4MediaPlaylist,
      segmentPrefix: "https://cdn.test/1080/",
      segments: 1,
      initBytes: "INIT",
    });
    await harness.service.start();
    // Real browsers requested the manifest; the observation allowlist is what permits
    // auto-enrichment of a cross-origin page hint.
    harness.gateway.triggerSendHeaders({
      requestId: "req-adapt",
      url: "https://cdn.test/adapt/master.m3u8",
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [],
    });
    const hinted = itemFromHint(
      {
        url: "https://cdn.test/adapt/master.m3u8",
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
    expect(media).toHaveLength(1);
    expect(media[0]?.type).toBe("m3u8_playlist");
    expect(media[0]?.playlist?.length).toBeGreaterThan(0);
    harness.service.stop();
  });
});

describe("filename validation regression (ellipsis titles)", () => {
  it("downloads a direct file whose title ends with an ellipsis", async () => {
    const mediaUrl = "https://cdn.test/ellipsis.mp4";
    const entries = fetchMapFor({ [mediaUrl]: "x".repeat(1200) });
    const gateway = createFakeGateway("https://site.test/watch", entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const fetchImpl = createFetch(entries);
    const worker = new DownloadWorker({
      channel: hub.endpoint("worker"),
      fetchImpl,
      openRoot: async () => opfs.root,
    });
    worker.start();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ellipsis");
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl,
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_ellipsis",
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
      { url: mediaUrl, source: "player-response", kind: "file", title: "Wait for it..." },
      "https://site.test/watch",
    );
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: {
        name: MSG.contentToService.DoDownload,
        data: { tab_id: 7, media_hash: hinted?.hash },
      },
      channel: Channel.FromContentToService,
    } as Envelope);
    expect(gateway.downloadRequestsLog).toHaveLength(1);
    expect(gateway.downloadRequestsLog[0]?.filename).toContain("Wait for it...");
    service.stop();
  });
});
