/**
 * Remote "behaviour flag" system — the shipped feature-flag mechanism.
 *
 * Evidence: analysis/evidence/01-messaging-runtime.md E19-E21, E23 (§2.6); original service
 * worker `Dt` (pretty 9466-9472; original bytes 199,958) and the embedded default ruleset
 * (`hb`, pretty 20830-20879; bytes ~493k). The flags are NOT local user settings: they are a
 * remote ruleset of `behaviour_hash_<cyrb53(FLAG)>` → `domain_hash_<cyrb53(hostname SLD)>`
 * pairs, refreshed at most once per day from the configured remote ruleset endpoint.
 *
 * The `cyrb53` import is the shared implementation from `protocol/channels.ts` (Lead verified the
 * shipped seed constants; see that file's doc comment). Do not re-implement it here.
 */

import { cyrb53 } from "../protocol/channels.js";

/** The nine proven behaviour flags (`nb` zod keyof, pretty 20738-20750; wrappers 9473-9499). */
export type BehaviourFlag =
  | "BLOCK_MEDIA_DETECTION"
  | "AUDIO_ONLY_WEBSITES"
  | "FIFO_DISCOVERED_WEBSITES"
  | "FILTER_HTTP_M3U8_MEDIA"
  | "CONVERT_MPD_URL_TO_M3U8"
  | "DISABLE_PREVIEW_LOADING"
  | "ALLOW_SMALL_FILE_DETECTION"
  | "CARRY_GET_PARAM_WEBSITES"
  | "STRIP_GET_PARAM_WEBSITES";

/** All flags in the order used by the detection evidence (D26) and the embedded ruleset. */
export const BEHAVIOUR_FLAGS: readonly BehaviourFlag[] = [
  "BLOCK_MEDIA_DETECTION",
  "AUDIO_ONLY_WEBSITES",
  "FIFO_DISCOVERED_WEBSITES",
  "FILTER_HTTP_M3U8_MEDIA",
  "CONVERT_MPD_URL_TO_M3U8",
  "DISABLE_PREVIEW_LOADING",
  "ALLOW_SMALL_FILE_DETECTION",
  "CARRY_GET_PARAM_WEBSITES",
  "STRIP_GET_PARAM_WEBSITES",
];

/**
 * Host normalisation used by the shipped `Dt`: last two labels only.
 *
 * Faithful quirks: `www.example.com` → `example.com`, `x.co.uk` → `co.uk`, and any port/trailing
 * dot is *not* stripped (call sites are expected to pass a hostname; the
 * `CONVERT_MPD_URL_TO_M3U8` call site passes `URL.host`, which can carry a port — documented in
 * the evidence doc, hash function unchanged).
 */
export function lastTwoLabels(host: string): string {
  return host.split(".").slice(-2).join(".");
}

/** `behaviour_hash_<cyrb53(flag)>` (proven: `Dt` constructs this key, pretty 9467-9469). */
export function behaviourHash(flag: BehaviourFlag): string {
  return `behaviour_hash_${cyrb53(flag)}`;
}

/** `domain_hash_<cyrb53(last two labels)>` (proven: `Dt`, pretty 9468-9469). */
export function domainHash(host: string): string {
  return `domain_hash_${cyrb53(lastTwoLabels(host))}`;
}

/** `experiment_hash_<cyrb53(name)>` (proven: `__`/`vb`, pretty 20732-20733 and 20941-20944). */
export function experimentHash(name: string): string {
  return `experiment_hash_${cyrb53(name)}`;
}

/** Remote behaviours exactly as the persistent state stores them (map of hash → domain set). */
export interface Behaviours {
  websites: Map<string, Set<string>>;
}

function hostnameOf(host: string | URL): string {
  if (host instanceof URL) return host.hostname;
  if (host.includes("://")) {
    try {
      return new URL(host).hostname;
    } catch {
      return host;
    }
  }
  return host;
}

/**
 * Flag lookup for one host. Equivalent to the shipped `Dt(e, flag, host)`:
 * behaviour set exists AND contains the domain's hash.
 */
export function isFlagEnabled(
  behaviours: Behaviours,
  flag: BehaviourFlag,
  host: string | URL,
): boolean {
  const domains = behaviours.websites.get(behaviourHash(flag));
  if (domains === undefined) return false;
  return domains.has(domainHash(hostnameOf(host)));
}

