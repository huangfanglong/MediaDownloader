import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService, type SessionState } from "../src/extension/service-worker.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { itemFromHint } from "../src/extension/content-script.js";
import { hlsPlaylistHash } from "../src/discovery/engine.js";
import { setFlag } from "../src/settings/flags.js";
import { WorkerClient } from "../src/extension/worker-client.js";
import { WORKER_SERVICE_CHANNEL } from "../src/protocol/channels.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { REBUILD_MESSAGES, RELAY_MESSAGES } from "../src/protocol/rebuild-messages.js";
import { encode } from "../src/protocol/serde.js";
import { decode } from "../src/protocol/serde.js";
import type { BroadcastChannelLike, BrowserGateway, DownloadRequest, Envelope } from "../src/extension/gateways.js";
import type { FetchLike, FetchResponseLike } from "../src/transfer/fetch.js";
import type { OpfsDirectory, OpfsRoot } from "../src/extension/staging.js";
import type { DownloadPlan, MediaItem, TabMeta } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Fake browser surfaces
// ---------------------------------------------------------------------------

/** Two-endpoint BroadcastChannel stand-in (service worker â†” download worker). */
class FakeChannelHub {
  private readonly endpoints = new Map<string, Set<(event: { data: unknown }) => void>>();

  endpoint(role: string): BroadcastChannelLike {
    if (!this.endpoints.has(role)) this.endpoints.set(role, new Set());
    const listeners = this.endpoints.get(role) as Set<(event: { data: unknown }) => void>;
    return {
      postMessage: (message) => {
        for (const [otherRole, otherListeners] of this.endpoints) {
          if (otherRole === role) continue;
          for (const listener of otherListeners) listener({ data: message });
        }
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => listeners.clear(),
    };
  }
}

interface FakeGateway extends BrowserGateway {
  triggerResponseStarted(details: Record<string, unknown>): Promise<void>;
  triggerSendHeaders(details: Record<string, unknown>): void;
  deliverToService(envelope: Envelope): Promise<void>;
  downloadRequestsLog: DownloadRequest[];
  notificationLog: Array<{ id: string; title: string; message: string }>;
  badgeTextLog: string[];
  menuItemLog: Array<Record<string, unknown>>;
  contentSends: Envelope[];
  runtimeHandlerCount(): number;
  webRequestHandlerCount(): number;
  dnrAdds: Array<unknown>;
  dnrRemovals: number[];
  tabMessages: Envelope[];
  installedHandlers: Set<(details: { reason: string }) => void>;
  injectedFiles: Array<{ tabId: number; files: string[] }>;
  seedDnrSessionRules(ids: number[]): void;
}

function createFakeGateway(tabUrl: string, fetchMap: Map<string, Uint8Array | string>): FakeGateway {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const runtimeHandlers = new Set<(envelope: Envelope, sender: { tab?: { id?: number } }) => void>();
  const activatedHandlers = new Set<(info: { tabId: number; windowId: number }) => void>();
  let sendHeadersHandler: ((details: Record<string, unknown>) => void) | undefined;
  let responseStartedHandler: ((details: Record<string, unknown>) => void) | undefined;
  const downloadChanged = new Set<(delta: { id: number; state?: { current: string } }) => void>();
  const downloadsRequests: DownloadRequest[] = [];
  const notifications: Array<{ id: string; title: string; message: string }> = [];
  const badgeTexts: string[] = [];
  const contentSends: Envelope[] = [];
  const dnrAdds: Array<unknown> = [];
  const tabMessages: Envelope[] = [];
  const installedHandlers = new Set<(details: { reason: string }) => void>();
  const injectedFiles: Array<{ tabId: number; files: string[] }> = [];
  const dnrRemovals: number[] = [];
  const dnrSessionRules: Array<{ id: number }> = [];
  const menuItems: Array<Record<string, unknown>> = [];
  const registeredDownloads = new Map<number, { filename: string }>();
  let nextDownloadId = 1;

  const gateway: FakeGateway = {
    installedHandlers,
    injectedFiles,
    runtime: {
      sendToService: async (envelope) => {
        contentSends.push(envelope);
        return undefined;
      },
      onMessage: (handler) => {
        runtimeHandlers.add(handler);
        return () => runtimeHandlers.delete(handler);
      },
      sendToTab: async (_tabId: number, envelope: Envelope) => {
        tabMessages.push(envelope);
      },
      getUrl: (path) => `chrome-extension://fake${path}`,
      keepAlive: async () => undefined,
      id: "fake-extension-id",
      onInstalled: (handler) => {
        installedHandlers.add(handler);
        return () => installedHandlers.delete(handler);
      },
    },
    tabs: {
      get: async (tabId) => ({
        id: tabId,
        url: tabUrl,
        title: "Test Page",
        incognito: false,
        active: true,
        windowId: 1,
      }),
      query: async () => [{ id: 7, url: tabUrl, title: "Test Page" }],
      onRemoved: () => () => undefined,
      onUpdated: () => () => undefined,
      onActivated: (handler) => {
        activatedHandlers.add(handler);
        return () => activatedHandlers.delete(handler);
      },
    },
    webRequest: {
      onSendHeaders: (handler) => {
        sendHeadersHandler = handler as unknown as (details: Record<string, unknown>) => void;
        return () => undefined;
      },
      onResponseStarted: (handler) => {
        responseStartedHandler = handler as unknown as (details: Record<string, unknown>) => void;
        return () => undefined;
      },
    },
    downloads: {
      download: async (request) => {
        downloadsRequests.push(request);
        const id = nextDownloadId++;
        registeredDownloads.set(id, { filename: request.filename });
        // Complete the download asynchronously, like the browser would.
        setTimeout(() => {
          for (const listener of downloadChanged) listener({ id, state: { current: "complete" } });
        }, 0);
        return id;
      },
      search: async (query) => {
        const entry = registeredDownloads.get(query.id);
        return entry ? [{ id: query.id, state: "complete", filename: `/home/user/Downloads/${entry.filename}` }] : [];
      },
      onChanged: (handler) => {
        downloadChanged.add(handler);
        return () => downloadChanged.delete(handler);
      },
      onDeterminingFilename: () => () => undefined,
      removeFile: async () => undefined,
      erase: async () => undefined,
    },
    storage: {
      local: {
        get: async (key) => (local.has(key) ? { [key]: local.get(key) } : {}),
        set: async (record) => {
          for (const [key, value] of Object.entries(record)) local.set(key, value);
        },
        remove: async (key) => {
          local.delete(key);
        },
      },
      session: {
        get: async (key) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (record) => {
          for (const [key, value] of Object.entries(record)) session.set(key, value);
        },
        remove: async (key) => {
          session.delete(key);
        },
      },
    },
    scripting: {
      executeInTab: async () => ({ title: "Test Page", thumbnail: undefined }) as never,
      executeFilesInTab: async (tabId, files) => {
        injectedFiles.push({ tabId, files: [...files] });
      },
    },
    offscreen: { ensureDocument: async () => undefined },
    notifications: {
      create: async (id: string, options: { title: string; message: string }) => {
        notifications.push({ id, title: options.title, message: options.message });
      },
    },
    action: {
      setBadgeText: async (details) => {
        badgeTexts.push(details.text);
      },
      setBadgeBackgroundColor: async () => undefined,
      setBadgeTextColor: async () => undefined,
      setIcon: async () => undefined,
      setPopup: async () => undefined,
      openPopup: async () => undefined,
      onClicked: () => () => undefined,
    },
    contextMenus: {
      create: (options) => {
        menuItems.push(options);
      },
      removeAll: async () => undefined,
      onClicked: () => () => undefined,
    },
    workerBus: {
      openWorkerChannel: () => channelHub.endpoint("service"),
    },
    network: {
      updateSessionRules: async (options) => {
        for (const rule of options.addRules ?? []) dnrAdds.push(rule);
        for (const id of options.removeRuleIds ?? []) dnrRemovals.push(id);
      },
      getSessionRules: async () => dnrSessionRules,
    },
    triggerResponseStarted: async (details) => {
      responseStartedHandler?.(details);
      await flush();
    },
    triggerSendHeaders: (details) => {
      sendHeadersHandler?.(details);
    },
    deliverToService: async (envelope) => {
      for (const handler of runtimeHandlers) handler(envelope, { tab: { id: 7 } });
      await flush();
    },
    downloadRequestsLog: downloadsRequests,
    notificationLog: notifications,
    badgeTextLog: badgeTexts,
    menuItemLog: menuItems,
    contentSends,
    runtimeHandlerCount: () => runtimeHandlers.size,
    dnrAdds,
    dnrRemovals,
    tabMessages,
    seedDnrSessionRules: (ids) => {
      for (const id of ids) dnrSessionRules.push({ id });
    },
    webRequestHandlerCount: () => (sendHeadersHandler ? 1 : 0) + (responseStartedHandler ? 1 : 0),
  };
  const channelHub = new FakeChannelHub();
  return gateway;
}

function fetchMapFor(entries: Record<string, string | Uint8Array>): Map<string, string | Uint8Array> {
  return new Map(Object.entries(entries));
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function createFetch(entries: Map<string, string | Uint8Array>): FetchLike {
  return async (url): Promise<FetchResponseLike> => {
    const found = entries.get(url);
    if (found === undefined) return { status: 404, ok: false, body: null };
    const data = typeof found === "string" ? bytes(found) : found;
    let sent = false;
    return {
      status: 200,
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: data };
          },
        }),
      },
    };
  };
}

