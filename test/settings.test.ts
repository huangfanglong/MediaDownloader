import { describe, expect, it } from "vitest";
import { loadSmartnaming } from "../src/naming/rules.js";
import { cyrb53 } from "../src/protocol/channels.js";
import type { MutSettingsPayload } from "../src/protocol/messages.js";
import {
  BEHAVIOUR_FLAGS,
  DEFAULT_DOMAIN_LISTS,
  DEFAULT_RULESET,
  RULESET_REVISION,
  RULESET_SCHEMA_VERSION,
  behaviourHash,
  defaultBehaviours,
  domainHash,
  experimentHash,
  isFlagEnabled,
  lastTwoLabels,
  rulesetUrl,
  setFlag,
  toBehaviourEntries,
  toBehaviours,
  type BehaviourFlag,
} from "../src/settings/flags.js";
import {
  DEFAULT_SETTINGS,
  applySetDefaultAction,
  applySettingsMutation,
  createDefaultSettings,
  decodeState,
  effectiveDefaultAction,
  encodeState,
  isSettingsMutationKey,
  pruneDownloadHistory,
  type PersistentSettings,
} from "../src/settings/local.js";
import * as settings from "../src/settings/index.js";

/**
 * Settings parity tests.
 *
 * Evidence: analysis/evidence/01-messaging-runtime.md E19-E24, §3.7. The shipped default ruleset
 * literals (behaviour hashes/domain hashes) are independent oracles: if the cyrb53 seed or the
 * domain normalisation drifts, these tests fail even though the implementation is self-consistent.
 */

describe("local settings defaults (E22, `S_()` pretty 21060-21105)", () => {
  it("matches the proven scalar defaults", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      version: 1,
      default_action: "download",
      lsd: 1710169438000,
      hide_nomedia_box: true,
      dont_ask_for_user_review: false,
      agreed_with_tos: false,
      dockmode: "popup",
      download_directory: "",
      youtube_throttle: true,
      preferred_audio_strategy: "original",
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
      preview_mode: "video",
      last_migration_request: 0,
      remote_ruleset_revision: RULESET_REVISION,
      ruleset_last_refresh_ms: 0,
    });
    expect(DEFAULT_SETTINGS.default_action_per_hostname.size).toBe(0);
    expect(DEFAULT_SETTINGS.downloaded.size).toBe(0);
    expect(DEFAULT_SETTINGS.preferred_audio_languages.size).toBe(0);
    expect(DEFAULT_SETTINGS.subtitle_languages.size).toBe(0);
    expect(DEFAULT_SETTINGS.custom_strings.addon.size).toBe(0);
    expect(DEFAULT_SETTINGS.smartnaming).toEqual({
      source: null,
      compiled: { default_: { max_length: 64, template: "%title" }, rules: [] },
    });
    expect(DEFAULT_SETTINGS.remote_behaviours.advertize_premium).toBe(true);
    expect(DEFAULT_SETTINGS.remote_behaviours.gyt_scanner.media_scan_configuration).toHaveLength(5);
  });

  it("excludes the premium/licensing fields (jwt) from the rebuilt state", () => {
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain("jwt");
  });

  it("hands out independent mutable copies from the factory", () => {
    const first = createDefaultSettings();
    first.preferred_audio_languages.add("xx");
    first.remote_behaviours.websites.get(behaviourHash("DISABLE_PREVIEW_LOADING"))?.clear();
    const second = createDefaultSettings();
    expect(second.preferred_audio_languages.size).toBe(0);
    expect(isFlagEnabled(second.remote_behaviours, "DISABLE_PREVIEW_LOADING", "taiav.com")).toBe(true);
    expect(DEFAULT_SETTINGS.preferred_audio_languages.size).toBe(0);
  });

  it("barrel exports both systems", () => {
    expect(settings.DEFAULT_SETTINGS.dockmode).toBe("popup");
    expect(settings.DEFAULT_RULESET.schema_version).toBe(RULESET_SCHEMA_VERSION);
    expect(settings.isFlagEnabled).toBeTypeOf("function");
  });
});

