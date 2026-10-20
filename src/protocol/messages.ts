/**
 * Message catalog for every cross-context hop.
 *
 * Evidence: analysis/evidence/01-messaging-runtime.md Â§2.2-Â§2.8, Â§3.1-Â§3.7 (E8-E18, E24-E35);
 * `MSG` name literals were extracted from all bundles with `analysis/scratch/names.mjs`
 * (evidence doc Â§6.3). Channel numbers are the frozen `Channel` enum from
 * `src/protocol/channels.ts` (E8: nine values, `FromServiceToService:8` unused/reserved).
 *
 * Wire shape (E13, proven on every hop):
 *   { msg: { name: string, data: unknown }, channel: ChannelValue }
 * `data` values that carry URLs/Headers/Maps/Sets/Options are serde-encoded by
 * `src/protocol/serde.ts` before crossing the boundary (E13, `ae`/`ze`); the TypeScript types
 * below are the *runtime* shapes, i.e. what the decoder yields.
 */

import type {
  DefaultAction,
  DownloadPlan,
  DownloadProgress,
  MediaItem,
  TabMeta,
  TransferOutcome,
} from "../core/types.js";
import { Channel, type ChannelValue } from "./channels.js";

/** Dock placement modes. Persistent state stores `popup|sidebar` (E22 zod enum); `window` is a
 * legacy branch still present in the dock bootstrap switch (E32), so it is accepted here. */
export type DockMode = "popup" | "sidebar" | "window";

/** UI theme, audio strategy, preview, popup/font size and media ordering values (E22). */
export type AudioStrategy = "original" | "user_language";
export type PreviewMode = "none" | "image" | "video";
export type UiTheme = "system" | "light" | "dark";
export type PopupSize = "big" | "medium" | "small";
export type FontSize = "verylarge" | "large" | "default";
export type DiscoveredOrder = "SMART" | "OLDEST" | "NEWEST";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** The `{name, data}` body carried by `msg` on every channel. */
export interface MessageBody<Name extends string = string, Data = unknown> {
  name: Name;
  data: Data;
}

/**
 * One wire message. The outer object has exactly two keys (`msg`, `channel`) and `msg` exactly
 * two (`name`, `data`) â€” asserted by test/messages.test.ts so a serializer never invents extra
 * fields the original consumers would ignore or mis-handle.
 */
export interface MessageEnvelope<Name extends string = string, Data = unknown> {
  msg: MessageBody<Name, Data>;
  channel: ChannelValue;
}

/** Build the wire envelope. The only sanctioned constructor of the protocol shape. */
export function makeEnvelope<Name extends string, Data>(
  name: Name,
  data: Data,
  channel: ChannelValue,
): MessageEnvelope<Name, Data> {
  return { msg: { name, data }, channel };
}

// ---------------------------------------------------------------------------
// Payloads: content/UI -> service (channel 1, E16/Â§3.1)
// ---------------------------------------------------------------------------

/** `do_download` (panel/media item/context-menu click). Serde-encoded at the wire level. */
export interface DoDownloadPayload {
  download_args: DownloadPlan;
  meta: TabMeta;
  media: MediaItem;
}

export interface AbortDownloadPayload {
  download_id: string;
}

export interface RequestPreviewPayload {
  tab_id: number;
  media_hash: string;
}

export interface RmNotificationPayload {
  notification_id: string;
}

export interface SetDefaultActionPayload {
  hostname: string;
  action: DefaultAction;
}

export interface DismissMediaPayload {
  tab_id: number;
  media_hash: string;
}

export interface RmDownloadPayload {
  browser_download_id: number;
}

export interface RetryDownloadPayload {
  tab_id: number;
  media_hash: string;
}

export interface UpdateMediaPreferredEntryPayload {
  media_hash: string;
  playlist_index: number;
}

export interface CustomStringPayload {
  key: string;
  value: string;
}

export interface RedockPayload {
  mode: DockMode;
}

/** `update-smartnaming` carries the raw rules file source, or `null` to reset (E22/Â§3.1). */
export type UpdateSmartnamingPayload = string | null;

/**
 * Download-related commands sent from content/UI to the service on channel 1 (E Â§3.1): start
 * (`do_download`), cancel (`abort_download`), retry (`retry_download`) and delete
 * (`rm_download`). Each message carries at most one of these payloads.
 */