/** In-memory OPFS with sync access handles. `removed` snapshots files deleted after saving. */
function createFakeOpfs(): {
  root: OpfsRoot;
  files: Map<string, Uint8Array[]>;
  removed: Map<string, Uint8Array[]>;
} {
  const files = new Map<string, Uint8Array[]>();
  const removed = new Map<string, Uint8Array[]>();
  const directory: OpfsDirectory = {
    getFileHandleWithSyncAccess: async (name) => ({
      handle: {
        write: async (data) => {
          const chunks = files.get(name) ?? [];
          chunks.push(new Uint8Array(data));
          files.set(name, chunks);
          return { written: data.byteLength };
        },
        close: async () => undefined,
        truncate: async () => undefined,
      },
    }),
    getFileHandle: async (name) => ({
      name,
      getFile: async () =>
        new Blob((files.get(name) ?? []).map((chunk) => new Blob([chunk as unknown as BlobPart]))) as File,
    }),
    removeEntry: async (name) => {
      const chunks = files.get(name);
      if (chunks) removed.set(name, chunks.map((chunk) => new Uint8Array(chunk)));
      files.delete(name);
    },
    keys: async function* () {
      yield* files.keys();
    },
  };
  return {
    root: { getDirectoryHandle: async () => directory },
    files,
    removed,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const masterPlaylist = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  "https://cdn.test/720/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
  "https://cdn.test/1080/index.m3u8",
].join("\n");

const fmp4MediaPlaylist = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:2",
  "#EXT-X-MAP:URI=\"init.mp4\"",
  "#EXTINF:2.0,",
  "seg0.m4s",
  "#EXTINF:2.0,",
  "seg1.m4s",
  "#EXTINF:2.0,",
  "seg2.m4s",
  "#EXT-X-ENDLIST",
].join("\n");