/**
 * Immutable enable/disable of one flag for one host. Returns a new `Behaviours`; the input is
 * never mutated (the service worker state machinery replaces state objects wholesale).
 */
export function setFlag(
  behaviours: Behaviours,
  flag: BehaviourFlag,
  host: string | URL,
  enabled: boolean,
): Behaviours {
  const key = behaviourHash(flag);
  const target = domainHash(hostnameOf(host));
  const websites = new Map(behaviours.websites);
  const next = new Set(websites.get(key));
  if (enabled) next.add(target);
  else next.delete(target);
  websites.set(key, next);
  return { websites };
}

/** Serialise a `Behaviours` instance into the ruleset file's array form. */
export function toBehaviourEntries(
  behaviours: Behaviours,
): Array<{ behaviour_hash: string; domain_hash_set: string[] }> {
  return [...behaviours.websites.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([behaviour_hash, domains]) => ({
      behaviour_hash,
      domain_hash_set: [...domains].sort(),
    }));
}

/** Flatten the ruleset file's array form into the persistent-state map form (E22 `h_`). */
export function toBehaviours(
  entries: readonly { behaviour_hash: string; domain_hash_set: readonly string[] }[],
): Behaviours {
  const websites = new Map<string, Set<string>>();
  for (const entry of entries) websites.set(entry.behaviour_hash, new Set(entry.domain_hash_set));
  return { websites };
}

// ---------------------------------------------------------------------------
// Embedded default ruleset (schema_version 4, rules_revision "10.6.1.2")
// Evidence: `hb` object, pretty 20830-20879 (E20/E22). The default is used when the remote
// ruleset was never fetched; the service refreshes it at most once per day (E19).
// ---------------------------------------------------------------------------

/** YouTube scanner clients enumerated by the ruleset schema (15 values, pretty 20771-20787). */
export type GytClient =
  | "IOS"
  | "WEB"
  | "MWEB"
  | "ANDROID"
  | "YTMUSIC"
  | "YTMUSIC_ANDROID"
  | "YTSTUDIO_ANDROID"
  | "TV"
  | "TV_SIMPLY"
  | "TV_EMBEDDED"
  | "YTKIDS"
  | "WEB_EMBEDDED"
  | "WEB_CREATOR"
  | "ANDROID_VR"
  | "VISIONOS";

/** Client implementation modes enumerated by the ruleset schema (pretty 20754-20756). */
export type GytImplementation = "no_cookies_no_vdata" | "no_cookies_vdata" | "cookies";

export interface GytScannerConfig {
  player_id?: string;
  media_scan_configuration: Array<{ client: GytClient; implementation: GytImplementation }>;
}

export type RemoteNotificationLevel = "ERROR" | "WARN" | "HAPPY";

export interface EmbeddedRemoteNotification {
  title: string;
  description: string;
  level: RemoteNotificationLevel;
  link_to?: string;
}

export interface EmbeddedBehaviourEntry {
  behaviour_hash: string;
  domain_hash_set: string[];
}

export interface EmbeddedRuleset {
  schema_version: number;
  remote_notifications: EmbeddedRemoteNotification[];
  behaviours: {
    advertize_premium: boolean;
    gyt_scanner: GytScannerConfig;
    websites: EmbeddedBehaviourEntry[];
  };
  experiments: Record<string, boolean>;
  rules_revision: string;
}

export const RULESET_SCHEMA_VERSION = 4;
export const RULESET_REVISION = "10.6.1.2";
export const RULESET_BASE_URL = "https://files.downloadhelper.net";

/** Ruleset URL template: `${base}/${schema}/ruleset-${release}-${platform}.json` (E19). */
export function rulesetUrl(
  options: { schemaVersion?: number; release?: string; platform?: "google" | "mozilla" | "microsoft" } = {},
): string {
  const { schemaVersion = RULESET_SCHEMA_VERSION, release = "stable", platform = "google" } = options;
  return `${RULESET_BASE_URL}/${schemaVersion}/ruleset-${release}-${platform}.json`;
}

/** Experiment flag gating YouTube downloads on Chromium (default enabled; E21). */
export const EXPERIMENT_ALLOW_BRAVE_YT_DL = "ALLOW_BRAVE_YT_DL";