describe("mut-settings application (E22/§3.7: 19 keys, shipped guard semantics)", () => {
  const scalarCases: Array<{
    mutation: MutSettingsPayload;
    check: (state: PersistentSettings) => void;
  }> = [
    { mutation: { preferred_audio_strategy: "user_language" }, check: (s) => expect(s.preferred_audio_strategy).toBe("user_language") },
    { mutation: { preferred_audio_languages: ["fr", "en"] }, check: (s) => expect([...s.preferred_audio_languages]).toEqual(["fr", "en"]) },
    { mutation: { hide_nomedia_box: false }, check: (s) => expect(s.hide_nomedia_box).toBe(false) },
    { mutation: { max_concurrent_downloads: 3 }, check: (s) => expect(s.max_concurrent_downloads).toBe(3) },
    { mutation: { show_desktop_notifications: false }, check: (s) => expect(s.show_desktop_notifications).toBe(false) },
    { mutation: { preferred_quality: null }, check: (s) => expect(s.preferred_quality).toBeNull() },
    { mutation: { preferred_quality: 720 }, check: (s) => expect(s.preferred_quality).toBe(720) },
    { mutation: { always_download_as_mkv: true }, check: (s) => expect(s.preferred_av_muxer).toBe("mkv") },
    { mutation: { preview_mode: "none" }, check: (s) => expect(s.preview_mode).toBe("none") },
    { mutation: { show_desktop_notifications_private: true }, check: (s) => expect(s.show_desktop_notifications_private).toBe(true) },
    { mutation: { show_transient_history: false }, check: (s) => expect(s.show_transient_history).toBe(false) },
    { mutation: { history_days: 30 }, check: (s) => expect(s.history_days).toBe(30) },
    { mutation: { ui_theme: "dark" }, check: (s) => expect(s.ui_theme).toBe("dark") },
    { mutation: { popup_size: "big" }, check: (s) => expect(s.popup_size).toBe("big") },
    { mutation: { font_size: "verylarge" }, check: (s) => expect(s.font_size).toBe("verylarge") },
    { mutation: { youtube_throttle: false }, check: (s) => expect(s.youtube_throttle).toBe(false) },
    { mutation: { use_context_menu: false }, check: (s) => expect(s.use_context_menu).toBe(false) },
    { mutation: { download_directory: "Movies/" }, check: (s) => expect(s.download_directory).toBe("Movies/") },
    { mutation: { preferred_discovered_order: "OLDEST" }, check: (s) => expect(s.preferred_discovered_media_order).toBe("OLDEST") },
    { mutation: { subtitles_language: ["en", "de"] }, check: (s) => expect([...s.subtitle_languages]).toEqual(["en", "de"]) },
  ];

  it("covers all 19 mutation keys (20 cases: preferred_quality has non-null + null)", () => {
    expect(scalarCases).toHaveLength(20);
    const payloads: MutSettingsPayload[] = [{ preferred_audio_languages: [] }];
    for (const { mutation } of scalarCases) payloads.push(mutation);
    expect(new Set(payloads.map((payload) => Object.keys(payload)[0]))).toEqual(
      new Set([
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
      ]),
    );
  });

  it("applies each mutation, reports changed, then treats the same value as a no-op", () => {
    for (const { mutation, check } of scalarCases) {
      const state = createDefaultSettings();
      const result = applySettingsMutation(state, mutation);
      expect(result.changed, `expected change for ${Object.keys(mutation)[0]}`).toBe(true);
      expect(result.state).not.toBe(state);
      check(result.state);
      // Original state must not be mutated (state machinery replaces objects).
      expect(state).toEqual(createDefaultSettings());

      const again = applySettingsMutation(result.state, mutation);
      expect(again.changed, `expected no-op for ${Object.keys(mutation)[0]}`).toBe(false);
      expect(again.state).toBe(result.state);
    }
  });

  it("ignores empty language arrays (shipped `s.size > 0` guard)", () => {
    const state = createDefaultSettings();
    const languages = applySettingsMutation(state, { preferred_audio_languages: [] });
    expect(languages.changed).toBe(false);
    expect(languages.state).toBe(state);
    const subtitles = applySettingsMutation(state, { subtitles_language: [] });
    expect(subtitles.changed).toBe(false);
    expect(subtitles.state).toBe(state);
  });

  it("compares language sets order-insensitively", () => {
    const state = createDefaultSettings();
    state.preferred_audio_languages = new Set(["en", "fr"]);
    const result = applySettingsMutation(state, { preferred_audio_languages: ["fr", "en"] });
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
  });

  it("maps always_download_as_mkv onto preferred_av_muxer (both directions)", () => {
    const state = createDefaultSettings();
    const toMkv = applySettingsMutation(state, { always_download_as_mkv: true });
    expect(toMkv.state.preferred_av_muxer).toBe("mkv");
    const backToMp4 = applySettingsMutation(toMkv.state, { always_download_as_mkv: false });
    expect(backToMp4.state.preferred_av_muxer).toBe("mp4");
    expect(backToMp4.changed).toBe(true);
    // Already-default target => no write needed.
    const noop = applySettingsMutation(state, { always_download_as_mkv: false });
    expect(noop.changed).toBe(false);
  });

  it("ignores unknown keys like the shipped final `else a.data;` branch", () => {
    const state = createDefaultSettings();
    const result = applySettingsMutation(state, { not_a_setting: 1 } as unknown as MutSettingsPayload);
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
  });

  it("recognises exactly the shipped mutation keys", () => {
    expect(isSettingsMutationKey("mut-settings")).toBe(false);
    expect(isSettingsMutationKey("ui_theme")).toBe(true);
    expect(isSettingsMutationKey("jwt")).toBe(false);
  });

  it("max_concurrent_downloads accepts the raw number (queue capacity side effects are shell-owned)", () => {
    const result = applySettingsMutation(createDefaultSettings(), { max_concurrent_downloads: 12 });
    expect(result.state.max_concurrent_downloads).toBe(12);
  });
});

