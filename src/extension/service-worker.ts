/**
 * Service-worker composition root: the rebuilt loop.
 *
 * Evidence: 01-messaging-runtime.md (topology, message catalogue, settings, UI contract),
 * 02-detection-pipeline.md (sniffing/registry), 03-manifest-resolution.md (enrichment, plans),
 * 04-download-transfer.md (queue, worker handshake, save).
 *
 * All browser APIs come through `BrowserGateway`, so this file can be driven end-to-end by fakes
 * in `test/integration.test.ts`.
 */
import type {
  BrowserGateway,
  DownloadItem,
  Envelope,
  TabInfo,
  WebRequestDetails,
} from "./gateways.js";
import type {
  DownloadPlan,
  DownloadProgress,
  MediaItem,
  TabMeta,
  TransferOutcome,
} from "../core/types.js";
import { httpFailureReason, otherFailureReason, userAbortReason } from "../core/types.js";
import { Channel } from "../protocol/channels.js";
import { MSG, type DoDownloadPayload } from "../protocol/messages.js";
import { decode, encode } from "../protocol/serde.js";
import { buildPanelSnapshot, type PanelSnapshot } from "./panel-snapshot.js";
import { debugInfo } from "./log.js";
import { filterFocusedMedia, focusKey, type MediaFocusState } from "./focus.js";
import { releaseMatchingMedia, restoreMatchingMedia } from "./playback-coordination.js";
import { REBUILD_MESSAGES, RELAY_MESSAGES } from "../protocol/rebuild-messages.js";
import type { Result } from "../core/option.js";
import { isErr } from "../core/option.js";
import { DiscoveryEngine, SNIFF_RESOURCE_TYPES, type BehaviourGate } from "../discovery/engine.js";
import { buildPlan } from "../plan/build.js";
import { applyOutputFormat, normalizeOutputFormat } from "../plan/output-format.js";
import { buildPreviewPlan } from "../plan/strategies.js";
import { fetchBytes, headersForPlan, type FetchLike } from "../transfer/fetch.js";
import { declaredSize, isRangeBoundCdn } from "../transfer/ranged.js";
import {
  isSafeManifestUrl,
  manifestEnrichmentAllowed,
  observedRequestKey,
} from "../transfer/url-safety.js";
import {
  buildDownloadRequest,
  composeFilename,
  mapDownloadTerminalState,
  type DownloadTerminalState,
} from "../transfer/save.js";
import { DownloadQueue } from "../transfer/queue.js";
import {
  createDefaultSettings,
  applySettingsMutation,
  decodeState,
  encodeState,
  pruneDownloadHistory,
} from "../settings/local.js";
import type { PersistentSettings } from "../settings/local.js";
import { isFlagEnabled, type Behaviours } from "../settings/flags.js";
import {
  composeContextMenuItems,
  type ContextMenuItem,
} from "./context-menu.js";
import { computeBadge } from "./badge.js";
import { createWorkerChannel, WorkerClient } from "./worker-client.js";
import { openOpfsRoot, removeStagedFile, type OpfsRoot } from "./staging.js";
import { detectPlatform, type PlatformProfile } from "./platform.js";
import { loadSmartnaming, materializeRule, selectRule } from "../naming/rules.js";
import { isSafePathComponent } from "../naming/safe-path.js";
import { HeaderReplay, normalizeHeaderReplayUrl } from "./header-replay.js";
import { ManifestEnrichment } from "./manifest-enrichment.js";
import { TabHealing } from "./tab-healing.js";

/** Storage keys proven in the original (01 §5). */
export const PERSISTENT_KEY = "global_persistent_state";
export const SESSION_KEY = "global_session_state";
/** Offscreen document that hosts the download worker. */
export const OFFSCREEN_URL = "/factory/factory.html";

export interface DownloadingEntry {
  bitrate: number;
  status: "queuing" | "downloading" | "finalizing";
  download_args: DownloadPlan;
  media: MediaItem;
  meta: TabMeta;
  percent?: number;
  fetched_bytes_count?: number;
  output_duration_s?: number;
  /** Timestamp of the last byte sample; used only for interval download speed. */
  progress_sample_at?: number;
}

export function applyDownloadProgress(entry: DownloadingEntry, progress: DownloadProgress, now: number): void {
  if (progress.status === "finalizing") {
    entry.status = "finalizing";
    return;
  }
  if (progress.status !== "downloading") return;
  entry.status = "downloading";
  if (progress.percent !== undefined && progress.percent.is_known) entry.percent = progress.percent.value;
  if (progress.output_duration_s !== undefined) entry.output_duration_s = progress.output_duration_s;
  const fetched = progress.fetched_bytes_count;
  if (fetched === undefined || !Number.isFinite(fetched) || fetched < 0) return;
  const previousBytes = entry.fetched_bytes_count;
  const previousAt = entry.progress_sample_at;
  if (previousBytes !== undefined && fetched < previousBytes) entry.bitrate = 0;
  if (
    previousBytes !== undefined &&
    previousAt !== undefined &&
    fetched >= previousBytes &&
    now > previousAt
  ) {
    entry.bitrate = (fetched - previousBytes) * 8 * 1000 / (now - previousAt);
  }
  entry.fetched_bytes_count = fetched;
  entry.progress_sample_at = now;
}

export interface NotificationRecord {
  type:
    | "tos"
    | "download_error"
    | "download_interrupted"
    | "limit_youtube"
    | "no_youtube"
    | "youtube_403";
  timestamp?: number;
  details?: string;
  message?: string;
  url?: URL;
  favicon?: URL;
  media_type?: string;
  has_drm?: boolean;
}

export interface DownloadedRecord {
  downloaded_id: string;
  path: string;
  browser_download_id: number;
  media_hash: string;
  download_timestamp: number;
  origin_url: string | null;
  origin_favicon_url: string | null;
  has_drm: boolean;
  subdir?: string;
}

export interface TabDiscovered {
  meta?: TabMeta;
  media: Map<string, MediaItem>;
}

export interface SessionState {
  current_win_tab: { tab_id?: number; win_id?: number };
  discovered: Map<number, TabDiscovered>;
  downloading: Map<string, DownloadingEntry>;
  notifications: Map<string, NotificationRecord>;
  transient_history: DownloadedRecord[];
}

export interface ServiceWorkerOptions {
  gateway: BrowserGateway;
  fetchImpl: FetchLike;
  now?: () => number;
  downloadIdFactory?: () => string;
  /** OPFS access, injectable for tests. */
  opfsRoot?: () => Promise<OpfsRoot | undefined>;
  platform?: PlatformProfile;
  queue?: DownloadQueue;
  workerClient?: WorkerClient;
}

const createSessionState = (): SessionState => ({
  current_win_tab: {},
  discovered: new Map(),
  downloading: new Map(),
  notifications: new Map(),
  transient_history: [],
});

export class MediaDownloaderService {
  private readonly gateway: BrowserGateway;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly downloadIdFactory: () => string;
  private readonly opfsRoot: () => Promise<OpfsRoot | undefined>;
  private readonly platform: PlatformProfile;
  private readonly engine: DiscoveryEngine;
  private readonly queue: DownloadQueue;
  private readonly worker: WorkerClient;
  private settings: PersistentSettings = createDefaultSettings();
  private session: SessionState = createSessionState();
  private readonly disposers: Array<() => void> = [];
  /** Resolved once `start()` has restored state; handlers registered synchronously await it. */
  private readonly ready: Promise<void>;
  private lastSnapshotPushAt = 0;
  /** Focused media identities reported by the page (QOL: show the playing clip only). */
  private readonly focusByTab = new Map<number, MediaFocusState>();
  /** Direct video tracks seen per tab, used to give manifest rows a hover preview. */
  private readonly previewsByTab = new Map<number, { byAsset: Map<string, string> }>();
  /** Exact names to re-assert for extension-originated blob downloads. */
  private readonly pendingDownloadNames = new Map<string, string>();
  private readonly enriching = new Set<string>();
  private readonly headerReplay: HeaderReplay;
  private readonly manifests: ManifestEnrichment;
  private readonly tabHealing: TabHealing;
  /** Media hashes with a download in flight (review 4.1 duplicate downloads). */
  private readonly activeMediaHashes = new Set<string>();
  /** Page-relay request id -> download id (review: protected CDNs). */
  private readonly relayRequests = new Map<string, { downloadId: string; seq: number }>();
  /** Keeps the MV3 worker alive while transfers run (review 4.2). */
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  /** URLs the browser actually requested per tab (for safe manifest auto-enrichment). */
  private readonly observedRequests = new Map<number, Set<string>>();
  private lastSnapshotSignature = "";
  private markReady!: () => void;

