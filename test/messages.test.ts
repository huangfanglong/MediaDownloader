import { describe, expect, it } from "vitest";
import type { DownloadPlan, MediaItem, TabMeta, TransferOutcome } from "../src/core/types.js";
import { TransferStrategy } from "../src/core/types.js";
import { Channel } from "../src/protocol/channels.js";
import {
  MSG,
  SETTINGS_MUTATION_KEYS,
  isContentToService,
  isInjectedToService,
  isPageBridge,
  isServiceToContent,
  isServiceToInjected,
  isWorkerBus,
  makeContentToServiceEnvelope,
  makeEnvelope,
  makeServiceToContentEnvelope,
  makeWorkerEnvelope,
  type DownloadProgressPayload,
  type DoDownloadPayload,
  type MessageEnvelope,
  type WorkerDownloadPayload,
} from "../src/protocol/messages.js";
import { structured } from "../src/protocol/serde.js";

/**
 * Catalog + envelope invariants. Evidence: analysis/evidence/01-messaging-runtime.md E8-E18,
 * §3.1-§3.7. The literals below are copied from the shipped consumers/producers (grep catalog in
 * captured during discovery and recorded in analysis/evidence/), not invented.
 */

const doDownloadFixture = (): DoDownloadPayload => {
  const media: MediaItem = {
    type: "m3u8_playlist",
    hash: "media_hash_1234567890123456",
    is_youtube: false,
    sent_headers: new Headers({ referer: "https://example.com/watch" }),
    initiator: new URL("https://example.com/watch"),
    master_url: new URL("https://cdn.example.com/master.m3u8"),
    playlist: [
      {
        demuxer: "mp4",
        quality: { size: { height: 1080, width: 1920 }, bitrate: 4_000_000 },
        av: { video: new URL("https://cdn.example.com/1080.m3u8"), audio: false },
        audio_language: "en",
      },
    ],
    duration: 93.5,
    has_drm: false,
    discovery_timestamp_ms: 1_700_000_000_000,
    cache: "default",
  };
  const meta: TabMeta = {
    incognito: false,
    tab_id: 7,
    title: "Example movie",
    thumbnail_url: new URL("https://example.com/thumb.jpg"),
    favicon_url: new URL("https://example.com/favicon.ico"),
    url: new URL("https://example.com/watch"),
    default_action: "download",
    smartnaming_rule: {
      template: "%title",
      selector: null,
      max_length: 64,
      replace: [{ from: /\bfoo\b/gi, to: "bar" }],
      subdir: "",
      force_doc_title: false,
    },
  };
  const download_args: DownloadPlan = {
    download_id: "download_1f2e3d4c",
    headers: new Headers({ referer: "https://example.com/watch" }),
    good_basename: "Example movie",
    subdir: "",
    save_as: false,
    will_use_jsfetch: false,
    strategy: TransferStrategy.HlsAudioVideoOneSource,
    url: new URL("https://cdn.example.com/master.m3u8"),
    carry_get_params: true,
    extension: "mp4",
    muxer: "mp4",
    is_youtube: false,
    throttle: false,
    cache: "default",
  };
  return { download_args, meta, media };
};