const tsMediaPlaylist = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  "seg0.ts",
  "#EXTINF:2.0,",
  "seg1.ts",
  "#EXT-X-ENDLIST",
].join("\n");

interface Harness {
  service: MediaDownloaderService;
  gateway: FakeGateway;
  worker: DownloadWorker;
  opfs: ReturnType<typeof createFakeOpfs>;
}

function createHarness(options: {
  masterUrl: string;
  mediaPlaylistUrl: string;
  mediaPlaylist: string;
  segmentPrefix: string;
  segments: number;
  initBytes?: string;
}): Harness {
  const entries = fetchMapFor({
    [options.masterUrl]: masterPlaylist,
    [options.mediaPlaylistUrl]: options.mediaPlaylist,
    "https://cdn.test/720/index.m3u8": fmp4MediaPlaylist,
  });
  if (options.initBytes !== undefined) entries.set(`${options.segmentPrefix}init.mp4`, options.initBytes);
  for (let index = 0; index < options.segments; index++) {
    const name = options.mediaPlaylist.includes(".m4s") ? `seg${index}.m4s` : `seg${index}.ts`;
    // Payloads exceed the proven minimum-output gate (1000 bytes) so assembly succeeds.
    entries.set(`${options.segmentPrefix}${name}`, `${index}:${"x".repeat(700)}`);
  }
  const gateway = createFakeGateway("https://site.test/watch", entries);
  const opfs = createFakeOpfs();
  const channelHub = new FakeChannelHub();
  const fetchImpl = createFetch(entries);
  const worker = new DownloadWorker({
    channel: channelHub.endpoint("worker"),
    fetchImpl,
    openRoot: async () => opfs.root,
  });
  worker.start();
  const workerClient = new WorkerClient({
    channel: channelHub.endpoint("service"),
    offscreen: gateway.offscreen,
    offscreenUrl: "chrome-extension://fake/factory/factory.html",
    readyTimeoutMs: 200,
  });
  const service = new MediaDownloaderService({
    gateway,
    fetchImpl,
    opfsRoot: async () => opfs.root,
    downloadIdFactory: () => "download_test",
    now: () => 1_700_000_000_000,
    workerClient,
  });
  return { service, gateway, worker, opfs };
}