export type DownloadCommand =
  | DoDownloadPayload
  | AbortDownloadPayload
  | RetryDownloadPayload
  | RmDownloadPayload;

/** `mut-settings` data (channel 1). Exactly one key per message; 19 keys proven (E22, Â§3.7).
 * The brief said 18 â€” the shipped handler has 19 branches (pretty 23076-23142). */
export type MutSettingsPayload =
  | { preferred_audio_strategy: AudioStrategy }
  | { preferred_audio_languages: string[] }
  | { hide_nomedia_box: boolean }
  | { max_concurrent_downloads: number }
  | { show_desktop_notifications: boolean }
  | { preferred_quality: number | null }
  | { always_download_as_mkv: boolean }
  | { preview_mode: PreviewMode }
  | { show_desktop_notifications_private: boolean }
  | { show_transient_history: boolean }
  | { history_days: number }
  | { ui_theme: UiTheme }
  | { popup_size: PopupSize }
  | { font_size: FontSize }
  | { youtube_throttle: boolean }
  | { use_context_menu: boolean }
  | { download_directory: string }
  | { preferred_discovered_order: DiscoveredOrder }
  | { subtitles_language: string[] };

/** Union of every `data` shape sent on channel 1 (null for command-only messages). */
export type ContentToServicePayload =
  | DoDownloadPayload
  | AbortDownloadPayload
  | RequestPreviewPayload
  | RmNotificationPayload
  | SetDefaultActionPayload
  | DismissMediaPayload
  | RmDownloadPayload
  | RetryDownloadPayload
  | UpdateMediaPreferredEntryPayload
  | CustomStringPayload
  | RedockPayload
  | UpdateSmartnamingPayload
  | MutSettingsPayload
  | null;

// ---------------------------------------------------------------------------
// Payloads: injected ISOLATED -> service (channel 0, E16/Â§3.2)
// ---------------------------------------------------------------------------

/** `on_media` from a site extractor. `tab_id` is optional: the service prefers
 * `sender.tab.id` and falls back to the media initiator URL (E2/Â§1.2, E Â§3.2). */
export interface OnMediaPayload {
  media: MediaItem;
  tab_id?: number;
}

export interface RemoveMediaPayload {
  hash: string;
}

export interface OnActivateAddonPayload {
  key: string;
}

/** QuickJS evaluation request (`qjs`): site extractors ship code strings (E Â§3.2). */
export interface QjsPayload {
  code: string;
  uid: string | number;
}

/** Service-side fetch relay (`do_fetch_from_service`, E Â§3.2): the service performs the
 * request with its own permissions and replies with `on_fetch_from_service`. */
export interface DoFetchFromServicePayload {
  url: string;
  method: string;
  fetch_headers: Array<[string, string]> | Record<string, string>;
  body_params: Array<[string, string]> | Record<string, string>;
  uid: string | number;
}

// ---------------------------------------------------------------------------
// Payloads: service -> injected (channel 7, E17/Â§3.3)
// ---------------------------------------------------------------------------

export interface OnActivateAddonFailurePayload {
  error: unknown;
}

export interface QjsResultPayload {
  /** JSON string: `{success, uid}` or `{error, uid}` (E Â§3.3). */
  json: string;
}

export interface OnFetchFromServicePayload {
  json: unknown;
  uid: string | number;
}

export interface OnFetchFromServiceFailedPayload {
  uid: string | number;
}

// ---------------------------------------------------------------------------
// Payloads: service -> content/UI (channel 6, E17/Â§3.4) â€” the only data pushes
// ---------------------------------------------------------------------------

export interface OnPreviewAvailablePayload {
  tab_id: number;
  media_hash: string;
  /** OPFS entry name written by the worker (E33). */
  filename: string;
}

export interface OnNoPreviewPayload {
  media_hash: string;
}

// ---------------------------------------------------------------------------
// Payloads: worker bus (E34/Â§3.5)
// ---------------------------------------------------------------------------

/** service -> worker `download` (channel FromServiceToWorker). */
export interface WorkerDownloadPayload {
  download_args: DownloadPlan;
}

export interface WorkerAbortDownloadPayload {
  download_id: string;
}