describe("channel contract (E8: the nine-value enum)", () => {
  it("keeps the shipped channel-1 command names (22 proven), exact spelling", () => {
    expect(Object.values(MSG.contentToService)).toEqual([
      "do_download",
      "abort_download",
      "request_preview",
      "rm_notification",
      "rm_notifications_all",
      "tos_accepted",
      "set_default_action",
      "dismiss_banner",
      "dismiss_media",
      "rm_download",
      "retry_download",
      "update_media_preferred_entry",
      "clear-history",
      "clear-completed",
      "mut-settings",
      "show-review-page",
      "rm-custom-strings",
      "update-custom-web-string",
      "update-custom-addon-string",
      "reset-suspicious-saveas",
      "update-smartnaming",
      "redock",
    ]);
  });

  it("keeps the injected->service names (channel 0)", () => {
    expect(Object.values(MSG.injectedToService)).toEqual([
      "on_media",
      "remove_media",
      "on_activate_addon",
      "qjs",
      "do_fetch_from_service",
    ]);
  });

  it("keeps the service->content pushes (channel 6): only preview + ping carry data", () => {
    expect(Object.values(MSG.serviceToContent)).toEqual([
      "on_preview_available",
      "on_no_preview",
      "ping",
    ]);
  });

  it("keeps the service->injected names (channel 7)", () => {
    expect(Object.values(MSG.serviceToInjected)).toEqual([
      "on_activate_addon_success",
      "on_activate_addon_failure",
      "qjs_result",
      "on_fetch_from_service",
      "on_fetch_from_service_failed",
      "vimeo_on_config",
      "iqyi_on_config",
    ]);
  });

  it("keeps the worker bus names (BroadcastChannel worker_service)", () => {
    expect(Object.values(MSG.worker)).toEqual([
      "is_ready",
      "is_ready_success",
      "download",
      "download_progress",
      "download_result",
      "download_error",
      "abort_download",
      "revoke_blob_url",
    ]);
  });

  it("keeps the per-page isolated<->main bridge names (channels 5/4)", () => {
    expect(Object.values(MSG.pageBridge)).toEqual([
      "youtube_request_visitor_data",
      "youtube_on_visitor_data",
      "vimeo_request_config",
      "vimeo_on_config",
      "iq_request_config",
      "iq_on_config",
      "iqyi_on_config",
      "bilibili_com_request_id",
      "bilibili_com_on_id",
      "bilibili_tv_request_config",
      "bilibili_tv_on_config",
      "javrank_request_manifest",
      "javrank_on_manifest",
    ]);
  });

  it("pins the 19 mut-settings keys in shipped if-chain order (E22/§3.7)", () => {
    expect(SETTINGS_MUTATION_KEYS).toHaveLength(19);
    expect(SETTINGS_MUTATION_KEYS).toEqual([
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
    ]);
  });
});

describe("envelope shape (E13: {msg:{name,data}, channel} exactly)", () => {
  it("builds exactly two outer keys and two body keys, in stable order", () => {
    const envelope = makeEnvelope(
      MSG.contentToService.MutSettings,
      { ui_theme: "dark" },
      Channel.FromContentToService,
    );
    expect(Object.keys(envelope)).toEqual(["msg", "channel"]);
    expect(Object.keys(envelope.msg)).toEqual(["name", "data"]);
    expect(envelope.msg).toEqual({ name: "mut-settings", data: { ui_theme: "dark" } });
    expect(envelope.channel).toBe(Channel.FromContentToService);
  });

  it("does not add fields beyond the wire contract", () => {
    const envelope = makeEnvelope(MSG.serviceToContent.Ping, null, Channel.FromServiceToContent);
    expect(JSON.parse(JSON.stringify(envelope))).toEqual({
      msg: { name: "ping", data: null },
      channel: 6,
    });
  });
});

