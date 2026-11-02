import { MediaDownloaderService } from "../../src/extension/service-worker.js";
import { DownloadWorker } from "../../src/extension/download-worker.js";
import { WorkerClient } from "../../src/extension/worker-client.js";
import { Channel } from "../../src/protocol/channels.js";
import { MSG, type DoDownloadPayload } from "../../src/protocol/messages.js";
import type {
  BroadcastChannelLike,
  BrowserGateway,
  DownloadRequest,
  Envelope,
  TabInfo,
} from "../../src/extension/gateways.js";
import type { MediaItem, TabMeta } from "../../src/core/types.js";
import { createFakeOpfs, createFetch } from "./transfer-fakes.js";

export class FakeChannelHub {
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

export interface FakeGateway extends BrowserGateway {
  triggerResponseStarted(details: Record<string, unknown>): Promise<void>;
  triggerSendHeaders(details: Record<string, unknown>): void;
  deliverToService(envelope: Envelope): Promise<void>;
  /** Verdict the service returned through `respond` during the last delivery, if any. */
  lastServiceResponse(): unknown;
  downloadRequestsLog: DownloadRequest[];
  notificationLog: Array<{ id: string; title: string; message: string }>;
  badgeTextLog: string[];
  menuItemLog: Array<Record<string, unknown>>;
  /** Menu entries the browser would show right now (`removeAll` clears it, like Chrome). */
  contextMenuItems(): Array<Record<string, unknown>>;
  contextMenuRebuildCount(): number;
  contextMenuClickHandlerCount(): number;
  contextMenuDuplicateIds(): string[];
  sessionWriteCount(): number;
  triggerContextMenuClick(
    info: { menuItemId: string | number },
    tab?: TabInfo,
  ): Promise<void>;
  triggerTabActivated(tabId: number, windowId?: number): void;
  triggerTabUpdated(tabId: number, info: { url?: string }): void;
  triggerTabRemoved(tabId: number): void;
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

export function createFakeGateway(tabUrl: string, _fetchMap: Map<string, Uint8Array | string>): FakeGateway {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const runtimeHandlers = new Set<
    (envelope: Envelope, sender: { tab?: { id?: number } }, respond: (response: unknown) => void) => boolean | void
  >();
  let lastServiceResponse: unknown;
  const activatedHandlers = new Set<(info: { tabId: number; windowId: number }) => void>();
  const tabRemovedHandlers = new Set<(tabId: number) => void>();
  const tabUpdatedHandlers = new Set<(tabId: number, info: { url?: string }) => void>();
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
  const menuClickHandlers = new Set<
    (info: { menuItemId: string | number }, tab?: TabInfo) => void
  >();
  const duplicateMenuIds: string[] = [];
  let menuRebuilds = 0;
  let sessionWrites = 0;
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
      onRemoved: (handler) => {
        tabRemovedHandlers.add(handler);
        return () => tabRemovedHandlers.delete(handler);
      },
      onUpdated: (handler) => {
        tabUpdatedHandlers.add(handler);
        return () => tabUpdatedHandlers.delete(handler);
      },
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
          sessionWrites += 1;
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
        const id = String(options.id);
        if (menuItems.some((item) => String(item.id) === id)) duplicateMenuIds.push(id);
        menuItems.push(options);
      },
      removeAll: async () => {
        menuRebuilds += 1;
        menuItems.length = 0;
      },
      onClicked: (handler) => {
        menuClickHandlers.add(handler);
        return () => menuClickHandlers.delete(handler);
      },
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
    triggerContextMenuClick: async (info, tab) => {
      for (const handler of menuClickHandlers) handler({ menuItemId: info.menuItemId }, tab);
      await flush();
      await flush();
    },
    triggerTabActivated: (tabId, windowId = 1) => {
      for (const handler of activatedHandlers) handler({ tabId, windowId });
    },
    triggerTabUpdated: (tabId, info) => {
      for (const handler of tabUpdatedHandlers) handler(tabId, info);
    },
    triggerTabRemoved: (tabId) => {
      for (const handler of tabRemovedHandlers) handler(tabId);
    },
    deliverToService: async (envelope) => {
      lastServiceResponse = undefined;
      let deferred = false;
      for (const handler of runtimeHandlers) {
        if (handler(envelope, { tab: { id: 7 } }, (response) => {
          lastServiceResponse = response;
        }) === true) {
          deferred = true;
        }
      }
      await flush();
      if (deferred) await flush();
    },
    lastServiceResponse: () => lastServiceResponse,
    downloadRequestsLog: downloadsRequests,
    notificationLog: notifications,
    badgeTextLog: badgeTexts,
    menuItemLog: menuItems,
    contextMenuItems: () => menuItems,
    contextMenuRebuildCount: () => menuRebuilds,
    contextMenuClickHandlerCount: () => menuClickHandlers.size,
    contextMenuDuplicateIds: () => duplicateMenuIds,
    sessionWriteCount: () => sessionWrites,
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

export function fetchMapFor(entries: Record<string, string | Uint8Array>): Map<string, string | Uint8Array> {
  return new Map(Object.entries(entries));
}

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const masterPlaylist = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  "https://cdn.test/720/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
  "https://cdn.test/1080/index.m3u8",
].join("\n");

export const fmp4MediaPlaylist = [
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

export const tsMediaPlaylist = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  "seg0.ts",
  "#EXTINF:2.0,",
  "seg1.ts",
  "#EXT-X-ENDLIST",
].join("\n");

export interface Harness {
  service: MediaDownloaderService;
  gateway: FakeGateway;
  worker: DownloadWorker;
  opfs: ReturnType<typeof createFakeOpfs>;
}

export function createHarness(options: {
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

export function sniffDetails(url: string, contentType: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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

/**
 * The download command a panel row sends: media is addressed by tab + hash, and the caller can
 * add the per-row choices (source/entry/format) the panel would have sent.
 */
export const doDownloadEnvelope = (
  media: MediaItem,
  meta: TabMeta,
  choices: Pick<DoDownloadPayload, "preferred_entry" | "output_format" | "source"> = {},
): Envelope =>
  ({
    msg: {
      name: MSG.contentToService.DoDownload,
      data: { tab_id: meta.tab_id, media_hash: media.hash, ...choices },
    },
    channel: Channel.FromContentToService,
  }) as unknown as Envelope;
