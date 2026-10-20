/**
 * Persistent local settings — the `global_persistent_state` half of the storage contract.
 *
 * Evidence: analysis/evidence/01-messaging-runtime.md E22/§2.6, E24, E30; original service worker
 * zod schema `b_` (pretty 20826-21035; bytes ~493k-501k), defaults `S_()` (pretty 21060-21105),
 * storage key `global_persistent_state` under `chrome.storage.local` (pretty 21106-21116) and the
 * whole-state writer `D_`/`Ib` + serde `ae` (pretty 21113-21116, 21203-21206).
 *
 * The state is written as ONE value, serde-encoded, and read back by every context (UI pages and
 * content scripts) directly from `chrome.storage.local` — no IPC for settings (E23).
 */

import type { DefaultAction } from "../core/types.js";
import { defaultSmartnaming, type CompiledSmartnaming } from "../naming/rules.js";
import {
  SETTINGS_MUTATION_KEYS,
  type AudioStrategy,
  type DiscoveredOrder,
  type DockMode,
  type FontSize,
  type MutSettingsPayload,
  type PopupSize,
  type PreviewMode,
  type SetDefaultActionPayload,
  type SettingsMutationKey,
  type UiTheme,
} from "../protocol/messages.js";
import { decode, encode } from "../protocol/serde.js";
import {
  DEFAULT_RULESET,
  defaultBehaviours,
  RULESET_REVISION,
  type GytScannerConfig,
  type RemoteNotificationLevel,
} from "./flags.js";

// ---------------------------------------------------------------------------
// Shape of the persistent state (`b_` zod schema without the licensing fields)
// ---------------------------------------------------------------------------

/** A finished download shown in the transient history / persistent history (E22 `M0`). */
export interface DownloadedRecord {
  downloaded_id: string;
  media_hash: string;
  path: string;
  browser_download_id: number;
  download_timestamp: number;
  origin_url: URL | null;
  origin_favicon_url: URL | null;
  has_drm: boolean;
  subdir?: string;
}

/** A notification pushed by the remote ruleset (`remote_notifications` map value, E22 `gb`). */
export interface RemoteNotification {
  type: "remote";
  title: string;
  details: string;
  url?: URL;
  level: RemoteNotificationLevel;
}

/** Remote behaviours as stored in the persistent state (flattened from the ruleset, E22). */
export interface RemoteBehaviours {
  advertize_premium: boolean;
  gyt_scanner: GytScannerConfig;
  websites: Map<string, Set<string>>;
}

/** User-editable smart-naming strings (shortcuts for custom text replacements, E22). */
export interface CustomStrings {
  addon: Map<string, string>;
  web: Map<string, string>;
}

/** Compiled smart-naming rules as persisted (raw source + compiled form, E22). */
export interface SmartnamingSetting {
  source: string | null;
  compiled: CompiledSmartnaming;
}

/**
 * Local persistent settings/state.
 *
 * Deliberately excluded (marked premium/licensing in the evidence): `jwt` (entitlement token,
 * endpoint `/v2/entitlements/*`), all activation/subscription state, and `lsd`'s licensing use.
 * `lsd` itself is kept because the download flow writes it as a timestamp (E22/§3.1).
 */
export interface PersistentSettings {
  version: number;
  default_action: DefaultAction;
  default_action_per_hostname: Map<string, DefaultAction>;
  downloaded: Map<string, DownloadedRecord>;
  /** Last-successful-download timestamp used by gating logic (default `1710169438e3`). */
  lsd: number;
  hide_nomedia_box: boolean;
  dont_ask_for_user_review: boolean;
  agreed_with_tos: boolean;
  dockmode: DockMode;
  download_directory: string;
  youtube_throttle: boolean;
  preferred_audio_strategy: AudioStrategy;
  preferred_audio_languages: Set<string>;
  max_concurrent_downloads: number;
  show_desktop_notifications: boolean;
  show_desktop_notifications_private: boolean;
  history_days: number;
  show_transient_history: boolean;
  ui_theme: UiTheme;
  use_context_menu: boolean;
  preferred_quality: number | null;
  preferred_av_muxer: "mp4" | "mkv";
  popup_size: PopupSize;
  font_size: FontSize;
  preferred_discovered_media_order: DiscoveredOrder;
  successful_downloads_count: number;
  smartnaming: SmartnamingSetting;
  preview_mode: PreviewMode;
  last_migration_request: number;
  custom_strings: CustomStrings;
  remote_ruleset_revision: string;
  remote_notifications: Map<string, RemoteNotification>;
  remote_behaviours: RemoteBehaviours;
  /** Remote experiment flags: `experiment_hash_<cyrb53(name)>` → enabled (E21). */
  experiments: Record<string, boolean>;
  ruleset_last_refresh_ms: number;
  subtitle_languages: Set<string>;
}