export interface RevokeBlobUrlPayload {
  blob_url: string;
}

/** worker -> service `download_progress` (channel FromWorkerToService). */
export interface DownloadProgressPayload {
  download_id: string;
  progress: DownloadProgress;
}

/** worker -> service `download_result`; correlates by `download_id` (E34). */
export type DownloadResultPayload = TransferOutcome;

/** worker -> service `download_error`. The service passes `error` through opaquely (E34). */
export interface DownloadErrorPayload {
  download_id: string;
  error: unknown;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Every message name the shipped build produces or consumes, grouped by the direction it
 * travels. Values are the exact wire literals (some are kebab-case commands, some snake_case
 * worker names â€” the original is inconsistent and consumers compare exact strings).
 */
export const MSG = {
  /** channel 1 â€” `chrome.runtime.sendMessage`, consumer `Er` in the service worker. */
  contentToService: {
    DoDownload: "do_download",
    AbortDownload: "abort_download",
    RequestPreview: "request_preview",
    RmNotification: "rm_notification",
    RmNotificationsAll: "rm_notifications_all",
    TosAccepted: "tos_accepted",
    SetDefaultAction: "set_default_action",
    DismissBanner: "dismiss_banner",
    DismissMedia: "dismiss_media",
    RmDownload: "rm_download",
    RetryDownload: "retry_download",
    UpdateMediaPreferredEntry: "update_media_preferred_entry",
    ClearHistory: "clear-history",
    ClearCompleted: "clear-completed",
    MutSettings: "mut-settings",
    ShowReviewPage: "show-review-page",
    RmCustomStrings: "rm-custom-strings",
    UpdateCustomWebString: "update-custom-web-string",
    UpdateCustomAddonString: "update-custom-addon-string",
    ResetSuspiciousSaveas: "reset-suspicious-saveas",
    UpdateSmartnaming: "update-smartnaming",
    Redock: "redock",
  },
  /** channel 0 â€” `chrome.runtime.sendMessage` from content scripts, consumer `gp`. */
  injectedToService: {
    OnMedia: "on_media",
    RemoveMedia: "remove_media",
    OnActivateAddon: "on_activate_addon",
    Qjs: "qjs",
    DoFetchFromService: "do_fetch_from_service",
  },
  /** channel 6 â€” `chrome.runtime.sendMessage` broadcast from the service, consumer `dc`. */
  serviceToContent: {
    OnPreviewAvailable: "on_preview_available",
    OnNoPreview: "on_no_preview",
    Ping: "ping",
  },
  /** channel 7 â€” `chrome.tabs.sendMessage` from the service (`Et` one-shot / `fp` retry). */
  serviceToInjected: {
    OnActivateAddonSuccess: "on_activate_addon_success",
    OnActivateAddonFailure: "on_activate_addon_failure",
    QjsResult: "qjs_result",
    OnFetchFromService: "on_fetch_from_service",
    OnFetchFromServiceFailed: "on_fetch_from_service_failed",
    /** Config relays fetched by the service and forwarded (`zf`, E Â§3.3). */
    VimeoOnConfig: "vimeo_on_config",
    IqyiOnConfig: "iqyi_on_config",
  },
  /** `BroadcastChannel("worker_service")` â€” channels 2 / 3 (E9/E34; only SW and worker use it). */
  worker: {
    IsReady: "is_ready",
    IsReadySuccess: "is_ready_success",
    Download: "download",
    DownloadProgress: "download_progress",
    DownloadResult: "download_result",
    DownloadError: "download_error",
    AbortDownload: "abort_download",
    RevokeBlobUrl: "revoke_blob_url",
  },
  /** channels 5 / 4 â€” per-page `BroadcastChannel("injected-<cyrb53(href)>")` (E12/Â§3.6). */
  pageBridge: {
    YouTubeRequestVisitorData: "youtube_request_visitor_data",
    YouTubeOnVisitorData: "youtube_on_visitor_data",
    VimeoRequestConfig: "vimeo_request_config",
    VimeoOnConfig: "vimeo_on_config",
    IqRequestConfig: "iq_request_config",
    IqOnConfig: "iq_on_config",
    IqyiOnConfig: "iqyi_on_config",
    BilibiliComRequestId: "bilibili_com_request_id",
    BilibiliComOnId: "bilibili_com_on_id",
    BilibiliTvRequestConfig: "bilibili_tv_request_config",
    BilibiliTvOnConfig: "bilibili_tv_on_config",
    JavrankRequestManifest: "javrank_request_manifest",
    JavrankOnManifest: "javrank_on_manifest",
  },
} as const;

export type ContentToServiceName = (typeof MSG.contentToService)[keyof typeof MSG.contentToService];
export type InjectedToServiceName = (typeof MSG.injectedToService)[keyof typeof MSG.injectedToService];
export type ServiceToContentName = (typeof MSG.serviceToContent)[keyof typeof MSG.serviceToContent];
export type ServiceToInjectedName = (typeof MSG.serviceToInjected)[keyof typeof MSG.serviceToInjected];
export type WorkerMessageName = (typeof MSG.worker)[keyof typeof MSG.worker];
export type PageBridgeName = (typeof MSG.pageBridge)[keyof typeof MSG.pageBridge];

/**
 * The 19 `mut-settings` keys accepted by the service worker (E22/Â§3.7). Order matches the
 * shipped `else if` chain so parity tests can compare against the evidence table directly.
 */
export const SETTINGS_MUTATION_KEYS = [
  "preferred_audio_strategy",
  "preferred_audio_languages",
  "hide_nomedia_box",
  "max_concurrent_downloads",
  "show_desktop_notifications",
  "preferred_quality",
  "always_download_as_mkv",
  "preview_mode",
  "show_desktop_notifications_private",
  "show_transient_history",
  "history_days",
  "ui_theme",
  "popup_size",
  "font_size",
  "youtube_throttle",
  "use_context_menu",
  "download_directory",
  "preferred_discovered_order",
  "subtitles_language",
] as const;

export type SettingsMutationKey = (typeof SETTINGS_MUTATION_KEYS)[number];

// ---------------------------------------------------------------------------
// Direction guards
// ---------------------------------------------------------------------------

/** True for channel 1 (content/UI page -> service). */
export function isContentToService(envelope: MessageEnvelope): boolean {
  return envelope.channel === Channel.FromContentToService;
}

/** True for channel 0 (injected ISOLATED extractor -> service). */
export function isInjectedToService(envelope: MessageEnvelope): boolean {
  return envelope.channel === Channel.FromInjectedToService;
}

/** True for channel 6 (service -> content/UI page broadcast). */
export function isServiceToContent(envelope: MessageEnvelope): boolean {
  return envelope.channel === Channel.FromServiceToContent;
}

/** True for channel 7 (service -> injected script in a tab). */
export function isServiceToInjected(envelope: MessageEnvelope): boolean {
  return envelope.channel === Channel.FromServiceToInjected;
}

/** True for the per-page isolated<->main bridge (channels 4/5). */
export function isPageBridge(envelope: MessageEnvelope): boolean {
  return (
    envelope.channel === Channel.FromUntrustedInjectedToTrusted ||
    envelope.channel === Channel.FromTrustedInjectedToUntrusted
  );
}

/** True when the envelope travels on the service<->worker BroadcastChannel. */
export function isWorkerBus(envelope: MessageEnvelope, direction: "toWorker" | "toService"): boolean {
  const expected =
    direction === "toWorker" ? Channel.FromServiceToWorker : Channel.FromWorkerToService;
  return envelope.channel === expected;
}

/** Convenience builders for the common hops (typed names, but `data` stays unknown-checked). */
export function makeContentToServiceEnvelope(
  name: ContentToServiceName,
  data: unknown,
): MessageEnvelope<ContentToServiceName> {
  return makeEnvelope(name, data, Channel.FromContentToService);
}

export function makeServiceToContentEnvelope(
  name: ServiceToContentName,
  data: unknown,
): MessageEnvelope<ServiceToContentName> {
  return makeEnvelope(name, data, Channel.FromServiceToContent);
}

export function makeWorkerEnvelope(
  name: WorkerMessageName,
  data: unknown,
  direction: "toWorker" | "toService",
): MessageEnvelope<WorkerMessageName> {
  return makeEnvelope(
    name,
    data,
    direction === "toWorker" ? Channel.FromServiceToWorker : Channel.FromWorkerToService,
  );
}