  constructor(options: ServiceWorkerOptions) {
    this.gateway = options.gateway;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => Date.now());
    this.downloadIdFactory = options.downloadIdFactory ?? (() => `download_${crypto.randomUUID()}`);
    this.opfsRoot = options.opfsRoot ?? openOpfsRoot;
    this.platform =
      options.platform ??
      detectPlatform({
        hasBrowserNamespace: typeof (globalThis as { browser?: unknown }).browser !== "undefined",
        userAgent: globalThis.navigator?.userAgent ?? "",
        hasSidePanel: typeof (this.gateway as { sidePanel?: unknown }).sidePanel !== "undefined",
      });
    const gate: BehaviourGate = {
      enabled: (flag, host) => isFlagEnabled(this.settings.remote_behaviours, flag, host),
    };
    this.engine = new DiscoveryEngine({ flags: gate, now: this.now });
    this.headerReplay = new HeaderReplay(this.gateway.network, this.now);
    this.manifests = new ManifestEnrichment(this.fetchImpl, this.engine, this.now);
    this.tabHealing = new TabHealing(this.gateway);
    this.queue =
      options.queue ??
      new DownloadQueue(
        this.settings.max_concurrent_downloads,
        this.settings.youtube_throttle ? 1 : this.settings.max_concurrent_downloads,
        6000,
      );
    this.worker =
      options.workerClient ??
      new WorkerClient({
        channel: createWorkerChannel((name) => this.gateway.workerBus.openWorkerChannel()),
        offscreen: this.gateway.offscreen,
        offscreenUrl: this.gateway.runtime.getUrl(OFFSCREEN_URL),
        onLateOutcome: (outcome) => {
          if (outcome.internal_filename === undefined) return;
          void this.opfsRoot()
            .then((root) => root ? removeStagedFile(root, outcome.internal_filename as string) : undefined)
            .catch(() => undefined);
        },
      });

    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
    // MV3 wakes the service worker for events only when listeners were added synchronously in
    // the first task. Register them here; every handler awaits `ready` before touching state.
    this.subscribeWebRequest();
    this.subscribeTabs();
    this.subscribeMessages();
    this.subscribeDownloadNames();
    // On install/update every already-open tab still runs the PREVIOUS extension context's
    // content scripts. Force a fresh injection there so updates do not silently kill detection.
    this.disposers.push(
      this.gateway.runtime.onInstalled(() => {
        void this.tabHealing.heal(true);
      }),
    );
    console.info("[media-downloader] service worker constructed");
  }

  /** Read-only views used by tests and the panel. */
  getSettings(): PersistentSettings {
    return this.settings;
  }

  getSession(): SessionState {
    return this.session;
  }

  getQueue(): DownloadQueue {
    return this.queue;
  }

  getEngine(): DiscoveryEngine {
    return this.engine;
  }

  /** Boot: restore state, purge staging, publish. Listeners are already registered. */
  async start(): Promise<void> {
    try {
      await this.restoreState();
      await this.headerReplay.clearStaleRules();
      await this.resolveCurrentTab();
      await this.syncContextMenus();
      await this.publish();
      void this.tabHealing.heal();
      console.info("[media-downloader] service worker ready");
    } catch (error) {
      console.error("[media-downloader] service worker start failed", error);
    } finally {
      this.markReady();
    }
  }

  stop(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.worker.dispose();
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private async restoreState(): Promise<void> {
    const stored = (await this.gateway.storage.local.get(PERSISTENT_KEY).catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (stored[PERSISTENT_KEY] !== undefined) {
      this.settings = decodeState(stored[PERSISTENT_KEY]);
    }
    const sessionStored = (await this.gateway.storage.session.get(SESSION_KEY).catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (sessionStored[SESSION_KEY] !== undefined) {
      this.session = decode(sessionStored[SESSION_KEY]) as SessionState;
    }
    if (pruneDownloadHistory(this.settings, this.now())) await this.persistSettings();
  }

  private async persistSettings(): Promise<void> {
    await this.gateway.storage.local
      .set({ [PERSISTENT_KEY]: encodeState(this.settings) })
      .catch(() => undefined);
  }

  /** Track the active tab from boot; later kept in sync by `tabs.onActivated`. */
  private async resolveCurrentTab(): Promise<void> {
    if (this.session.current_win_tab.tab_id !== undefined) return;
    const [active] = await this.gateway.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (active?.id !== undefined) {
      this.session.current_win_tab = {
        tab_id: active.id,
        ...(active.windowId !== undefined ? { win_id: active.windowId } : {}),
      };
    }
  }

  private async persistSession(): Promise<void> {
    await this.gateway.storage.session
      .set({ [SESSION_KEY]: encode(redactSessionForStorage(this.session)) })
      .catch(() => undefined);
  }

  /** Push observable state (badge, icon, session snapshot) to the browser UI. */
  async publish(): Promise<void> {
    this.pushPanelSnapshot();
    await this.persistSession();
    const currentTab = this.session.current_win_tab.tab_id;
    const visibleMedia = filterFocusedMedia(
      currentTab === undefined ? [] : [...(this.engine.mediaForTab(currentTab)?.values() ?? [])],
      currentTab === undefined ? undefined : this.focusByTab.get(currentTab),
      this.now(),
    );
    const mediaCount = visibleMedia.length;
    const badge = computeBadge({
      notificationCount: this.session.notifications.size,
      downloadingCount: this.session.downloading.size,
      mediaCount,
    });
    await this.gateway.action.setBadgeText({ text: badge.text }).catch(() => undefined);
    if (badge.backgroundColor !== undefined) {
      await this.gateway.action.setBadgeBackgroundColor({ color: badge.backgroundColor }).catch(() => undefined);
    }
    if (badge.text !== "") {
      await this.gateway.action.setBadgeTextColor({ color: badge.textColor ?? "white" }).catch(() => undefined);
    }
    this.refreshKeepAlive();
  }

  /** Keep the MV3 worker alive while transfers are in flight (review 4.2). */
  private refreshKeepAlive(): void {
    const active = this.session.downloading.size > 0;
    if (active && this.keepAliveTimer === undefined) {
      this.keepAliveTimer = setInterval(() => {
        void this.gateway.runtime.keepAlive?.().catch(() => undefined);
      }, 20_000);
    } else if (!active && this.keepAliveTimer !== undefined) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  /** Tell open panel pages about state changes. Push immediately when the observable state
   * changes; throttle plain progress updates to keep them cheap. */
  private pushPanelSnapshot(): void {
    const snapshot = this.panelSnapshot();
    const signature = [
      snapshot.tab_id ?? -1,
      snapshot.media.length,
      snapshot.downloading.length,
      snapshot.notifications.length,
      snapshot.notifications[0]?.message ?? "",
    ].join(":");
    const now = this.now();
    if (signature === this.lastSnapshotSignature && now - this.lastSnapshotPushAt < 250) return;
    this.lastSnapshotSignature = signature;
    this.lastSnapshotPushAt = now;
    this.sendToContent({
      msg: { name: REBUILD_MESSAGES.SessionSnapshot, data: encode(snapshot) },
      channel: Channel.FromServiceToContent,
    });
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  private subscribeWebRequest(): void {
    const filter = { urls: ["<all_urls>"], types: [...SNIFF_RESOURCE_TYPES] };
    const requestExtra = this.platform.needsExtraHeaders
      ? ["requestHeaders", "extraHeaders"]
      : ["requestHeaders"];
    const responseExtra = this.platform.needsExtraHeaders
      ? ["responseHeaders", "extraHeaders"]
      : ["responseHeaders"];

    const register = (
      kind: "onSendHeaders" | "onResponseStarted",
      handler: (details: WebRequestDetails) => void,
      extra: string[],
    ): void => {
      const mount = (spec: string[]): (() => void) =>
        kind === "onSendHeaders"
          ? this.gateway.webRequest.onSendHeaders(handler, filter, spec)
          : this.gateway.webRequest.onResponseStarted(handler, filter, spec);
      try {
        this.disposers.push(mount(extra));
      } catch (error) {
        console.warn("[media-downloader] webRequest registration failed, retrying without extraHeaders", error);
        this.disposers.push(mount(extra.filter((entry) => entry !== "extraHeaders")));
      }
    };
    register(
      "onSendHeaders",
        (details) => {
          this.engine.onSendHeaders({
            requestId: details.requestId,
            url: details.url,
            tabId: details.tabId,
            frameId: details.frameId,
            type: details.type,
            timeStamp: details.timeStamp,
            requestHeaders: details.requestHeaders ?? [],
            ...(details.initiator ? { initiator: details.initiator } : {}),
          });
          this.rememberObservedRequest(details.tabId, details.url);
          if (details.requestHeaders && details.requestHeaders.length > 0) {
            this.headerReplay.remember(details.url, details.requestHeaders, {
              tabId: details.tabId,
              frameId: details.frameId,
              ...(details.initiator ? { initiator: details.initiator } : {}),
            });
          }
        },
        requestExtra,
      );
    register(
      "onResponseStarted",
        (details) => {
          this.rememberObservedRequest(details.tabId, details.url);
          void this.handleResponse(details);
        },
        responseExtra,
      );
  }

  private subscribeTabs(): void {
    this.disposers.push(
      this.gateway.tabs.onRemoved((tabId) => {
        this.engine.clearTab(tabId);
        this.focusByTab.delete(tabId);
        this.previewsByTab.delete(tabId);
        this.observedRequests.delete(tabId);
        this.session.discovered.delete(tabId);
        if (this.session.current_win_tab.tab_id === tabId) this.session.current_win_tab = {};
        void this.publish();
      }),
    );
    this.disposers.push(
      this.gateway.tabs.onUpdated((tabId, info) => {
        // The original drops the tab's discovered media on main-frame navigation.
        if (info.url !== undefined) {
          this.engine.clearTab(tabId);
          this.previewsByTab.delete(tabId);
          this.observedRequests.delete(tabId);
          this.session.discovered.delete(tabId);
          void this.publish();
        }
      }),
    );
    this.disposers.push(
      this.gateway.tabs.onActivated(({ tabId, windowId }) => {
        this.session.current_win_tab = { tab_id: tabId, win_id: windowId };
        void this.publish();
      }),
    );
  }

  private subscribeMessages(): void {
    this.disposers.push(
      this.gateway.runtime.onMessage((envelope, sender) => {
        void this.handleMessage(envelope, sender.tab?.id);
      }),
    );
  }

  /**
   * Blob downloads from an extension page can be renamed by Chrome's filename determination
   * (the observed symptom was a video saved as .txt). Re-assert the exact composed name for our
   * own blob URLs; the mapping is populated immediately before downloads.download().
   */
  private subscribeDownloadNames(): void {
    this.disposers.push(
      this.gateway.downloads.onDeterminingFilename((item, suggest) => {
        let filename = item.url === undefined ? undefined : this.pendingDownloadNames.get(item.url);
        let key = item.url;
        if (filename === undefined && item.byExtensionId === true) {
          // Chrome versions/situations differ in whether the blob URL is present on this event.
          // For our own download, the most recent pending name is the intended one.
          const last = [...this.pendingDownloadNames.keys()].at(-1);
          if (last !== undefined) {
            key = last;
            filename = this.pendingDownloadNames.get(last);
          }
        }
        if (filename === undefined) return;
        if (key !== undefined) this.pendingDownloadNames.delete(key);
        const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1) : "";
        const proposed = item.filename.includes(".") ? item.filename.slice(item.filename.lastIndexOf(".") + 1) : "";
        console.info("[media-downloader] filename hook", proposed, "->", extension);
        suggest({ filename, conflictAction: "uniquify" });
      }),
    );
  }

  /** A stable id shared by a manifest and its sibling direct track (Twitter amplify videos). */
  private previewAssetKey(raw: string): string | undefined {
    try {
      const url = new URL(raw);
      const amplify = /\/amplify_video\/(\d+)\//u.exec(url.pathname);
      if (amplify?.[1] !== undefined) return `tw:${amplify[1]}`;
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Record direct video tracks so later manifest rows can preview them on hover. */
  private rememberPreview(tabId: number, item: MediaItem): void {
    const candidates: string[] = [];
    if (item.preview_url !== undefined) candidates.push(item.preview_url.href);
    if (item.type === "http_playlist") {
      for (const entry of item.playlist ?? []) {
        const video = entry.av?.video;
        if (video !== undefined && video !== false) candidates.push(video.href);
      }
    }
    const direct = candidates.filter((raw) => {
      try {
        const path = new URL(raw).pathname;
        if (/\.(?:m3u8|mpd)(?:$|[?#])/iu.test(path)) return false;
        // Twitter splits muxed media into /vid/ and /aud/ tracks; never use audio as a preview.
        if (/\/(?:aud|audio|mp4a)\//iu.test(path)) return false;
        return /\/(?:vid|video|media)\//iu.test(path) || /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/iu.test(path);
      } catch {
        return false;
      }
    });
    if (direct.length === 0) return;
    let state = this.previewsByTab.get(tabId);
    if (state === undefined) {
      state = { byAsset: new Map() };
      this.previewsByTab.set(tabId, state);
    }
    for (const raw of direct) {
      const asset = this.previewAssetKey(raw);
      if (asset !== undefined && !state.byAsset.has(asset)) state.byAsset.set(asset, raw);
    }
  }

  /** Preview URL for an item that did not carry one from its adapter. */
  private previewForItem(tabId: number, item: MediaItem): string | undefined {
    const state = this.previewsByTab.get(tabId);
    if (state === undefined) return undefined;
    const urls = [
      ...(item.master_url !== undefined ? [item.master_url.href] : []),
      ...(item.url !== undefined ? [item.url.href] : []),
      ...(item.playlist ?? []).flatMap((entry) => {
        const result: string[] = [];
        if (entry.av?.video !== undefined && entry.av.video !== false) result.push(entry.av.video.href);
        if (entry.av?.audio !== undefined && entry.av.audio !== false) result.push(entry.av.audio.href);
        return result;
      }),
    ];
    for (const raw of urls) {
      const asset = this.previewAssetKey(raw);
      if (asset === undefined) continue;
      const preview = state.byAsset.get(asset);
      if (preview !== undefined) return preview;
    }
    // No tab-wide fallback: an unmatched row stays poster-only rather than showing another
    // video's preview. Non-Twitter sibling mapping happens in the page adapter, where the two
    // hints came from the same page snapshot.
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** Enriched HLS rows are re-keyed by manifest body; match refreshes by manifest URL too. */
  private findByManifestUrl(tabId: number, media: MediaItem): MediaItem | undefined {
    const key = (media.master_url ?? media.url)?.href;
    if (key === undefined) return undefined;
    for (const candidate of this.engine.mediaForTab(tabId).values()) {
      if ((candidate.master_url ?? candidate.url)?.href === key) return candidate;
    }
    return undefined;
  }

  private async handleResponse(details: {
    requestId: string;
    url: string;
    tabId: number;
    frameId: number;
    type: string;
    initiator?: string;
    statusCode?: number;
    timeStamp: number;
    responseHeaders?: Array<{ name: string; value?: string }>;
  }): Promise<void> {
    await this.ready;
    const item = this.engine.onResponseStarted({
      requestId: details.requestId,
      url: details.url,
      tabId: details.tabId,
      frameId: details.frameId,
      type: details.type,
      timeStamp: details.timeStamp,
      statusCode: details.statusCode ?? 200,
      responseHeaders: (details.responseHeaders ?? []).map((header) => ({
        name: header.name,
        ...(header.value !== undefined ? { value: header.value } : {}),
      })),
      ...(details.initiator ? { initiator: details.initiator } : {}),
    });
    if (!item) return;
    this.rememberPreview(details.tabId, item);
    debugInfo("detected", item.type, mediaUrl(item), "tab", details.tabId);

    const existing =
      this.findByManifestUrl(details.tabId, item) ?? this.engine.mediaForTab(details.tabId).get(item.hash);
    if (item.type === "m3u8" && existing?.playlist !== undefined) {
      // onResponseStarted registers the fresh candidate under its URL hash before this check.
      // The enriched row is keyed by its manifest-body hash, so remove the just-registered
      // duplicate; otherwise it remains in the panel as a second, bare HLS row.
      if (existing.hash !== item.hash) this.engine.removeMedia(details.tabId, item.hash);
      // Refresh the signed URL but do not re-fetch/re-probe the already-parsed manifest.
      this.engine.refreshExternal({ ...item, hash: existing.hash }, details.tabId);
      this.refreshTab(details.tabId);
      await this.publish();
      return;
    }
    await this.enrichIfNeeded(item, details.tabId);
    this.normaliseDetectedUrls(item);

    await this.ensureTabMeta(details.tabId).catch(() => undefined);
    const tab = this.engine.mediaForTab(details.tabId);
    this.session.discovered.set(details.tabId, {
      media: new Map(tab),
      ...(this.session.discovered.get(details.tabId)?.meta
        ? { meta: this.session.discovered.get(details.tabId)?.meta as TabMeta }
        : {}),
    });
    await this.publish();
  }

  /**
   * Enrich one manifest candidate, deduplicated: concurrent responses for the same URL used to
   * fetch and attach the same playlist twice (adversarial review 2.1).
   */
  private async enrichIfNeeded(item: MediaItem, tabId: number): Promise<void> {
    if (item.type !== "m3u8" && item.type !== "mpd_playlist") return;
    const manifestUrl = item.master_url ?? item.url;
    if (manifestUrl === undefined) return;
    if (!isSafeManifestUrl(manifestUrl)) {
      debugInfo("skipping manifest enrichment for a private/unsafe host", manifestUrl.hostname);
      return;
    }
    const observed = this.observedRequests.get(tabId)?.has(observedRequestKey(manifestUrl)) ?? false;
    if (!manifestEnrichmentAllowed(manifestUrl, item.initiator, observed)) {
      debugInfo("skipping unobserved cross-origin manifest enrichment", manifestUrl.hostname);
      return;
    }
    const key = `${tabId}:${item.hash}:${item.type}`;
    if (this.enriching.has(key)) return;
    this.enriching.add(key);
    try {
      if (item.type === "m3u8") await this.manifests.enrichHls(item, tabId);
      else await this.manifests.enrichDash(item, tabId);
    } catch (error) {
      console.warn("[media-downloader] manifest enrichment failed", item.type, error);
    } finally {
      this.enriching.delete(key);
    }
  }

  /** Capture page title/thumbnail and the smart-naming rule for a tab. */
  private async ensureTabMeta(tabId: number): Promise<void> {
    const existing = this.session.discovered.get(tabId);
    if (existing?.meta) return;
    const tab = await this.gateway.tabs.get(tabId);
    if (!tab?.url) return;
    const selected = selectRule(loadSmartnaming(this.settings.smartnaming.source), tab.url);
    let selectorValue: string | null = null;
    if (selected.selector) {
      selectorValue =
        (await this.gateway.scripting
          .executeInTab(
            tabId,
            (selector: string) => document.querySelector(selector)?.textContent ?? null,
            [selected.selector],
          )
          .catch(() => null)) ?? null;
    }
    // NOTE: the injected function is serialised; it must not reference module imports.
    const metadata = await this.gateway.scripting
      .executeInTab(
        tabId,
        () => {
          const candidates: Array<{ selector: string; attribute: string }> = [
            { selector: "#vp-preview", attribute: "data-thumb" },
            { selector: "video", attribute: "poster" },
            { selector: "meta[name*=':image' i], meta[property*=':image' i]", attribute: "content" },
            { selector: "link[rel='image_src'], link[rel='thumbnail'], link[as='image']", attribute: 'href' },
          ];
          let thumbnail: string | undefined;
          for (const candidate of candidates) {
            for (const element of Array.from(document.querySelectorAll(candidate.selector))) {
              const value = element.getAttribute(candidate.attribute);
              if (typeof value === "string" && value.length > 0) {
                thumbnail = value;
                break;
              }
            }
            if (thumbnail) break;
          }
          let title: string | undefined = document.title || undefined;
          if (!title) {
            const metaTitle = document.querySelector("meta[name*=':title' i], meta[property*=':title' i]");
            const content = metaTitle?.getAttribute("content");
            if (content) title = content;
          }
          return { title, thumbnail };
        },
        [],
      )
      .catch(() => undefined);
    const smartnamingRule = materializeRule(selected, selectorValue, this.settings.download_directory);
    const meta: TabMeta = {
      incognito: tab.incognito ?? false,
      tab_id: tabId,
      default_action: this.effectiveDefaultAction(tab.url),
      smartnaming_rule: smartnamingRule,
      ...(typeof metadata?.title === "string" ? { title: metadata.title } : {}),
      ...(tab.url ? { url: new URL(tab.url) } : {}),
      ...(tab.favIconUrl ? { favicon_url: new URL(tab.favIconUrl) } : {}),
      ...(typeof metadata?.thumbnail === "string" ? { thumbnail_url: new URL(metadata.thumbnail) } : {}),
    };
    const registry = this.engine.mediaForTab(tabId);
    this.session.discovered.set(tabId, { media: new Map(registry), meta });
  }

  /**
   * Apply the site behaviour that strips query parameters from detected URLs
   * (`STRIP_GET_PARAM_WEBSITES`, evidence 02 D26). Applied before anything is stored or fetched.
   */
  private normaliseDetectedUrls(item: MediaItem): void {
    const host = item.initiator?.hostname;
    if (host === undefined) return;
    if (!isFlagEnabled(this.settings.remote_behaviours, "STRIP_GET_PARAM_WEBSITES", host)) return;
    if (item.url !== undefined) item.url.search = "";
    if (item.master_url !== undefined) item.master_url.search = "";
    for (const entry of item.playlist ?? []) {
      if (entry.av?.video) entry.av.video.search = "";
      if (entry.av?.audio) entry.av.audio.search = "";
    }
    for (const subtitle of item.subtitles ?? []) {
      if (subtitle.type === "http") subtitle.url.search = "";
    }
  }

  private effectiveDefaultAction(pageUrl: string): TabMeta["default_action"] {
    try {
      const hostname = new URL(pageUrl).hostname;
      return this.settings.default_action_per_hostname.get(hostname) ?? this.settings.default_action;
    } catch {
      return this.settings.default_action;
    }
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async handleMessage(envelope: Envelope, senderTabId?: number): Promise<void> {
    await this.ready;
    const name = envelope.msg?.name;
    const data = envelope.msg?.data;
    if (envelope.channel === Channel.FromContentToService) {
      switch (name) {
        case MSG.contentToService.DoDownload:
          await this.startDownload(data as DoDownloadPayload);
          return;
        case REBUILD_MESSAGES.MediaFocus: {
          if (senderTabId !== undefined) {
            const urls = Array.isArray((data as { urls?: unknown })?.urls)
              ? ((data as { urls: unknown[] }).urls.filter(
                  (value): value is string => typeof value === "string" && value.length <= 8192,
                ).slice(0, 20))
              : [];
            if (urls.length > 0) {
              this.focusByTab.set(senderTabId, { urls, at: this.now() });
              await this.publish();
            }
          }
          return;
        }
        case REBUILD_MESSAGES.RequestSession: {
          this.sendToContent({
            msg: { name: REBUILD_MESSAGES.SessionSnapshot, data: encode(this.panelSnapshot()) },
            channel: Channel.FromServiceToContent,
          });
          return;
        }
        case MSG.contentToService.AbortDownload:
          this.abortDownload((data as { download_id: string }).download_id);
          return;
        case MSG.contentToService.DismissMedia: {
          const payload = data as { tab_id: number; media_hash: string };
          this.engine.removeMedia(payload.tab_id, payload.media_hash);
          this.refreshTab(payload.tab_id);
          await this.publish();
          return;
        }
        case MSG.contentToService.RetryDownload: {
          const payload = data as { tab_id: number; media_hash: string };
          const media = this.engine.mediaForTab(payload.tab_id).get(payload.media_hash);
          if (media) {
            this.engine.removeMedia(payload.tab_id, payload.media_hash);
            const fresh: MediaItem = { ...media, cache: "reload", hash: `${media.hash}_retry` };
            const tab = this.session.discovered.get(payload.tab_id);
            tab?.media.set(fresh.hash, fresh);
          }
          await this.publish();
          return;
        }
        case MSG.contentToService.MutSettings:
          await this.mutateSettings(data);
          return;
        case MSG.contentToService.RmNotification: {
          const payload = data as { notification_id: string };
          this.session.notifications.delete(payload.notification_id);
          await this.publish();
          return;
        }
        case MSG.contentToService.RmNotificationsAll:
          this.session.notifications.clear();
          await this.publish();
          return;
        case MSG.contentToService.ClearHistory:
          this.session.transient_history = [];
          this.settings.downloaded.clear();
          await this.persistSettings();
          await this.publish();
          return;
        case MSG.contentToService.RequestPreview: {
          // Frame previews require the FFmpeg frame extractor, which is out of scope.
          const payload = data as { media_hash: string };
          this.sendToContent({
            msg: { name: MSG.serviceToContent.OnNoPreview, data: { media_hash: payload.media_hash } },
            channel: Channel.FromServiceToContent,
          });
          return;
        }
        case MSG.contentToService.UpdateSmartnaming:
          this.settings.smartnaming.source = (data as string | null) ?? null;
          this.settings.smartnaming.compiled = loadSmartnaming(this.settings.smartnaming.source);
          await this.persistSettings();
          return;
        default:
          return;
      }
    }
    if (envelope.channel === Channel.FromInjectedToService) {
      if (name === RELAY_MESSAGES.MediaStreamChunk) {
        const payload = data as { request_id?: string; data?: string };
        const entry = payload.request_id !== undefined ? this.relayRequests.get(payload.request_id) : undefined;
        if (entry && typeof payload.data === "string") {
          this.worker.sendRelayChunk(entry.downloadId, base64ToBytes(payload.data));
        }
        return;
      }
      if (name === RELAY_MESSAGES.MediaStreamEnd) {
        const payload = data as { request_id?: string };
        const entry = payload.request_id !== undefined ? this.relayRequests.get(payload.request_id) : undefined;
        if (entry) this.worker.endRelay(entry.downloadId);
        return;
      }
      if (name === RELAY_MESSAGES.MediaStreamError) {
        const payload = data as { request_id?: string; error?: string };
        const entry = payload.request_id !== undefined ? this.relayRequests.get(payload.request_id) : undefined;
        if (entry) {
          console.warn("[media-downloader] page relay failed", payload.error);
          this.relayRequests.delete(payload.request_id as string);
          this.worker.abortRelay(entry.downloadId);
        }
        return;
      }
      if (name === MSG.injectedToService.OnMedia) {
        // Reference adapter path: a content script reported a page-world media hint.
        const raw = (data as { media?: unknown }).media;
        const media = decodeMaybe(raw) as MediaItem | undefined;
        if (media && senderTabId !== undefined) {
          const existingHint = this.findByManifestUrl(senderTabId, media);
          const alreadyKnown = this.engine.mediaForTab(senderTabId).has(media.hash) || existingHint !== undefined;
          if (alreadyKnown) {
            // Same media identity, fresh signed URL (YouTube rotates them): keep one panel row.
            // The network sniffer may have registered the URL first without enrichment; try the
            // same observed/same-origin gate as the sniffer path before fetching the manifest.
            this.rememberPreview(senderTabId, media);
            const existing =
              existingHint ?? this.engine.mediaForTab(senderTabId).get(media.hash);
            this.engine.refreshExternal({ ...media, hash: existing?.hash ?? media.hash }, senderTabId);
            if (existing?.playlist === undefined) await this.enrichIfNeeded(media, senderTabId);
            this.normaliseDetectedUrls(media);
            this.refreshTab(senderTabId);
            await this.publish();
            return;
          }
          debugInfo("adapter hint", media.type, mediaUrl(media), "tab", senderTabId);
          this.rememberPreview(senderTabId, media);
          const inserted = this.engine.insertExternal(media, senderTabId);
          if (inserted) {
            // Adapter hints only carry a URL; enrich only observed or same-origin manifests.
            // Cross-origin quality metadata is probed in the page context instead (page-hook).
            await this.enrichIfNeeded(inserted, senderTabId);
            this.normaliseDetectedUrls(inserted);
            await this.ensureTabMeta(senderTabId);
            this.refreshTab(senderTabId);
            await this.publish();
          }
        }
        return;
      }
      if (name === MSG.injectedToService.RemoveMedia) {
        const payload = data as { hash: string };
        if (senderTabId !== undefined) this.engine.removeMedia(senderTabId, payload.hash);
        await this.publish();
      }
    }
  }

  private refreshTab(tabId: number): void {
    const media = this.engine.mediaForTab(tabId);
    const existing = this.session.discovered.get(tabId);
    this.session.discovered.set(tabId, {
      media: new Map(media),
      ...(existing?.meta ? { meta: existing.meta } : {}),
    });
  }

  /** JSON-safe projection consumed by the panel UI. */
  panelSnapshot(): PanelSnapshot {
    const tabId = this.session.current_win_tab.tab_id;
    const meta = tabId !== undefined ? this.session.discovered.get(tabId)?.meta : undefined;
    const media = tabId !== undefined ? this.engine.mediaForTab(tabId) : new Map<string, MediaItem>();
    const focusedMedia = filterFocusedMedia([...media.values()], tabId !== undefined ? this.focusByTab.get(tabId) : undefined, this.now());
    const withPreview =
      tabId === undefined
        ? focusedMedia
        : focusedMedia.map((item) => {
            if (item.preview_url !== undefined) return item;
            const preview = this.previewForItem(tabId, item);
            if (preview === undefined) return item;
            try {
              return { ...item, preview_url: new URL(preview) };
            } catch {
              return item;
            }
          });
    return buildPanelSnapshot({
      ...(tabId !== undefined ? { tabId } : {}),
      ...(meta !== undefined ? { meta } : {}),
      media: withPreview,
      downloading: this.session.downloading,
      notifications: this.session.notifications,
    });
  }

  private async mutateSettings(raw: unknown): Promise<void> {
    const mutation = decodeMaybe(raw) as Parameters<typeof applySettingsMutation>[1];
    const result = applySettingsMutation(this.settings, mutation);
    if (!result.changed) return;
    this.settings = result.state;
    pruneDownloadHistory(this.settings, this.now());
    this.queue.setTotalCapacity(this.settings.max_concurrent_downloads);
    this.queue.setYoutubeCapacity(
      this.settings.youtube_throttle ? 1 : this.settings.max_concurrent_downloads,
    );
    await this.persistSettings();
    await this.publish();
  }

  // -------------------------------------------------------------------------
  // Downloads
  // -------------------------------------------------------------------------

  private async startDownload(rawPayload: DoDownloadPayload): Promise<void> {
    // The panel addresses media by (tab, hash); the service resolves it, so the UI never has to
    // round-trip URL/Headers objects through the message bus.
    const addressed = rawPayload as unknown as {
      media?: unknown;
      tab_id?: number;
      media_hash?: string;
      preferred_entry?: number;
      output_format?: string;
      source?: string;
    };
    const preferredEntry =
      typeof addressed.preferred_entry === "number" &&
      Number.isInteger(addressed.preferred_entry) &&
      addressed.preferred_entry >= 0 &&
      addressed.preferred_entry <= 100
        ? addressed.preferred_entry
        : undefined;
    const requestedFormat = normalizeOutputFormat(addressed.output_format);
    const requestedSource = addressed.source === "hls" || addressed.source === "fmt" ? addressed.source : undefined;
    let payload = rawPayload;
    if (addressed.media === undefined && addressed.tab_id !== undefined && addressed.media_hash !== undefined) {
      const media = this.engine.mediaForTab(addressed.tab_id).get(addressed.media_hash);
      const meta = this.session.discovered.get(addressed.tab_id)?.meta;
      if (!media || !meta) return;
      payload = { download_args: undefined as never, media, meta };
    }
    const media = decodeMaybe(payload.media) as MediaItem | undefined;
    const meta = decodeMaybe(payload.meta) as TabMeta | undefined;
    if (!media || !meta) return;
    if (this.activeMediaHashes.has(media.hash)) return;
    if (media.type === "mpd_playlist") {
      this.addNotification({
        type: "download_error",
        timestamp: this.now(),
        details: "DASH downloads are not supported yet",
        media_type: media.type,
      });
      await this.publish();
      return;
    }
    if (media.has_drm) {
      this.addNotification({
        type: "download_error",
        timestamp: this.now(),
        media_type: media.type,
        has_drm: true,
      });
      await this.publish();
      return;
    }
    let plan: DownloadPlan | undefined;
    try {
      plan = payload.download_args === undefined ? undefined : (decodeMaybe(payload.download_args) as DownloadPlan);
    } catch (error) {
      console.warn("[media-downloader] malformed download plan", error);
      this.addNotification({ type: "download_error", timestamp: this.now(), details: "Malformed download plan" });
      await this.publish();
      return;
    }
    let downloadMedia = media;
    if (requestedSource === "hls" && media.hls_url !== undefined) {
      const { playlist: _playlist, extension: _extension, libav_demuxer: _libav, ...rest } = media;
      downloadMedia = {
        ...rest,
        type: "m3u8",
        master_url: media.hls_url,
        url: media.hls_url,
        demuxer: media.demuxer ?? "mp4",
      };
    }
    if (!plan) {
      const built = buildPlan({
        media: downloadMedia,
        meta,
        audioOnly: meta.default_action === "download_audio",
        preferredAudioStrategy: this.settings.preferred_audio_strategy,
        preferredAudioLanguages: this.settings.preferred_audio_languages,
        preferredAvMuxer: this.settings.preferred_av_muxer,
        downloadDirectory: this.settings.download_directory,
        carryGetParams: deriveCarryGetParams(this.settings.remote_behaviours, downloadMedia),
        subtitleLanguages: this.settings.subtitle_languages,
        youtubeThrottle: this.settings.youtube_throttle,
        downloadIdFactory: this.downloadIdFactory,
        ...(this.settings.preferred_quality !== null
          ? { preferredQuality: this.settings.preferred_quality }
          : {}),
        ...(preferredEntry !== undefined ? { preferredEntry } : {}),
      });
      if (isErr(built)) {
        this.addNotification({ type: "download_error", timestamp: this.now(), details: built.error });
        await this.publish();
        return;
      }
      plan = built.value;
    }
    if (requestedFormat !== undefined && plan !== undefined) {
      plan = applyOutputFormat(plan, requestedFormat);
    }
    const invalid = validateDownloadPlan(plan);
    if (invalid !== undefined) {
      this.addNotification({ type: "download_error", timestamp: this.now(), details: invalid });
      await this.publish();
      return;
    }
    this.activeMediaHashes.add(downloadMedia.hash);
    this.session.downloading.set(plan.download_id, {
      bitrate: 0,
      status: "queuing",
      download_args: plan,
      media: downloadMedia,
      meta,
    });
    await this.publish();
    const connectionKey =
      plan.strategy === "http_audio_video_one_source" ||
      plan.strategy === "http_audio_video_one_source_jsfetch"
        ? focusKey(plan.url.href)
        : undefined;
    const outcome = await this.queue.queueTask(
      () => this.executeDownload(plan as DownloadPlan, downloadMedia, meta),
      plan.download_id,
      plan.is_youtube,
      connectionKey,
    );
    await this.finishDownload(plan, downloadMedia, meta, outcome);
  }

  private abortDownload(downloadId: string): void {
    const entry = this.session.downloading.get(downloadId);
    if (entry) entry.status = "finalizing";
    if (!this.queue.cancelPendingTask(downloadId)) this.worker.abort(downloadId);
    void this.publish();
  }

  /** Release or restore matching page playback around a coordinated direct retry. */
  private async coordinateDirectPlayback(
    plan: DownloadPlan,
    action: "release" | "restore",
  ): Promise<number> {
    if (
      plan.strategy !== "http_audio_video_one_source" &&
      plan.strategy !== "http_audio_video_one_source_jsfetch"
    ) {
      return 0;
    }
    const operation = action === "release" ? releaseMatchingMedia : restoreMatchingMedia;
    const tabs = await this.gateway.tabs.query({}).catch(() => []);
    let affected = 0;
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined || tab.id < 0) return;
        const count = await this.gateway.scripting
          .executeInTab(tab.id, operation, [plan.url.href], { world: "MAIN" })
          .catch(() => 0);
        if (typeof count === "number" && Number.isFinite(count)) affected += count;
      }),
    );
    console.info(
      `[media-downloader] playback coordination ${action}d ${affected} matching media element(s)`,
    );
    if (action === "release" && affected > 0) {
      // Let the load() abort settle before the worker opens its competing request.
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return affected;
  }

  private async executeDownload(
    plan: DownloadPlan,
    media: MediaItem,
    meta: TabMeta,
  ): Promise<Result<TransferOutcome, string>> {
    const first = await this.executeDownloadAttempt(plan, media, meta);
    if (first.tag === "Ok" || !/\bhttp 429\b/u.test(first.error)) return first;

    // A direct 429 can mean that page playback already holds the server's sole connection.
    // Retry once only after an actual matching element has been unloaded; never add blind retries.
    const released = await this.coordinateDirectPlayback(plan, "release");
    if (released === 0) return first;
    try {
      return await this.executeDownloadAttempt(plan, media, meta);
    } finally {
      await this.coordinateDirectPlayback(plan, "restore");
    }
  }

  private async executeDownloadAttempt(
    plan: DownloadPlan,
    media: MediaItem,
    meta: TabMeta,
  ): Promise<Result<TransferOutcome, string>> {
    const entry = this.session.downloading.get(plan.download_id);
    if (entry) entry.status = "downloading";
    await this.publish();
    let outcome: TransferOutcome | undefined;
    const ruleIds = await this.headerReplay.apply(plan, {
      ...(meta.tab_id !== undefined ? { tabId: meta.tab_id } : {}),
      ...(media.initiator !== undefined ? { initiator: media.initiator.origin } : {}),
    });
    let failure: string | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (
        plan.is_youtube &&
        plan.url_audio === undefined &&
        !/^(m3u8|mpd)_/u.test(plan.strategy) &&
        isRangeBoundCdn(plan.url)
      ) {
        const ranged = await this.rangedDownloadThroughWorker(plan);
        if (isErr(ranged)) {
          failure = ranged.error;
        } else {
          outcome = ranged.value;
        }
      } else {
        const timeout = new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            console.warn("[media-downloader] transfer deadline exceeded; aborting");
            this.worker.cancel(plan.download_id);
            this.worker.abort(plan.download_id);
            reject(new Error("transfer timed out"));
          }, TRANSFER_DEADLINE_MS);
        });
        outcome = await Promise.race([
          this.worker.download(plan, (progress) => this.onProgress(plan.download_id, progress)),
          timeout,
        ]);
      }
    } catch (error) {
      failure = extractWorkerError(error);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      await this.headerReplay.remove(ruleIds);
    }

    // detect user abort
    const isUserAbort = failure === "user_abort" || outcome?.ending_reason?.user_abort === true;

    if (failure !== undefined && !isUserAbort) {
      const retryThroughPage =
        meta.tab_id !== undefined &&
        (plan.is_youtube || /http (401|403|416)/u.test(failure));
      if (retryThroughPage) {
        console.info("[media-downloader] relaying transfer through the page context", failure);
        const relayed = await this.relayDownload(plan, meta.tab_id as number);
        if (isErr(relayed)) return { tag: "Err", error: relayed.error };
        outcome = relayed.value;
      } else {
        return { tag: "Err", error: failure };
      }
    }

    // user abort is not an error
    if (isUserAbort) {
      return { tag: "Ok", value: {
        download_id: plan.download_id,
        ending_reason: userAbortReason(),
        aborted_no_partial: true,
      } as TransferOutcome };
    }

    if (outcome === undefined) return { tag: "Err", error: "transfer produced no outcome" };
    if (outcome.aborted_no_partial) return { tag: "Ok", value: outcome };
    if (!outcome.internal_bloburl) return { tag: "Err", error: "No blob provided" };
    const saved = await this.saveOutcome(plan, outcome);
    if (outcome.internal_filename !== undefined) {
      const root = await this.opfsRoot().catch(() => undefined);
      if (root) await removeStagedFile(root, outcome.internal_filename).catch(() => undefined);
    }
    this.worker.revokeBlobUrl(outcome.internal_bloburl);
    if (isErr(saved)) return { tag: "Err", error: saved.error };
    return { tag: "Ok", value: { ...outcome, path: saved.value.path } };
  }

  /**
   * Ask the content script to fetch the media in the page context and stream it to the worker.
   * Used when the CDN rejects extension-initiated requests (live YouTube 403).
   */
  private async relayDownload(plan: DownloadPlan, tabId: number): Promise<Result<TransferOutcome, string>> {
    const requestId = crypto.randomUUID();
    this.relayRequests.set(requestId, { downloadId: plan.download_id, seq: 0 });
    const completion = this.worker.streamDownload(plan);
    completion.catch(() => undefined);
    const timer = setTimeout(() => {
      console.warn("[media-downloader] page relay timed out");
      this.relayRequests.delete(requestId);
      this.worker.cancel(plan.download_id);
      this.worker.abortRelay(plan.download_id);
    }, 30 * 60 * 1000);
    try {
      await this.gateway.runtime.sendToTab(tabId, {
        msg: {
          name: RELAY_MESSAGES.MediaStreamRequest,
          data: { request_id: requestId, url: plan.url.href },
        },
        channel: Channel.FromServiceToInjected,
      });
      const outcome = await completion;
      return { tag: "Ok", value: outcome };
    } catch (error) {
      this.worker.cancel(plan.download_id);
      this.worker.abortRelay(plan.download_id);
      return { tag: "Err", error: extractWorkerError(error) };
    } finally {
      clearTimeout(timer);
      this.relayRequests.delete(requestId);
    }
  }

  /**
   * Download a signed googlevideo URL with bounded range requests **from the service worker** and
   * stream the bytes into the download worker for staging.
   *
   * Live E2E: the same URL returns 206 from the service worker / extension pages / page context,
   * but 403 when fetched by the offscreen worker for the real plan. The CDN accepts the
   * service-worker request, and the worker is only needed for OPFS staging, so fetch here and
   * reuse the existing relay protocol.
   */
  private async rangedDownloadThroughWorker(
    plan: DownloadPlan,
  ): Promise<Result<TransferOutcome, string>> {
    const completion = this.worker.streamDownload(plan);
    completion.catch(() => undefined);
    const chunkSize = 2 * 1024 * 1024;
    const total = declaredSize(plan.url);
    let offset = 0;
    let finished = false;
    try {
      for (let attempt = 0; attempt < 20000; attempt += 1) {
        if (total !== undefined && offset >= total) break;
        const end = offset + chunkSize - 1;
        const fetched = await fetchBytes(
          this.fetchImpl,
          plan.url.href,
          { headers: headersForPlan(plan.headers), range: `bytes=${offset}-${end}` },
          {},
        );
        if (fetched.tag === "Err") {
          const status = fetched.error.status !== undefined ? ` ${fetched.error.status}` : "";
          return {
            tag: "Err",
            error: `${fetched.error.kind}${status}: ${fetched.error.message ?? "download failed"} range=${offset}-${end} headers=[${[...headersForPlan(plan.headers).keys()].join(",")}] (${plan.url.href})`,
          };
        }
        const bytes = fetched.value.bytes;
        if (bytes.byteLength === 0) break;
        this.worker.sendRelayChunk(plan.download_id, bytes);
        offset += bytes.byteLength;
        if (total !== undefined) {
          this.onProgress(plan.download_id, {
            status: "downloading",
            fetched_bytes_count: offset,
            percent: { is_known: true, value: Math.min(0.99, offset / total) },
          });
        }
        if (bytes.byteLength < chunkSize) break;
      }
      this.worker.endRelay(plan.download_id);
      finished = true;
      const outcome = await completion;
      return { tag: "Ok", value: outcome };
    } catch (error) {
      return { tag: "Err", error: extractWorkerError(error) };
    } finally {
      if (!finished) {
        this.worker.cancel(plan.download_id);
        this.worker.abortRelay(plan.download_id);
      }
    }
  }

  /** Remember a URL the browser actually requested in a tab (bounded, per-tab). */
  private rememberObservedRequest(tabId: number, rawUrl: string): void {
    if (tabId < 0 || rawUrl.length > MAX_CAPTURED_URL_LENGTH) return;
    try {
      const key = observedRequestKey(new URL(rawUrl));
      let seen = this.observedRequests.get(tabId);
      if (seen === undefined) {
        seen = new Set();
        this.observedRequests.set(tabId, seen);
      }
      if (seen.size >= 1000) return;
      seen.add(key);
    } catch {
      /* malformed URL; ignore */
    }
  }

  private async saveOutcome(
    plan: DownloadPlan,
    outcome: TransferOutcome,
  ): Promise<Result<{ path: string }, string>> {
    // The worker may have produced a different container than planned (e.g. raw MPEG-TS when no
    // remuxer is available). Save under the extension actually produced.
    const filenamePlan: DownloadPlan =
      outcome.output_extension !== undefined ? { ...plan, extension: outcome.output_extension } : plan;
    const request = buildDownloadRequest({ blobUrl: outcome.internal_bloburl as string, plan: filenamePlan });
    this.pendingDownloadNames.set(request.url, request.filename);
    console.info("[media-downloader] requested download extension", request.filename.slice(request.filename.lastIndexOf(".") + 1));
    if (this.pendingDownloadNames.size > 100) {
      const oldest = this.pendingDownloadNames.keys().next().value;
      if (oldest !== undefined) this.pendingDownloadNames.delete(oldest);
    }
    let downloadId: number;
    try {
      downloadId = await this.gateway.downloads.download(request);
    } catch (error) {
      return { tag: "Err", error: String(error) };
    }
    const terminal = await this.waitForDownload(downloadId);
    const mapped = mapDownloadTerminalState(terminal);
    if (isErr(mapped)) return { tag: "Err", error: mapped.error.message ?? "download failed" };
    return { tag: "Ok", value: mapped.value };
  }

  private waitForDownload(downloadId: number): Promise<DownloadTerminalState> {
    return new Promise<DownloadTerminalState>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (state: DownloadTerminalState): void => {
        if (settled) return;
        settled = true;
        detach();
        if (timer !== undefined) clearTimeout(timer);
        resolve(state);
      };
      const detach = this.gateway.downloads.onChanged((delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
          void this.gateway.downloads.search({ id: downloadId }).then((items) => {
            const item = items[0];
            finish(toTerminalState(item, delta.error?.current));
          });
        }
      });
      timer = setTimeout(async () => {
        const items = await this.gateway.downloads.search({ id: downloadId }).catch(() => [] as DownloadItem[]);
        finish(toTerminalState(items[0]));
      }, 30 * 60 * 1000);
      void this.gateway.downloads.search({ id: downloadId }).then((items) => {
        const item = items[0];
        if (item && item.state !== "in_progress") finish(toTerminalState(item));
      });
    });
  }

  private onProgress(downloadId: string, progress: DownloadProgress): void {
    const entry = this.session.downloading.get(downloadId);
    if (!entry) return;
    applyDownloadProgress(entry, progress, this.now());
    void this.publish();
  }

  private async finishDownload(
    plan: DownloadPlan,
    media: MediaItem,
    meta: TabMeta,
    outcome: Result<TransferOutcome, string>,
  ): Promise<void> {
    this.session.downloading.delete(plan.download_id);
    this.activeMediaHashes.delete(media.hash);
    if (isErr(outcome)) {
      console.warn("[media-downloader] download failed", outcome.error, composeFilename(plan));
      this.addNotification({
        type: "download_error",
        timestamp: this.now(),
        details: outcome.error,
        media_type: media.type,
      });
      await this.publish();
      return;
    }
    if (outcome.value.aborted_no_partial) {
      await this.publish();
      return;
    }
    if (this.settings.show_desktop_notifications && !meta.incognito) {
      await this.gateway.notifications
        .create(plan.download_id, {
          type: "basic",
          title: "Download complete",
          message: outcome.value.path ?? composeFilename(plan),
          iconUrl: this.gateway.runtime.getUrl("/bitmaps/icon-128.png"),
        })
        .catch(() => undefined);
    }
    const record: DownloadedRecord = {
      downloaded_id: `ded_${crypto.randomUUID()}`,
      path: outcome.value.path ?? "",
      browser_download_id: outcome.value.browser_download_id ?? -1,
      media_hash: media.hash,
      download_timestamp: this.now(),
      origin_url: meta.url?.href ?? null,
      origin_favicon_url: meta.favicon_url?.href ?? null,
      has_drm: media.has_drm ?? false,
      ...(plan.save_as ? {} : { subdir: plan.subdir }),
    };
    this.session.transient_history.push(record);
    if (this.session.transient_history.length > 99) {
      this.session.transient_history.splice(0, this.session.transient_history.length - 99);
    }
    if (this.settings.history_days > 0) {
      this.settings.downloaded.set(record.downloaded_id, record as never);
    }
    pruneDownloadHistory(this.settings, this.now());
    this.settings.successful_downloads_count += 1;
    this.settings.lsd = this.now();
    await this.persistSettings();
    await this.publish();
  }

  private addNotification(record: NotificationRecord): void {
    for (const existing of this.session.notifications.values()) {
      if (
        existing.type === record.type &&
        existing.details === record.details &&
        existing.message === record.message
      ) {
        return;
      }
    }
    const id = `notification_${crypto.randomUUID()}`;
    this.session.notifications.set(id, record);
  }

  private sendToContent(envelope: Envelope): void {
    void this.gateway.runtime.sendToService(envelope).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Context menus
  // -------------------------------------------------------------------------

  private async syncContextMenus(): Promise<void> {
    await this.gateway.contextMenus.removeAll().catch(() => undefined);
    const tabId = this.session.current_win_tab.tab_id;
    if (tabId === undefined) return;
    const items = composeContextMenuItems({
      media: this.engine.mediaForTab(tabId),
      meta: this.session.discovered.get(tabId)?.meta,
    });
    for (const item of items) this.gateway.contextMenus.create(item as unknown as Record<string, unknown>);
    this.gateway.contextMenus.onClicked((info, tab) => {
      const menuItemId = String(info.menuItemId);
      if (!menuItemId.startsWith("media:") || !tab) return;
      const hash = menuItemId.slice("media:".length);
      const media = tab.id !== undefined ? this.engine.mediaForTab(tab.id).get(hash) : undefined;
      const meta = tab.id !== undefined ? this.session.discovered.get(tab.id)?.meta : undefined;
      if (media && meta) {
        void this.startDownload({
          download_args: undefined as never,
          media: media as never,
          meta: meta as never,
        });
      }
    });
  }
}

function toTerminalState(item: DownloadItem | undefined, interruptReason?: string): DownloadTerminalState {
  if (!item) return { state: "interrupted" };
  return {
    state: item.state,
    ...(item.filename !== undefined ? { filename: item.filename } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
    ...(interruptReason !== undefined ? { interruptReason } : {}),
  };
}

const MAX_CAPTURED_URL_LENGTH = 8192;
/** Overall transfer deadline (direct + relay staging). */
const TRANSFER_DEADLINE_MS = 30 * 60 * 1000;

/** Output containers this rebuild can actually produce. */
const ALLOWED_OUTPUT_EXTENSIONS = new Set(["mp4", "mkv", "webm", "mp3", "m4a", "ogg", "ts", "m2ts"]);

/** Credential-bearing request headers must never be written to storage (review round 2). */
const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|x-auth)/iu;

function redactHeaders(headers: Headers): Headers {
  const redacted = new Headers();
  for (const [name, value] of headers) {
    if (!SENSITIVE_HEADER.test(name)) redacted.set(name, value);
  }
  return redacted;
}

/** Session copy safe to persist (no cookies/authorization in plans or media items). */
export function redactSessionForStorage(session: SessionState): SessionState {
  const downloading = new Map<string, DownloadingEntry>();
  for (const [id, entry] of session.downloading) {
    downloading.set(id, {
      ...entry,
      download_args: { ...entry.download_args, headers: redactHeaders(entry.download_args.headers) },
      media: { ...entry.media, sent_headers: redactHeaders(entry.media.sent_headers) },
    });
  }
  const discovered = new Map<number, TabDiscovered>();
  for (const [tabId, tab] of session.discovered) {
    const media = new Map<string, MediaItem>();
    for (const [hash, item] of tab.media) {
      media.set(hash, { ...item, sent_headers: redactHeaders(item.sent_headers) });
    }
    discovered.set(tabId, { ...tab, media });
  }
  return { ...session, downloading, discovered };
}

/** Validate a plan before it can reach the download queue (review 3.3). */
export function validateDownloadPlan(plan: DownloadPlan): string | undefined {
  if (plan === null || typeof plan !== "object") return "Malformed download plan";
  if (!(plan.url instanceof URL)) return "Malformed media URL";
  if (plan.url.protocol !== "http:" && plan.url.protocol !== "https:") return "Unsupported media URL scheme";
  if (plan.url_audio !== undefined && plan.url_audio.protocol !== "http:" && plan.url_audio.protocol !== "https:") {
    return "Unsupported audio URL scheme";
  }
  if (!ALLOWED_OUTPUT_EXTENSIONS.has(plan.extension)) return "Unsupported output extension";
  const subdir = plan.subdir;
  if (subdir.includes("..") || subdir.startsWith("/") || subdir.includes("\\")) return "Unsafe download directory";
  if (/[\r\n\0]/u.test(subdir)) return "Unsafe download directory";
  const basename = typeof plan.good_basename === "string" ? plan.good_basename : "";
  if (basename.length === 0 || basename.length > 190) return "Unsafe filename";
  // Internal dots are valid in a filename (titles commonly end with an ellipsis). Path
  // traversal needs a separator; the subdir check above handles traversal components.
  if (basename.includes("/") || basename.includes("\\")) {
    return "Unsafe filename";
  }
  if (/[\r\n\0]/u.test(basename)) return "Unsafe filename";
  // Chrome validates the composed relative path with its portable filename rules before the
  // download starts (and refuses it with "Invalid filename"). Checking here fails the download
  // before the transfer instead of after it; names are normally repaired upstream, so this
  // guards plans built by anything that bypasses the naming layer.
  const composed = composeFilename(plan);
  const composedSegments = composed.split("/");
  const composedBasename = composedSegments.pop() ?? "";
  if (!isSafePathComponent(composedBasename)) return "Unsafe filename";
  if (composedSegments.some((segment) => segment.length > 0 && !isSafePathComponent(segment))) {
    return "Unsafe download directory";
  }
  return undefined;
}

/** Best-effort URL for logs: direct items keep it in playlist[0].av.video, manifests in url/master_url. */
function mediaUrl(item: MediaItem): string {
  const video = item.playlist?.[0]?.av?.video;
  return (
    item.url?.href ??
    item.master_url?.href ??
    (video ? video.href : "")
  );
}

/**
 * Whether the captured query string must be carried onto every segment request
 * (`CARRY_GET_PARAM_WEBSITES`, evidence 02 D26 / 03 F7). Derived from the manifest host when
 * known, else the page host.
 */
export function deriveCarryGetParams(
  behaviours: Behaviours,
  media: Pick<MediaItem, "master_url" | "initiator">,
): boolean {
  const host = media.master_url?.hostname ?? media.initiator?.hostname;
  if (host === undefined) return false;
  return isFlagEnabled(behaviours, "CARRY_GET_PARAM_WEBSITES", host);
}

/** Worker errors arrive either as strings or as {download_id, error} objects. */
function extractWorkerError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const candidate = (error as { error?: unknown }).error;
    if (typeof candidate === "string") return candidate;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** Decode a relay chunk (base64 from the content script). */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Payloads from extension pages arrive serde-tagged; accept plain values too (tests, future UI). */
function decodeMaybe(value: unknown): unknown {
  if (value && typeof value === "object" && "__serde_tag" in (value as Record<string, unknown>)) {
    return decode(value);
  }
  return value;
}

/** Entry point used by `boot.ts`. */
export function createMediaDownloaderService(options: ServiceWorkerOptions): MediaDownloaderService {
  return new MediaDownloaderService(options);
}

export {
  userAbortReason,
  httpFailureReason,
  otherFailureReason,
  buildDownloadRequest,
  composeFilename,
  normalizeHeaderReplayUrl,
};
export type { ContextMenuItem, TabInfo };