/** Deep copy of the scanner config so callers can never mutate the shared default. */
function cloneGytScanner(config: GytScannerConfig): GytScannerConfig {
  return {
    ...(config.player_id !== undefined ? { player_id: config.player_id } : {}),
    media_scan_configuration: config.media_scan_configuration.map((entry) => ({ ...entry })),
  };
}

/**
 * Proven defaults from `S_()` (pretty 21060-21105). Two defaults are platform-computed in the
 * original and were not recovered; they are marked `TODO evidence` and use the safest value:
 * `download_directory` (`rr`, OS-dependent) and the language sets (`Bs()`).
 */
export function createDefaultSettings(): PersistentSettings {
  return {
    version: 1,
    default_action: "download",
    default_action_per_hostname: new Map<string, DefaultAction>(),
    downloaded: new Map<string, DownloadedRecord>(),
    lsd: 1710169438000,
    hide_nomedia_box: true,
    dont_ask_for_user_review: false,
    agreed_with_tos: false,
    dockmode: "popup",
    // TODO evidence: original default is `rr` (platform-dependent directory). "" = OS default
    // downloads root, which is the documented behaviour for an empty subdirectory.
    download_directory: "",
    youtube_throttle: true,
    preferred_audio_strategy: "original",
    // TODO evidence: original default is `Bs()` (platform/navigator-language dependent); an empty
    // set makes "user_language" fall back to the original track, the safest behaviour.
    preferred_audio_languages: new Set<string>(),
    max_concurrent_downloads: 6,
    show_desktop_notifications: true,
    show_desktop_notifications_private: false,
    history_days: 0,
    show_transient_history: true,
    ui_theme: "system",
    use_context_menu: true,
    preferred_quality: 1080,
    preferred_av_muxer: "mp4",
    popup_size: "medium",
    font_size: "default",
    preferred_discovered_media_order: "SMART",
    successful_downloads_count: 0,
    smartnaming: { source: null, compiled: defaultSmartnaming() },
    preview_mode: "video",
    last_migration_request: 0,
    custom_strings: { addon: new Map<string, string>(), web: new Map<string, string>() },
    remote_ruleset_revision: RULESET_REVISION,
    remote_notifications: new Map<string, RemoteNotification>(),
    remote_behaviours: {
      advertize_premium: DEFAULT_RULESET.behaviours.advertize_premium,
      gyt_scanner: cloneGytScanner(DEFAULT_RULESET.behaviours.gyt_scanner),
      websites: defaultBehaviours(DEFAULT_RULESET).websites,
    },
    experiments: { ...DEFAULT_RULESET.experiments },
    ruleset_last_refresh_ms: 0,
    // TODO evidence: same unresolved `Bs()` default as preferred_audio_languages.
    subtitle_languages: new Set<string>(),
  };
}

/**
 * Convenience immutable snapshot of the defaults. Mutable consumers should call
 * {@link createDefaultSettings} so they get their own Map/Set instances.
 */
export const DEFAULT_SETTINGS: PersistentSettings = createDefaultSettings();

// ---------------------------------------------------------------------------
// `mut-settings` mutations (channel 1; E22/§3.7). 19 keys proven — strict superset of the
// brief's 18 (the shipped `else if` chain has 19 branches, pretty 23076-23142).
// ---------------------------------------------------------------------------

export interface SettingsMutationResult {
  state: PersistentSettings;
  changed: boolean;
}

export function isSettingsMutationKey(value: string): value is SettingsMutationKey {
  return (SETTINGS_MUTATION_KEYS as readonly string[]).includes(value);
}

