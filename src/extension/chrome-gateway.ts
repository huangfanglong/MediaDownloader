/**
 * `chrome.*` adapters for the injected browser gateway.
 *
 * Every browser call in the rebuilt loop goes through `BrowserGateway`; this file is the only
 * place that knows about Chrome's callback/promise duality and API shape differences. Chrome's
 * typings vary across `@types/chrome` releases, so the raw namespace is treated structurally at
 * this single boundary and every adapter converts to our own stable types immediately.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  ActionGateway,
  BrowserGateway,
  ContextMenusGateway,
  DownloadItem,
  DownloadsGateway,
  Envelope,
  MessageSender,
  NetworkGateway,
  NotificationsGateway,
  OffscreenGateway,
  RuntimeGateway,
  ScriptingGateway,
  StorageAreaLike,
  TabInfo,
  TabsGateway,
  WebRequestDetails,
  WebRequestGateway,
  WorkerBusGateway,
} from "./gateways.js";
import { WORKER_SERVICE_CHANNEL } from "../protocol/channels.js";

type ChromeNamespace = any;

const chromeApi = (): ChromeNamespace => {
  const api = (globalThis as { chrome?: ChromeNamespace }).chrome;
  if (!api) throw new Error("chrome API is unavailable in this context");
  return api;
};

const toTabInfo = (tab: ChromeNamespace): TabInfo => ({
  id: tab.id ?? -1,
  ...(tab.url ? { url: tab.url } : {}),
  ...(tab.title ? { title: tab.title } : {}),
  ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
  ...(tab.incognito !== undefined ? { incognito: tab.incognito } : {}),
  ...(tab.active !== undefined ? { active: tab.active } : {}),
  ...(tab.windowId !== undefined ? { windowId: tab.windowId } : {}),
});

const headers = (list: ChromeNamespace[] | undefined): Array<{ name: string; value?: string }> =>
  (list ?? []).map((header: ChromeNamespace) => ({
    name: header.name,
    ...(header.value !== undefined ? { value: header.value } : {}),
  }));

const runtimeGateway = (): RuntimeGateway => {
  const api = chromeApi();
  return {
    sendToService: (envelope) => api.runtime.sendMessage(envelope) as Promise<unknown>,
    onMessage: (handler) => {
      const listener = (message: unknown, sender: ChromeNamespace): void => {
        const mapped: MessageSender = {
          ...(sender?.tab?.id !== undefined ? { tab: { id: sender.tab.id } } : {}),
          ...(sender?.frameId !== undefined ? { frameId: sender.frameId } : {}),
          ...(sender?.url ? { url: sender.url } : {}),
        };
        handler(message as Envelope, mapped);
      };
      api.runtime.onMessage.addListener(listener);
      return () => api.runtime.onMessage.removeListener(listener);
    },
    sendToTab: async (tabId, envelope) => {
      await api.tabs.sendMessage(tabId, envelope);
    },
    getUrl: (path) => api.runtime.getURL(path),
    keepAlive: async () => {
      await api.runtime.getPlatformInfo();
    },
    id: api.runtime.id,
    onInstalled: (handler) => {
      const listener = (details: ChromeNamespace): void => handler({ reason: details.reason });
      api.runtime.onInstalled.addListener(listener);
      return () => api.runtime.onInstalled.removeListener(listener);
    },
  };
};

const tabsGateway = (): TabsGateway => {
  const api = chromeApi();
  return {
    get: async (tabId) => {
      try {
        return toTabInfo(await api.tabs.get(tabId));
      } catch {
        return undefined;
      }
    },
    query: async (query) => (await api.tabs.query(query)).map(toTabInfo),
    onRemoved: (handler) => {
      const listener = (tabId: number): void => handler(tabId);
      api.tabs.onRemoved.addListener(listener);
      return () => api.tabs.onRemoved.removeListener(listener);
    },
    onUpdated: (handler) => {
      const listener = (tabId: number, info: ChromeNamespace): void =>
        handler(tabId, { ...(info.url ? { url: info.url } : {}), ...(info.status ? { status: info.status } : {}) });
      api.tabs.onUpdated.addListener(listener);
      return () => api.tabs.onUpdated.removeListener(listener);
    },
    onActivated: (handler) => {
      const listener = (info: ChromeNamespace): void =>
        handler({ tabId: info.tabId, windowId: info.windowId });
      api.tabs.onActivated.addListener(listener);
      return () => api.tabs.onActivated.removeListener(listener);
    },
  };
};

const webRequestGateway = (): WebRequestGateway => {
  const api = chromeApi();
  const toDetails = (details: ChromeNamespace): WebRequestDetails => ({
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    frameId: details.frameId,
    parentFrameId: details.parentFrameId,
    tabId: details.tabId,
    type: details.type,
    timeStamp: details.timeStamp,
    ...(details.initiator ? { initiator: details.initiator } : {}),
    ...(details.requestHeaders ? { requestHeaders: headers(details.requestHeaders) } : {}),
    ...(details.responseHeaders ? { responseHeaders: headers(details.responseHeaders) } : {}),
    ...(details.statusCode !== undefined ? { statusCode: details.statusCode } : {}),
    ...(details.statusLine ? { statusLine: details.statusLine } : {}),
  });
  return {
    onSendHeaders: (handler, filter, extra) => {
      const listener = (details: ChromeNamespace): void => handler(toDetails(details));
      api.webRequest.onSendHeaders.addListener(listener, filter, extra);
      return () => api.webRequest.onSendHeaders.removeListener(listener);
    },
    onResponseStarted: (handler, filter, extra) => {
      const listener = (details: ChromeNamespace): void => handler(toDetails(details));
      api.webRequest.onResponseStarted.addListener(listener, filter, extra);
      return () => api.webRequest.onResponseStarted.removeListener(listener);
    },
  };
};

const downloadsGateway = (): DownloadsGateway => {
  const api = chromeApi();
  return {
    download: (request) => api.downloads.download(request),
    search: async (query) => {
      const items: ChromeNamespace[] = await api.downloads.search({ id: query.id });
      return items.map(
        (item): DownloadItem => ({
          id: item.id,
          state: item.state,
          ...(item.error ? { error: item.error } : {}),
          ...(item.filename ? { filename: item.filename } : {}),
        }),
      );
    },
    onChanged: (handler) => {
      const listener = (delta: ChromeNamespace): void =>
        handler({
          id: delta.id,
          ...(delta.state?.current ? { state: { current: delta.state.current } } : {}),
          ...(delta.error?.current ? { error: { current: delta.error.current } } : {}),
        });
      api.downloads.onChanged.addListener(listener);
      return () => api.downloads.onChanged.removeListener(listener);
    },
    onDeterminingFilename: (handler) => {
      const listener = (item: ChromeNamespace, suggest: ChromeNamespace): void => {
        handler(
          {
            filename: item.filename,
            ...(typeof item.url === "string" ? { url: item.url } : {}),
            ...(typeof item.id === "number" ? { id: item.id } : {}),
            ...(item.byExtensionId ? { byExtensionId: true, saveAs: false } : {}),
          },
          suggest,
        );
      };
      api.downloads.onDeterminingFilename.addListener(listener);
      return () => api.downloads.onDeterminingFilename.removeListener(listener);
    },
    removeFile: (id) => api.downloads.removeFile(id),
    erase: async (query) => {
      await api.downloads.erase(query);
    },
  };
};

const storageArea = (area: ChromeNamespace): StorageAreaLike => ({
  get: async (key) => ((await area.get(key)) as Record<string, unknown>) ?? {},
  set: (record) => area.set(record),
  remove: (key) => area.remove(key),
});

const scriptingGateway = (): ScriptingGateway => {
  const api = chromeApi();
  return {
    async executeFilesInTab(tabId, files, options) {
      await api.scripting.executeScript({
        target: { tabId },
        files,
        ...(options?.world ? { world: options.world } : {}),
      });
    },
    async executeInTab(tabId, func, args, options) {
      const results: ChromeNamespace[] = await api.scripting.executeScript({
        target: { tabId },
        func,
        args,
        ...(options?.world ? { world: options.world } : {}),
        ...(options?.injectImmediately ? { injectImmediately: true } : {}),
      });
      return results[0]?.result as never;
    },
  };
};

const offscreenGateway = (): OffscreenGateway => ({
  ensureDocument: async (url, reason, justification) => {
    const api = chromeApi();
    try {
      await api.offscreen.createDocument({ url, reasons: [reason], justification });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "Only a single offscreen document may be created.") throw error;
    }
  },
});

const notificationsGateway = (): NotificationsGateway => ({
  create: async (id, options) => {
    await chromeApi().notifications.create(id, options);
  },
});

const actionGateway = (): ActionGateway => {
  const api = chromeApi();
  return {
    setBadgeText: async (details) => {
      await api.action.setBadgeText(details);
    },
    setBadgeBackgroundColor: async (details) => {
      await api.action.setBadgeBackgroundColor(details);
    },
    setBadgeTextColor: async (details) => {
      await api.action.setBadgeTextColor?.(details);
    },
    setIcon: async (details) => {
      await api.action.setIcon(details);
    },
    setPopup: async (details) => {
      await api.action.setPopup(details);
    },
    openPopup: async (options) => {
      await api.action.openPopup(options ?? {});
    },
    onClicked: (handler) => {
      const listener = (tab: ChromeNamespace): void => handler(toTabInfo(tab));
      api.action.onClicked.addListener(listener);
      return () => api.action.onClicked.removeListener(listener);
    },
  };
};

const contextMenusGateway = (): ContextMenusGateway => {
  const api = chromeApi();
  return {
    create: (options) => {
      api.contextMenus.create(options);
    },
    removeAll: async () => {
      await api.contextMenus.removeAll();
    },
    onClicked: (handler) => {
      const listener = (info: ChromeNamespace, tab?: ChromeNamespace): void =>
        handler({ menuItemId: info.menuItemId }, tab ? toTabInfo(tab) : undefined);
      api.contextMenus.onClicked.addListener(listener);
      return () => api.contextMenus.onClicked.removeListener(listener);
    },
  };
};

const networkGateway = (): NetworkGateway => ({
  updateSessionRules: async (options) => {
    await chromeApi().declarativeNetRequest.updateSessionRules(options);
  },
  getSessionRules: async () => {
    const rules = await chromeApi().declarativeNetRequest.getSessionRules();
    return rules.map((rule: { id: number }) => ({ id: rule.id }));
  },
});

const workerBusGateway = (): WorkerBusGateway => ({
  openWorkerChannel: () => new BroadcastChannel(WORKER_SERVICE_CHANNEL),
});

/** Build the real Chrome gateway. */
export function createChromeGateway(): BrowserGateway {
  const api = chromeApi();
  return {
    runtime: runtimeGateway(),
    network: networkGateway(),
    tabs: tabsGateway(),
    webRequest: webRequestGateway(),
    downloads: downloadsGateway(),
    storage: { local: storageArea(api.storage.local), session: storageArea(api.storage.session) },
    scripting: scriptingGateway(),
    offscreen: offscreenGateway(),
    notifications: notificationsGateway(),
    action: actionGateway(),
    contextMenus: contextMenusGateway(),
    workerBus: workerBusGateway(),
  };
}