function sniffDetails(url: string, contentType: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: `req-${url}`,
    url,
    tabId: 7,
    frameId: 0,
    type: "xmlhttprequest",
    statusCode: 200,
    timeStamp: 1_700_000_000_000,
    responseHeaders: [{ name: "content-type", value: contentType }],
    ...extra,
  };
}

const doDownloadEnvelope = (media: MediaItem, meta: TabMeta): Envelope =>
  ({
    msg: {
      name: MSG.contentToService.DoDownload,
      data: { download_args: undefined, meta, media },
    },
    channel: Channel.FromContentToService,
  }) as unknown as Envelope;

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
    // No await: the constructor must already have mounted the runtime listener.
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

describe("CDN header replay (live YouTube 403 regression)", () => {
  it("replays non-credential Referer through an exact session DNR rule and never replays Cookie", async () => {
    const mediaUrl = "https://cdn.test/videoplayback?id=abc&itag=18";
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
    // The page's own request carried the headers the CDN expects (range variants are normalised).
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
      msg: {
        name: MSG.contentToService.DoDownload,
        data: { tab_id: 7, media_hash: hinted?.hash },
      },
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
    const worker = new DownloadWorker({
      channel: hub.endpoint("worker"),
      fetchImpl,
      openRoot: async () => opfs.root,
    });
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
      msg: {
        name: MSG.contentToService.DoDownload,
        data: { tab_id: 7, media_hash: hinted?.hash },
      },
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
        data: {
          request_id: relayRequest?.request_id,
          seq: 0,
          data: Buffer.from(body).toString("base64"),
        },
      },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: {
        name: RELAY_MESSAGES.MediaStreamEnd,
        data: { request_id: relayRequest?.request_id, total: body.length },
      },
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
    const worker = new DownloadWorker({
      channel: hub.endpoint("worker"),
      fetchImpl: rangedFetch,
      openRoot: async () => opfs.root,
    });
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
    const worker = new DownloadWorker({
      channel: hub.endpoint("worker"),
      fetchImpl: failingFetch,
      openRoot: async () => opfs.root,
    });
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
    // The badge must count what the panel shows, not the raw registry size.
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
          url: `https://rr1---sn-x.googlevideo.com/videoplayback?id=o-${id}&itag=136&sig=${sig}` ,
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

describe("header replay context binding (P1 hardening)", () => {
  it("does not replay headers captured in a different tab", async () => {
    const mediaUrl = "https://cdn.test/context?id=abc&itag=18";
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
    // Captured in tab 8, but the download is addressed to tab 7.
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
      msg: {
        name: MSG.contentToService.DoDownload,
        data: { tab_id: 7, media_hash: hinted?.hash },
      },
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
      {
        url: "http://127.0.0.1:9/master.m3u8",
        source: "player-response",
        kind: "hls",
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

describe("manifest preview fallback (non-mainstream/Twitter)", () => {
  it("gives an HLS row the direct video track detected on the same page", async () => {
    const pageUrl = "https://x.com/PaulGolding/status/2111588792050262257/video/1";
    const base = "https://video.twimg.com/amplify_video/2112224026076553216";
    const entries = fetchMapFor({});
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

    // With several direct videos on the page, an HLS asset with no matching direct track must
    // stay poster-only instead of inheriting an unrelated video's preview.
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