describe("set_default_action and per-host override (E30, `Zy` pretty 22484-22488)", () => {
  it("stores only download_audio per hostname, everything else globally", () => {
    const state = createDefaultSettings();
    const audio = applySetDefaultAction(state, { hostname: "example.com", action: "download_audio" });
    expect(audio.changed).toBe(true);
    expect(audio.state.default_action_per_hostname.get("example.com")).toBe("download_audio");
    expect(audio.state.default_action).toBe("download");
    expect(state.default_action_per_hostname.size).toBe(0);

    const duplicate = applySetDefaultAction(audio.state, {
      hostname: "example.com",
      action: "download_audio",
    });
    expect(duplicate.changed).toBe(false);

    const copy = applySetDefaultAction(audio.state, { hostname: "example.com", action: "copy" });
    expect(copy.changed).toBe(true);
    expect(copy.state.default_action).toBe("copy");
    expect(copy.state.default_action_per_hostname.has("example.com")).toBe(false);

    const same = applySetDefaultAction(copy.state, { hostname: "example.com", action: "copy" });
    expect(same.changed).toBe(false);
    expect(same.state).toBe(copy.state);
  });

  it("resolves the effective action by exact hostname, then global default", () => {
    const state = applySetDefaultAction(createDefaultSettings(), {
      hostname: "example.com",
      action: "download_audio",
    }).state;
    expect(effectiveDefaultAction(state, new URL("https://example.com/watch"))).toBe("download_audio");
    expect(effectiveDefaultAction(state, "example.com")).toBe("download_audio");
    expect(effectiveDefaultAction(state, new URL("https://other.com/watch"))).toBe("download");
    expect(effectiveDefaultAction(state, undefined)).toBe("download");
  });
});

