/**
 * Narrow interfaces over browser APIs.
 *
 * The original talks to `chrome.*` directly everywhere, which makes its logic impossible to test
 * without a browser. The rebuild keeps every browser call behind one of these seams so the whole
 * loop can be driven by fakes in tests and swapped for `chrome.*` adapters at runtime.
 */
import type { ChannelValue } from "../protocol/channels.js";

/** Envelope carried by every inter-context message (proven wire shape). */
export interface Envelope {
  msg: { name: string; data: unknown };
  channel: ChannelValue;
}

export interface MessageSender {
  tab?: { id?: number };
  /** Sender frame id, when the browser provides it. */
  frameId?: number;
  url?: string;
}

export interface RuntimeGateway {
  /** chrome.runtime.sendMessage — used from pages/scripts to reach the service worker. */
  sendToService(envelope: Envelope): Promise<unknown>;
  /** chrome.runtime.onMessage */
  onMessage(handler: (envelope: Envelope, sender: MessageSender) => void): () => void;
  /** chrome.tabs.sendMessage — service worker → a tab's isolated content script. */
  sendToTab(tabId: number, envelope: Envelope): Promise<void>;
  /** chrome.runtime.getURL */
  getUrl(path: string): string;
  /** chrome.runtime.id */
  readonly id: string;
  /** chrome.runtime.onInstalled */
  onInstalled(handler: (details: { reason: string }) => void): () => void;
  /** Touch the runtime so Chrome does not evict the MV3 worker during long transfers. */
  keepAlive?(): Promise<void>;
}

/** Minimal BroadcastChannel surface (service worker ↔ download worker). */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface WorkerBusGateway {
  /** Opens the shared `worker_service` channel. */
  openWorkerChannel(): BroadcastChannelLike;
}

export interface TabInfo {
  id: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  incognito?: boolean;
  active?: boolean;
  windowId?: number;
}

export interface TabsGateway {
  get(tabId: number): Promise<TabInfo | undefined>;
  query(query: { url?: string; active?: boolean; currentWindow?: boolean }): Promise<TabInfo[]>;
  onRemoved(handler: (tabId: number) => void): () => void;
  onUpdated(handler: (tabId: number, info: { url?: string; status?: string }) => void): () => void;
  onActivated(handler: (info: { tabId: number; windowId: number }) => void): () => void;
}

export interface WebRequestFilter {
  urls: string[];
  types: string[];
}

export interface WebRequestHeader {
  name: string;
  value?: string;
}

export interface WebRequestDetails {
  requestId: string;
  url: string;
  method: string;
  frameId: number;
  parentFrameId: number;
  tabId: number;
  type: string;
  timeStamp: number;
  initiator?: string;
  requestHeaders?: WebRequestHeader[];
  responseHeaders?: WebRequestHeader[];
  statusCode?: number;
  statusLine?: string;
}

export interface WebRequestGateway {
  onSendHeaders(handler: (details: WebRequestDetails) => void, filter: WebRequestFilter, extra: string[]): () => void;
  onResponseStarted(
    handler: (details: WebRequestDetails) => void,
    filter: WebRequestFilter,
    extra: string[],
  ): () => void;
}

export interface DownloadRequest {
  url: string;
  filename: string;
  conflictAction: "uniquify" | "overwrite" | "prompt";
  saveAs: boolean;
  incognito?: boolean;
}

export interface DownloadItem {
  id: number;
  state: "in_progress" | "interrupted" | "complete";
  error?: string;
  filename?: string;
}

export interface DownloadsGateway {
  download(request: DownloadRequest): Promise<number>;
  search(query: { id: number }): Promise<DownloadItem[]>;
  onChanged(handler: (delta: { id: number; state?: { current: string }; error?: { current: string } }) => void): () => void;
  /** Registers the filename hook used to keep the exact name for blob downloads. */
  onDeterminingFilename(handler: (item: { filename: string; url?: string; id?: number; byExtensionId?: boolean; saveAs?: boolean }, suggest: (s: {
    filename: string;
    conflictAction: "uniquify" | "overwrite" | "prompt";
  }) => void) => void): () => void;
  removeFile(id: number): Promise<void>;
  erase(query: { id: number }): Promise<void>;
}

export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(record: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ScriptingGateway {
  /** Runs a function in a tab (MAIN world when requested) and returns its result. */
  executeInTab<Result>(
    tabId: number,
    func: (...args: never[]) => Result,
    args: unknown[],
    options?: { world?: "MAIN" | "ISOLATED"; injectImmediately?: boolean },
  ): Promise<Result | undefined>;
  /** Injects packaged scripts into a tab (used to heal tabs opened before an extension reload). */
  executeFilesInTab(tabId: number, files: string[], options?: { world?: "MAIN" | "ISOLATED" }): Promise<void>;
}

export interface OffscreenGateway {
  /** Creates the offscreen document if it does not exist; tolerates the single-document error. */
  ensureDocument(url: string, reason: string, justification: string): Promise<void>;
}

export interface NotificationsGateway {
  create(id: string, options: { type: "basic"; title: string; message: string; iconUrl?: string }): Promise<void>;
}

export interface ActionGateway {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string | number[] }): Promise<void>;
  setBadgeTextColor(details: { color: string }): Promise<void>;
  setIcon(details: { path: string }): Promise<void>;
  setPopup(details: { popup: string }): Promise<void>;
  openPopup(options?: { windowId?: number }): Promise<void>;
  onClicked(handler: (tab: TabInfo) => void): () => void;
}

export interface ContextMenusGateway {
  create(options: Record<string, unknown>): void;
  removeAll(): Promise<void>;
  onClicked(handler: (info: { menuItemId: string | number }, tab?: TabInfo) => void): () => void;
}

/** All browser seams the service worker needs, injectable as a single object. */
/** Session-scoped header injection (original uses this to replay Referer/Cookie to CDNs). */
export interface NetworkGateway {
  updateSessionRules(options: { addRules?: unknown[]; removeRuleIds?: number[] }): Promise<void>;
  /** Session rules are per-extension; used to clear leftovers after a worker eviction. */
  getSessionRules(): Promise<Array<{ id: number }>>;
}

export interface BrowserGateway {
  runtime: RuntimeGateway;
  network: NetworkGateway;
  tabs: TabsGateway;
  webRequest: WebRequestGateway;
  downloads: DownloadsGateway;
  storage: { local: StorageAreaLike; session: StorageAreaLike };
  scripting: ScriptingGateway;
  offscreen: OffscreenGateway;
  notifications: NotificationsGateway;
  action: ActionGateway;
  contextMenus: ContextMenusGateway;
  workerBus: WorkerBusGateway;
}