function setEquals<Value>(left: ReadonlySet<Value>, right: ReadonlySet<Value>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

const unchanged = (state: PersistentSettings): SettingsMutationResult => ({ state, changed: false });

/**
 * Apply one `mut-settings` message to the persistent state, mirroring the shipped guards:
 *  - scalar/string/enum fields: write only when the value differs;
 *  - `preferred_audio_languages` / `subtitles_language`: empty arrays are ignored (guard
 *    `s.size > 0`), otherwise applied only when the resulting set differs;
 *  - `always_download_as_mkv`: maps to `preferred_av_muxer` (`true` → "mkv", `false` → "mp4").
 *    The shipped branch writes unconditionally; `changed` reports the effective difference
 *    (the write itself is idempotent, so observable parity is unchanged).
 *  - unknown keys (possible with untyped wire data): no-op, like the shipped final `else a.data;`.
 *
 * Queue-side effects of `max_concurrent_downloads` / `youtube_throttle` are the shell's job (E22).
 */
export function applySettingsMutation(
  state: PersistentSettings,
  mutation: MutSettingsPayload,
): SettingsMutationResult {
  if ("preferred_audio_strategy" in mutation) {
    if (state.preferred_audio_strategy === mutation.preferred_audio_strategy) return unchanged(state);
    return { state: { ...state, preferred_audio_strategy: mutation.preferred_audio_strategy }, changed: true };
  }
  if ("preferred_audio_languages" in mutation) {
    const next = new Set(mutation.preferred_audio_languages);
    if (next.size === 0) return unchanged(state);
    if (setEquals(next, state.preferred_audio_languages)) return unchanged(state);
    return { state: { ...state, preferred_audio_languages: next }, changed: true };
  }
  if ("hide_nomedia_box" in mutation) {
    if (state.hide_nomedia_box === mutation.hide_nomedia_box) return unchanged(state);
    return { state: { ...state, hide_nomedia_box: mutation.hide_nomedia_box }, changed: true };
  }
  if ("max_concurrent_downloads" in mutation) {
    if (state.max_concurrent_downloads === mutation.max_concurrent_downloads) return unchanged(state);
    return {
      state: { ...state, max_concurrent_downloads: mutation.max_concurrent_downloads },
      changed: true,
    };
  }
  if ("show_desktop_notifications" in mutation) {
    if (state.show_desktop_notifications === mutation.show_desktop_notifications) return unchanged(state);
    return {
      state: { ...state, show_desktop_notifications: mutation.show_desktop_notifications },
      changed: true,
    };
  }
  if ("preferred_quality" in mutation) {
    if (state.preferred_quality === mutation.preferred_quality) return unchanged(state);
    return { state: { ...state, preferred_quality: mutation.preferred_quality }, changed: true };
  }
  if ("always_download_as_mkv" in mutation) {
    const muxer = mutation.always_download_as_mkv ? "mkv" : "mp4";
    if (state.preferred_av_muxer === muxer) return unchanged(state);
    return { state: { ...state, preferred_av_muxer: muxer }, changed: true };
  }
  if ("preview_mode" in mutation) {
    if (state.preview_mode === mutation.preview_mode) return unchanged(state);
    return { state: { ...state, preview_mode: mutation.preview_mode }, changed: true };
  }
  if ("show_desktop_notifications_private" in mutation) {
    if (state.show_desktop_notifications_private === mutation.show_desktop_notifications_private) {
      return unchanged(state);
    }
    return {
      state: { ...state, show_desktop_notifications_private: mutation.show_desktop_notifications_private },
      changed: true,
    };
  }
  if ("show_transient_history" in mutation) {
    if (state.show_transient_history === mutation.show_transient_history) return unchanged(state);
    return {
      state: { ...state, show_transient_history: mutation.show_transient_history },
      changed: true,
    };
  }
  if ("history_days" in mutation) {
    if (state.history_days === mutation.history_days) return unchanged(state);
    return { state: { ...state, history_days: mutation.history_days }, changed: true };
  }
  if ("ui_theme" in mutation) {
    if (state.ui_theme === mutation.ui_theme) return unchanged(state);
    return { state: { ...state, ui_theme: mutation.ui_theme }, changed: true };
  }
  if ("popup_size" in mutation) {
    if (state.popup_size === mutation.popup_size) return unchanged(state);
    return { state: { ...state, popup_size: mutation.popup_size }, changed: true };
  }
  if ("font_size" in mutation) {
    if (state.font_size === mutation.font_size) return unchanged(state);
    return { state: { ...state, font_size: mutation.font_size }, changed: true };
  }
  if ("youtube_throttle" in mutation) {
    if (state.youtube_throttle === mutation.youtube_throttle) return unchanged(state);
    return { state: { ...state, youtube_throttle: mutation.youtube_throttle }, changed: true };
  }
  if ("use_context_menu" in mutation) {
    if (state.use_context_menu === mutation.use_context_menu) return unchanged(state);
    return { state: { ...state, use_context_menu: mutation.use_context_menu }, changed: true };
  }
  if ("download_directory" in mutation) {
    if (state.download_directory === mutation.download_directory) return unchanged(state);
    return { state: { ...state, download_directory: mutation.download_directory }, changed: true };
  }
  if ("preferred_discovered_order" in mutation) {
    if (state.preferred_discovered_media_order === mutation.preferred_discovered_order) {
      return unchanged(state);
    }
    return {
      state: { ...state, preferred_discovered_media_order: mutation.preferred_discovered_order },
      changed: true,
    };
  }
  if ("subtitles_language" in mutation) {
    const next = new Set(mutation.subtitles_language);
    if (next.size === 0) return unchanged(state);
    if (setEquals(next, state.subtitle_languages)) return unchanged(state);
    return { state: { ...state, subtitle_languages: next }, changed: true };
  }
  // Unknown/extra keys: shipped handler ends with `else a.data;` (no write).
  return unchanged(state);
}

/**
 * `set_default_action` (channel 1, E §3.1/E30): only `download_audio` is stored per hostname;
 * every other action replaces the global default. The shipped handler also deletes the
 * per-hostname entry before applying, then refreshes the tab meta (side effect, shell job).
 */
export function applySetDefaultAction(
  state: PersistentSettings,
  payload: SetDefaultActionPayload,
): SettingsMutationResult {
  const { hostname, action } = payload;
  const hadPerHost = state.default_action_per_hostname.has(hostname);
  const perHost = state.default_action_per_hostname.get(hostname);
  if (action === "download_audio") {
    if (perHost === "download_audio") return unchanged(state);
    return {
      state: { ...state, default_action_per_hostname: new Map(state.default_action_per_hostname).set(hostname, action) },
      changed: true,
    };
  }
  const mapChanged = hadPerHost;
  const defaultChanged = state.default_action !== action;
  if (!mapChanged && !defaultChanged) return unchanged(state);
  const nextMap = new Map(state.default_action_per_hostname);
  nextMap.delete(hostname);
  return { state: { ...state, default_action_per_hostname: nextMap, default_action: action }, changed: true };
}

/**
 * Effective default action for a page URL: exact-hostname override wins, else the global
 * default (proven `Zy`, pretty 22484-22488).
 */
export function effectiveDefaultAction(
  state: PersistentSettings,
  url?: URL | string,
): DefaultAction {
  const hostname = url instanceof URL ? url.hostname : url;
  if (hostname !== undefined) {
    const perHost = state.default_action_per_hostname.get(hostname);
    if (perHost !== undefined) return perHost;
  }
  return state.default_action;
}

// ---------------------------------------------------------------------------
// Whole-state serialisation (`D_`/`ae` write, `Eb`/`ze`+zod read; E22)
// ---------------------------------------------------------------------------

/** Encode the whole state for `chrome.storage.local["global_persistent_state"]`. */
export function encodeState(state: PersistentSettings): unknown {
  return encode(state);
}

/**
 * Decode a stored state and restore missing top-level fields from the defaults, mirroring the
 * shipped per-field zod fallback in `xb` (pretty 21036-21058). `jwt` (excluded from this
 * interface) simply stays undecoded if present in an original state.
 */
export function decodeState(wire: unknown): PersistentSettings {
  const decoded = decode(wire);
  const defaults = createDefaultSettings();
  if (decoded === null || typeof decoded !== "object") return defaults;
  const source = decoded as Record<string, unknown>;
  const result: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result as unknown as PersistentSettings;
}