describe("whole-state serde round-trip (E22: one value in chrome.storage.local)", () => {
  it("encodes as the tagged serde object and decodes back losslessly", () => {
    const state = createDefaultSettings();
    state.downloaded.set("ded_1", {
      downloaded_id: "ded_1",
      media_hash: "media_hash_1",
      path: "Downloads/file.mp4",
      browser_download_id: 12,
      download_timestamp: 1_700_000_000_000,
      origin_url: new URL("https://example.com/watch"),
      origin_favicon_url: null,
      has_drm: false,
      subdir: "Movies/",
    });
    state.custom_strings.web.set("title", "My title");
    state.remote_notifications.set("notification_remote", {
      type: "remote",
      title: "Remote notice",
      details: "details",
      url: new URL("https://downloadhelper.net/notice"),
      level: "WARN",
    });
    state.preferred_audio_languages.add("fr");
    state.smartnaming = {
      source: '{"max_length":64,"template":"%title"}',
      compiled: loadSmartnaming('{"max_length":64,"template":"%title"}'),
    };

    const wire = encodeState(state) as Record<string, unknown>;
    expect(wire.__serde_tag).toBe("object");

    const decoded = decodeState(wire);
    expect(decoded).toEqual(state);
    expect(decoded.downloaded).toBeInstanceOf(Map);
    expect(decoded.downloaded.get("ded_1")?.origin_url).toBeInstanceOf(URL);
    expect(decoded.remote_notifications).toBeInstanceOf(Map);
    expect(decoded.remote_behaviours.websites).toBeInstanceOf(Map);
    expect(decoded.preferred_audio_languages).toBeInstanceOf(Set);
    expect(decoded.custom_strings.web.get("title")).toBe("My title");
  });

  it("fills missing top-level fields from the defaults (shipped per-field zod fallback)", () => {
    const decoded = decodeState(encodeState({ version: 3 } as unknown as PersistentSettings));
    expect(decoded.version).toBe(3);
    expect(decoded.max_concurrent_downloads).toBe(6);
    expect(decoded.dockmode).toBe("popup");
  });

  it("falls back to full defaults for garbage storage values", () => {
    expect(decodeState(null)).toEqual(createDefaultSettings());
    expect(decodeState("not-a-state")).toEqual(createDefaultSettings());
  });
});