/**
 * Domain lists decoded from the embedded default ruleset by inverting the cyrb53 hashes against
 * candidate hostnames (analysis/scratch/hash.mjs, domains2.mjs, domains3.mjs).
 *
 * Flag meanings/consumers (E20):
 *  - BLOCK_MEDIA_DETECTION        — item never stored (Vy first condition)
 *  - CARRY_GET_PARAM_WEBSITES     — keep query params when fetching (carry_get_params)
 *  - STRIP_GET_PARAM_WEBSITES     — strip URL.search before fetching a manifest
 *  - AUDIO_ONLY_WEBSITES          — discovered m3u8 forced to audio-only
 *  - FIFO_DISCOVERED_WEBSITES     — per-tab media map becomes FIFO capped at 30
 *  - FILTER_HTTP_M3U8_MEDIA       — drop plain m3u8 when a playlist exists for the initiator
 *  - CONVERT_MPD_URL_TO_M3U8      — try url.replace(".mpd",".m3u8") first
 *  - DISABLE_PREVIEW_LOADING      — request_preview answers on_no_preview
 *  - ALLOW_SMALL_FILE_DETECTION   — allow HTTP media with content-length < 500_000
 *
 * Unresolved: the shipped default ruleset also hashes 7 domains we could not invert (one each for
 * CARRY/STRIP/CONVERT_MPD/ALLOW_SMALL_FILE, three for FILTER). They are data, not protocol; the
 * remote ruleset supplies them on refresh. The empty-list entries below are documented rather
 * than guessed (evidence doc §5 item 2).
 */
export const DEFAULT_DOMAIN_LISTS: Readonly<Record<BehaviourFlag, readonly string[]>> = {
  // Shipped entry has one unresolved domain hash; keep the entry, empty set.
  BLOCK_MEDIA_DETECTION: [],
  AUDIO_ONLY_WEBSITES: ["soundcloud.com"],
  FIFO_DISCOVERED_WEBSITES: [
    "tiktok.com",
    "facebook.com",
    "instagram.com",
    "douyin.com",
    "rumble.com",
    "kick.com",
  ],
  // Shipped entry also has three unresolved domain hashes.
  FILTER_HTTP_M3U8_MEDIA: ["twitch.tv", "nicovideo.jp", "arte.tv", "rumble.com"],
  // Shipped entry has one unresolved domain hash.
  CONVERT_MPD_URL_TO_M3U8: [],
  DISABLE_PREVIEW_LOADING: ["taiav.com"],
  // Shipped entry has one unresolved domain hash.
  ALLOW_SMALL_FILE_DETECTION: [],
  // Shipped entries each have one unresolved domain hash.
  CARRY_GET_PARAM_WEBSITES: [],
  STRIP_GET_PARAM_WEBSITES: [],
};

export const DEFAULT_GYT_SCANNER: GytScannerConfig = {
  player_id: "",
  media_scan_configuration: [
    { client: "VISIONOS", implementation: "no_cookies_no_vdata" },
    { client: "ANDROID_VR", implementation: "no_cookies_no_vdata" },
    { client: "IOS", implementation: "no_cookies_no_vdata" },
    { client: "MWEB", implementation: "cookies" },
    { client: "WEB", implementation: "cookies" },
  ],
};

/** The embedded `hb` default ruleset, rebuilt from the semantic domain lists above. */
export const DEFAULT_RULESET: EmbeddedRuleset = {
  schema_version: RULESET_SCHEMA_VERSION,
  remote_notifications: [],
  behaviours: {
    advertize_premium: true,
    gyt_scanner: DEFAULT_GYT_SCANNER,
    websites: BEHAVIOUR_FLAGS.map((flag) => ({
      behaviour_hash: behaviourHash(flag),
      domain_hash_set: DEFAULT_DOMAIN_LISTS[flag].map(domainHash),
    })),
  },
  experiments: {
    [experimentHash(EXPERIMENT_ALLOW_BRAVE_YT_DL)]: true,
  },
  rules_revision: RULESET_REVISION,
};

/** Default persistent-state `remote_behaviours.websites` (flattened map form). */
export function defaultBehaviours(ruleset: EmbeddedRuleset = DEFAULT_RULESET): Behaviours {
  return toBehaviours(ruleset.behaviours.websites);
}