describe("direction guards (E9-E12/E16/E17)", () => {
  const at = (channel: number): MessageEnvelope => makeEnvelope("x", null, channel as never);

  it("routes each channel to exactly one guard", () => {
    const content = at(Channel.FromContentToService);
    const injected = at(Channel.FromInjectedToService);
    const toContent = at(Channel.FromServiceToContent);
    const toInjected = at(Channel.FromServiceToInjected);
    const bridge4 = at(Channel.FromUntrustedInjectedToTrusted);
    const bridge5 = at(Channel.FromTrustedInjectedToUntrusted);
    const workerTo = at(Channel.FromServiceToWorker);
    const workerFrom = at(Channel.FromWorkerToService);
    const reserved = at(Channel.FromServiceToService);

    expect([isContentToService(content), isInjectedToService(content)]).toEqual([true, false]);
    expect([isInjectedToService(injected), isContentToService(injected)]).toEqual([true, false]);
    expect([isServiceToContent(toContent), isServiceToInjected(toContent)]).toEqual([true, false]);
    expect([isServiceToInjected(toInjected), isServiceToContent(toInjected)]).toEqual([true, false]);
    expect(isPageBridge(bridge4) && isPageBridge(bridge5)).toBe(true);
    expect(isWorkerBus(workerTo, "toWorker")).toBe(true);
    expect(isWorkerBus(workerFrom, "toService")).toBe(true);
    expect(isWorkerBus(workerTo, "toService")).toBe(false);
    // Channel 8 is reserved: no guard claims it (E8).
    expect(
      [
        isContentToService(reserved),
        isInjectedToService(reserved),
        isServiceToContent(reserved),
        isServiceToInjected(reserved),
        isPageBridge(reserved),
        isWorkerBus(reserved, "toWorker"),
        isWorkerBus(reserved, "toService"),
      ].every((value) => value === false),
    ).toBe(true);
  });

  it("typed builders pick the right channel", () => {
    expect(makeContentToServiceEnvelope(MSG.contentToService.Redock, { mode: "sidebar" }).channel).toBe(1);
    expect(makeServiceToContentEnvelope(MSG.serviceToContent.Ping, null).channel).toBe(6);
    expect(makeWorkerEnvelope(MSG.worker.IsReady, null, "toWorker").channel).toBe(2);
    expect(makeWorkerEnvelope(MSG.worker.IsReadySuccess, null, "toService").channel).toBe(3);
  });
});

describe("serde round-trip of data-bearing payloads (E13/E17/E34)", () => {
  it("round-trips a do_download payload (URLs, Headers, RegExp in smart-naming rule)", () => {
    const payload = doDownloadFixture();
    const roundTripped = structured(payload);

    expect(roundTripped).toEqual(payload);
    expect(roundTripped.download_args.url).toBeInstanceOf(URL);
    expect(roundTripped.download_args.url.href).toBe("https://cdn.example.com/master.m3u8");
    expect(roundTripped.download_args.headers).toBeInstanceOf(Headers);
    expect(roundTripped.download_args.headers.get("referer")).toBe("https://example.com/watch");
    expect(roundTripped.meta.smartnaming_rule.replace[0]?.from).toBeInstanceOf(RegExp);
    expect(roundTripped.media.master_url).toBeInstanceOf(URL);
    expect(roundTripped.media.sent_headers).toBeInstanceOf(Headers);
  });

  it("round-trips a do_download envelope and keeps the channel number", () => {
    const envelope = makeContentToServiceEnvelope(MSG.contentToService.DoDownload, doDownloadFixture());
    const roundTripped = structured(envelope);
    expect(roundTripped.channel).toBe(Channel.FromContentToService);
    expect(roundTripped.msg.name).toBe("do_download");
    expect((roundTripped.msg.data as DoDownloadPayload).meta.tab_id).toBe(7);
  });

  it("serialises worker payloads through the same tagged wire format", () => {
    const plan: WorkerDownloadPayload = { download_args: doDownloadFixture().download_args };
    const roundTrippedPlan = structured(plan);
    expect(roundTrippedPlan.download_args.strategy).toBe("m3u8_audio_video_one_source");
    expect(roundTrippedPlan.download_args.url).toBeInstanceOf(URL);

    const progress: DownloadProgressPayload = {
      download_id: plan.download_args.download_id,
      progress: {
        status: "downloading",
        percent: { is_known: true, value: 42.5 },
        fetched_bytes_count: 1024,
        output_duration_s: 3.5,
      },
    };
    expect(structured(progress)).toEqual(progress);

    const result: TransferOutcome = {
      download_id: plan.download_args.download_id,
      internal_filename: "file-123.mp4",
      internal_bloburl: "blob:chrome-extension://abc/file-123",
      ending_reason: {
        user_abort: false,
        e4XX_5XX_failure: false,
        percentage_incomplete: false,
        other_failure: false,
      },
      aborted_no_partial: false,
    };
    expect(structured(result)).toEqual(result);
  });
});