describe("behaviour flags: hash parity with the shipped ruleset (E19-E20)", () => {
  it("cyrb53 reproduces the three corroborating literals the Lead verified", () => {
    expect(cyrb53("hello")).toBe(4625896200565286);
    expect(cyrb53("BLOCK_MEDIA_DETECTION")).toBe(2168192316009402);
    expect(cyrb53("ALLOW_BRAVE_YT_DL")).toBe(1986546207779496);
  });

  /**
   * Shipped default ruleset literals (`hb`, pretty 20830-20879). These numbers are independent of
   * our implementation: they are the strings the extension compares at runtime.
   */
  const SHIPPED_BEHAVIOUR_HASHES: Array<[BehaviourFlag, string]> = [
    ["BLOCK_MEDIA_DETECTION", "behaviour_hash_2168192316009402"],
    ["AUDIO_ONLY_WEBSITES", "behaviour_hash_5442823870738372"],
    ["FIFO_DISCOVERED_WEBSITES", "behaviour_hash_169748210392549"],
    ["FILTER_HTTP_M3U8_MEDIA", "behaviour_hash_4462004333852502"],
    ["CONVERT_MPD_URL_TO_M3U8", "behaviour_hash_1928834492410043"],
    ["DISABLE_PREVIEW_LOADING", "behaviour_hash_5594683955913774"],
    ["ALLOW_SMALL_FILE_DETECTION", "behaviour_hash_2625634307936170"],
    ["CARRY_GET_PARAM_WEBSITES", "behaviour_hash_154935787860009"],
    ["STRIP_GET_PARAM_WEBSITES", "behaviour_hash_1315705546100808"],
  ];

  it.each(SHIPPED_BEHAVIOUR_HASHES)("%s hashes to %s", (flag, expected) => {
    expect(behaviourHash(flag)).toBe(expected);
  });

  it("normalises hosts to the last two labels (faithful co.uk quirk)", () => {
    expect(lastTwoLabels("www.example.com")).toBe("example.com");
    expect(lastTwoLabels("example.com")).toBe("example.com");
    expect(lastTwoLabels("cdn.example.co.uk")).toBe("co.uk");
    expect(lastTwoLabels("localhost")).toBe("localhost");
    // Documented quirk: ports are not stripped by the shipped `Dt` transformation.
    expect(lastTwoLabels("example.com:8443")).toBe("example.com:8443");
  });

  it("domainHash pins shipped literals (taiav/youtube/instagram)", () => {
    expect(domainHash("taiav.com")).toBe("domain_hash_5134534004467113");
    expect(domainHash("www.taiav.com")).toBe("domain_hash_5134534004467113");
    expect(domainHash("youtube.com")).toBe("domain_hash_4848129498195786");
    expect(domainHash("www.instagram.com")).toBe("domain_hash_8900746365645186");
    expect(domainHash("example.com:8443")).toBe(`domain_hash_${cyrb53("example.com:8443")}`);
  });

  it("experiment hash pins ALLOW_BRAVE_YT_DL (enabled by default)", () => {
    expect(experimentHash("ALLOW_BRAVE_YT_DL")).toBe("experiment_hash_1986546207779496");
    expect(DEFAULT_RULESET.experiments).toEqual({
      experiment_hash_1986546207779496: true,
    });
    expect(DEFAULT_SETTINGS.experiments).toEqual(DEFAULT_RULESET.experiments);
  });

  it("rebuilds the embedded default ruleset structure (schema 4, 9 behaviour entries)", () => {
    expect(DEFAULT_RULESET.schema_version).toBe(4);
    expect(DEFAULT_RULESET.rules_revision).toBe("10.6.1.2");
    expect(DEFAULT_RULESET.remote_notifications).toEqual([]);
    expect(DEFAULT_RULESET.behaviours.advertize_premium).toBe(true);
    expect(DEFAULT_RULESET.behaviours.websites).toHaveLength(9);
    expect(DEFAULT_RULESET.behaviours.websites.map((entry) => entry.behaviour_hash)).toEqual(
      BEHAVIOUR_FLAGS.map((flag) => behaviourHash(flag)),
    );
  });

  it("keeps only the decoded default domain hashes (E20 table); unresolved lists stay empty", () => {
    const byHash = new Map(
      DEFAULT_RULESET.behaviours.websites.map((entry) => [entry.behaviour_hash, entry.domain_hash_set]),
    );
    expect(byHash.get(behaviourHash("DISABLE_PREVIEW_LOADING"))).toEqual([
      "domain_hash_5134534004467113",
    ]);
    expect(byHash.get(behaviourHash("AUDIO_ONLY_WEBSITES"))).toEqual(["domain_hash_7071161895522280"]);
    expect(byHash.get(behaviourHash("FIFO_DISCOVERED_WEBSITES"))).toHaveLength(6);
    expect(byHash.get(behaviourHash("FILTER_HTTP_M3U8_MEDIA"))).toHaveLength(4);
    expect(byHash.get(behaviourHash("BLOCK_MEDIA_DETECTION"))).toEqual([]);
    // Documented unresolved data: CARRY/STRIP/CONVERT_MPD/ALLOW_SMALL_FILE have 1 unknown each.
    expect(DEFAULT_DOMAIN_LISTS.CARRY_GET_PARAM_WEBSITES).toEqual([]);
    expect(DEFAULT_DOMAIN_LISTS.STRIP_GET_PARAM_WEBSITES).toEqual([]);
    expect(DEFAULT_DOMAIN_LISTS.CONVERT_MPD_URL_TO_M3U8).toEqual([]);
    expect(DEFAULT_DOMAIN_LISTS.ALLOW_SMALL_FILE_DETECTION).toEqual([]);
  });

  it("isFlagEnabled matches the shipped last-two-label lookup (including quirk cases)", () => {
    const behaviours = defaultBehaviours();
    expect(isFlagEnabled(behaviours, "DISABLE_PREVIEW_LOADING", "taiav.com")).toBe(true);
    expect(isFlagEnabled(behaviours, "DISABLE_PREVIEW_LOADING", "www.taiav.com")).toBe(true);
    expect(isFlagEnabled(behaviours, "DISABLE_PREVIEW_LOADING", new URL("https://www.taiav.com/x"))).toBe(true);
    // A host that merely embeds the flagged name is not flagged (last two labels only).
    expect(isFlagEnabled(behaviours, "DISABLE_PREVIEW_LOADING", "taiav.com.evil.com")).toBe(false);
    expect(isFlagEnabled(behaviours, "FIFO_DISCOVERED_WEBSITES", "www.instagram.com")).toBe(true);
    expect(isFlagEnabled(behaviours, "FILTER_HTTP_M3U8_MEDIA", "www.rumble.com")).toBe(true);
    expect(isFlagEnabled(behaviours, "AUDIO_ONLY_WEBSITES", "soundcloud.com")).toBe(true);
    // BLOCK_MEDIA_DETECTION has an empty default domain set.
    expect(isFlagEnabled(behaviours, "BLOCK_MEDIA_DETECTION", "youtube.com")).toBe(false);
    // Unknown flag entry.
    expect(
      isFlagEnabled({ websites: new Map() }, "DISABLE_PREVIEW_LOADING", "taiav.com"),
    ).toBe(false);
  });

  it("setFlag is immutable and idempotent", () => {
    const original = defaultBehaviours();
    const enabled = setFlag(original, "CARRY_GET_PARAM_WEBSITES", "example.com", true);
    expect(enabled).not.toBe(original);
    expect(isFlagEnabled(enabled, "CARRY_GET_PARAM_WEBSITES", "example.com")).toBe(true);
    expect(isFlagEnabled(original, "CARRY_GET_PARAM_WEBSITES", "example.com")).toBe(false);

    const disabled = setFlag(enabled, "CARRY_GET_PARAM_WEBSITES", "www.example.com", false);
    expect(isFlagEnabled(disabled, "CARRY_GET_PARAM_WEBSITES", "example.com")).toBe(false);
    // Other flags untouched.
    expect(isFlagEnabled(disabled, "DISABLE_PREVIEW_LOADING", "taiav.com")).toBe(true);
    // Idempotent: disabling again changes nothing observable.
    const again = setFlag(disabled, "CARRY_GET_PARAM_WEBSITES", "example.com", false);
    expect(isFlagEnabled(again, "CARRY_GET_PARAM_WEBSITES", "example.com")).toBe(false);
  });

  it("round-trips Behaviours through the ruleset array form deterministically", () => {
    const behaviours = setFlag(defaultBehaviours(), "STRIP_GET_PARAM_WEBSITES", "example.com", true);
    const entries = toBehaviourEntries(behaviours);
    expect(entries.map((entry) => entry.behaviour_hash)).toEqual(
      [...entries].map((entry) => entry.behaviour_hash).sort(),
    );
    expect(toBehaviours(entries).websites).toEqual(behaviours.websites);
  });

  it("builds the daily ruleset URL from the proven constants", () => {
    expect(rulesetUrl()).toBe("https://files.downloadhelper.net/4/ruleset-stable-google.json");
    expect(rulesetUrl({ release: "beta", platform: "mozilla" })).toBe(
      "https://files.downloadhelper.net/4/ruleset-beta-mozilla.json",
    );
  });
});

describe("download history retention", () => {
  const record = (id: string, download_timestamp: number) => ({
    downloaded_id: id,
    media_hash: id,
    path: `${id}.mp4`,
    browser_download_id: 1,
    download_timestamp,
    origin_url: null,
    origin_favicon_url: null,
    has_drm: false,
  });

  it("removes records outside the retention window", () => {
    const settings = createDefaultSettings();
    settings.history_days = 7;
    settings.downloaded = new Map([
      ["old", record("old", 1_699_000_000_000)],
      ["recent", record("recent", 1_700_500_000_000)],
    ]);

    expect(pruneDownloadHistory(settings, 1_700_500_000_000)).toBe(true);
    expect([...settings.downloaded.keys()]).toEqual(["recent"]);
    expect(pruneDownloadHistory(settings, 1_700_500_000_000)).toBe(false);
  });

  it("clears existing records when persistent history is disabled", () => {
    const settings = createDefaultSettings();
    settings.downloaded.set("old", record("old", 1_700_000_000_000));

    expect(pruneDownloadHistory(settings, 1_700_500_000_000)).toBe(true);
    expect(settings.downloaded.size).toBe(0);
  });
});
