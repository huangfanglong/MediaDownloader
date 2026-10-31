import { describe, expect, it } from "vitest";
import { TransferStrategy, type MediaItem } from "../src/core/types.js";
import {
  DRM_PROTECTION_SCHEMES,
  demuxerForCodecs,
  parseIso8601Duration,
  parseMpd,
  protectionSchemeName,
} from "../src/manifests/dash.js";
import {
  buildPlan,
  buildPreviewPlan,
  chooseStrategy,
  defaultPreviewEntry,
  extensionForDemuxer,
  isAudioOnlyDemuxer,
  selectPlaylistEntry,
  selectSubtitleTrack,
} from "../src/plan/index.js";
import {
  HLS_MEDIA_URL,
  HLS_MASTER_URL,
  HTTP_URL,
  MPD_CLEARKEY_XML,
  MPD_DRM_XML,
  MPD_URL,
  MPD_XML,
  fixedIdFactory,
  hlsAudioOnlyMasterItem,
  hlsMasterItem,
  hlsMediaItem,
  httpMediaItem,
  mpdMediaItem,
  tabMeta,
} from "./fixtures/manifests.js";

const baseInput = (media: MediaItem, overrides: Partial<Parameters<typeof buildPlan>[0]> = {}) => ({
  media,
  meta: tabMeta(),
  audioOnly: false,
  preferredAudioStrategy: "original" as const,
  preferredAudioLanguages: new Set<string>(["en"]),
  preferredAvMuxer: "mp4" as const,
  downloadDirectory: "Downloads/",
  downloadIdFactory: fixedIdFactory(),
  ...overrides,
});

const expectOk = <T>(result: { tag: "Ok"; value: T } | { tag: "Err"; error: unknown }): T => {
  if (result.tag !== "Ok") throw new Error(`expected Ok, got Err: ${String(result.error)}`);
  return result.value;
};

// ---------------------------------------------------------------------------
// DASH parser (F25/F26/F28)
// ---------------------------------------------------------------------------

describe("parseIso8601Duration", () => {
  it.each([
    ["PT1M30S", 90],
    ["PT2H", 7200],
    ["P1DT2H", 93_600],
    ["PT0S", 0],
    ["PT1.5S", 1.5],
  ])("parses %s as %s seconds", (input, expected) => {
    expect(parseIso8601Duration(input)).toBe(expected);
  });

  it("returns undefined for invalid durations", () => {
    expect(parseIso8601Duration("90")).toBeUndefined();
    expect(parseIso8601Duration("PT")).toBeUndefined();
  });
});

describe("parseMpd — manifest resolution", () => {
  const manifest = expectOk(parseMpd(MPD_XML, MPD_URL));

  it("reads mediaPresentationDuration", () => {
    expect(manifest.duration).toBe(90);
    expect(manifest.hasDrm).toBe(false);
  });

  it("resolves video representations and sorts them by height (index keeps document order)", () => {
    expect(manifest.video.map((entry) => entry.height)).toEqual([1080, 720]);
    expect(manifest.video.map((entry) => entry.index)).toEqual([1, 0]);
    expect(manifest.video[0]?.codecs).toBe("avc1.640028");
    expect(manifest.video[0]?.demuxer).toBe("mp4");
    expect(manifest.video[0]?.bandwidth).toBe(4_000_000);
  });

  it("resolves BaseURL inheritance down to the representation", () => {
    expect(manifest.video[1]?.url.href).toBe("https://cdn.example.com/vod/period0/video/720/");
    expect(manifest.video[0]?.url.href).toBe("https://cdn.example.com/vod/period0/video/");
  });

  it("resolves audio representations with language, demuxer and index", () => {
    expect(manifest.audio.map((entry) => entry.language)).toEqual(["en", "fr"]);
    expect(manifest.audio.map((entry) => entry.demuxer)).toEqual(["m4a", "m4a"]);
    expect(manifest.audio.map((entry) => entry.index)).toEqual([0, 1]);
  });

  it("attaches the default audio representation id to video entries (F25)", () => {
    expect(manifest.video.map((entry) => entry.audioId)).toEqual(["a-en", "a-en"]);
  });

  it("returns in-manifest subtitles as id tracks (F28)", () => {
    expect(manifest.subtitles).toEqual([{ language: "en", type: "id", id: "sub-en", languageName: "en" }]);
  });

  it("marks Widevine/PlayReady ContentProtection as DRM, but not clear-key", () => {
    expect(expectOk(parseMpd(MPD_DRM_XML, MPD_URL)).hasDrm).toBe(true);
    expect(expectOk(parseMpd(MPD_CLEARKEY_XML, MPD_URL)).hasDrm).toBe(false);
  });

  it("returns typed errors for unsupported/invalid documents", () => {
    const notMpd = parseMpd("<notmpd/>", MPD_URL);
    expect(notMpd.tag).toBe("Err");
    if (notMpd.tag === "Err") expect(notMpd.error.kind).toBe("invalid_xml");

    const noPeriod = parseMpd('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>', MPD_URL);
    expect(noPeriod.tag).toBe("Err");
    if (noPeriod.tag === "Err") expect(noPeriod.error.kind).toBe("invalid_manifest");

    const noCodecs = parseMpd(
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet contentType="video"><Representation id="x" bandwidth="1"/></AdaptationSet></Period></MPD>',
      MPD_URL,
    );
    expect(noCodecs.tag).toBe("Err");
    if (noCodecs.tag === "Err") expect(noCodecs.error.kind).toBe("unsupported");
  });

  it("mapping tables: codec→demuxer and protection scheme→name", () => {
    expect(demuxerForCodecs("avc1.640028")).toBe("mp4");
    expect(demuxerForCodecs("mp4a.40.2")).toBe("m4a");
    expect(demuxerForCodecs("opus")).toBe("ogg");
    expect(demuxerForCodecs("theora")).toBeUndefined();
    expect(protectionSchemeName("urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")).toBe("com.widevine.alpha");
    expect(protectionSchemeName("urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95")).toBe(
      "com.microsoft.playready",
    );
    expect(DRM_PROTECTION_SCHEMES.has("com.apple.streamingkeydelivery")).toBe(true);
    expect(DRM_PROTECTION_SCHEMES.has("org.w3.clearkey")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strategy matrix (§3.2)
// ---------------------------------------------------------------------------

describe("chooseStrategy — §3.2 matrix (table-driven)", () => {
  const silentMaster = (): MediaItem => ({
    ...hlsMasterItem(),
    playlist: [{ demuxer: "mp4", quality: { size: { height: 720 } }, av: { video: HLS_MASTER_URL, audio: false } }],
  });
  const audioDemuxerMedia = (): MediaItem => ({ ...hlsMediaItem(), demuxer: "m4a" });

  const rows: Array<[string, () => MediaItem, { audioOnly: boolean }, TransferStrategy, string]> = [
    [
      "HLS master with a separate audio rendition => two sources",
      hlsMasterItem,
      { audioOnly: false },
      TransferStrategy.HlsAudioVideoTwoSources,
      "https://cdn.example.com/hls/v1080.m3u8",
    ],
    [
      "HLS master with no audio rendition => one source",
      silentMaster,
      { audioOnly: false },
      TransferStrategy.HlsAudioVideoOneSource,
      HLS_MASTER_URL.href,
    ],
    [
      "audio-only master rendition => audio only",
      hlsAudioOnlyMasterItem,
      { audioOnly: false },
      TransferStrategy.HlsAudioOnly,
      "https://cdn.example.com/hls/audio/en.m3u8",
    ],
    [
      "HLS master + audioOnly request => audio only",
      hlsMasterItem,
      { audioOnly: true },
      TransferStrategy.HlsAudioOnly,
      "https://cdn.example.com/hls/audio/en.m3u8",
    ],
    [
      "HLS media playlist => one source",
      hlsMediaItem,
      { audioOnly: false },
      TransferStrategy.HlsAudioVideoOneSource,
      HLS_MEDIA_URL.href,
    ],
    [
      "HLS media playlist + audioOnly request => audio only",
      hlsMediaItem,
      { audioOnly: true },
      TransferStrategy.HlsAudioOnly,
      HLS_MEDIA_URL.href,
    ],
    [
      "HLS media playlist with an audio-only demuxer => audio only",
      audioDemuxerMedia,
      { audioOnly: false },
      TransferStrategy.HlsAudioOnly,
      HLS_MEDIA_URL.href,
    ],
  ];

  it.each(rows)("%s", (_name, makeItem, options, strategy, url) => {
    const choice = expectOk(chooseStrategy(makeItem(), options));
    expect(choice.strategy).toBe(strategy);
    expect(choice.url.href).toBe(url);
  });

  it("HLS master with a separate audio rendition also carries url_audio", () => {
    const choice = expectOk(chooseStrategy(hlsMasterItem(), { audioOnly: false }));
    expect(choice.url_audio?.href).toBe("https://cdn.example.com/hls/audio/en.m3u8");
  });

  it("preferredQuality selects the rendition by height (F15)", () => {
    const choice = expectOk(chooseStrategy(hlsMasterItem(), { audioOnly: false, preferredQuality: 720 }));
    expect(choice.url.href).toBe("https://cdn.example.com/hls/v720hi.m3u8");
  });

  it("preferred_entry wins over the height match (F15)", () => {
    const withPreferred: MediaItem = { ...hlsMasterItem(), preferred_entry: 1 };
    const selected = selectPlaylistEntry(withPreferred, 1080);
    expect(selected?.index).toBe(1);
    expect(selected?.entry.quality.size?.height).toBe(720);
  });

  it("MPD => mpd_audio_video_one_source with the representation index (F22)", () => {
    const mpd = mpdMediaItem();
    const choice = expectOk(chooseStrategy(mpd, { audioOnly: false }));
    expect(choice.strategy).toBe(TransferStrategy.DashAudioVideoOneSource);
    expect(choice.url.href).toBe(MPD_URL.href);
    expect(choice.entry).toBe(1); // first sorted entry is the 1080p representation (document index 1)
    expect(expectOk(chooseStrategy(mpd, { audioOnly: true })).strategy).toBe(TransferStrategy.DashAudioOnly);
  });

  it("rejects media types outside the strategy contract", () => {
    const result = chooseStrategy(httpMediaItem(), { audioOnly: false });
    expect(result.tag).toBe("Err");
  });
});

// ---------------------------------------------------------------------------
// Full plan shapes (a-d)
// ---------------------------------------------------------------------------

describe("buildPlan — (a) HLS master with separate audio", () => {
  it("produces the complete two-source plan", () => {
    const media = hlsMasterItem();
    const plan = expectOk(buildPlan(baseInput(media, { preferredQuality: 720 })));
    expect(plan).toMatchObject({
      download_id: "download_test-id",
      strategy: TransferStrategy.HlsAudioVideoTwoSources,
      url: new URL("https://cdn.example.com/hls/v720hi.m3u8"),
      url_audio: new URL("https://cdn.example.com/hls/audio/en.m3u8"),
      extension: "mp4",
      muxer: "mp4",
      will_use_jsfetch: true, // F7: HLS defaults to the libav js-fetch path
      carry_get_params: false,
      duration: 120,
      good_basename: "Example Video",
      subdir: "Downloads/",
      save_as: false,
      is_youtube: false,
      throttle: false,
      cache: "default",
      audio_language: "en",
    });
    expect(plan.headers.get("cookie")).toBe("session=abc");
    expect(plan.headers.get("referer")).toBe("https://example.com/watch");
  });

  it("maps the container through preferredAvMuxer (F24)", () => {
    const plan = expectOk(buildPlan(baseInput(hlsMasterItem(), { preferredAvMuxer: "mkv" })));
    expect(plan.extension).toBe("mkv");
    expect(plan.muxer).toBe("mkv");
  });

  it("attaches a subtitle track only when the user has subtitle languages (F16)", () => {
    const without = expectOk(buildPlan(baseInput(hlsMasterItem())));
    expect(without.subtitles).toBeUndefined();
    const withSubtitles = expectOk(
      buildPlan(baseInput(hlsMasterItem(), { subtitleLanguages: new Set(["en"]) })),
    );
    expect(withSubtitles.subtitles).toEqual({
      language: "en",
      type: "http",
      url: new URL("https://cdn.example.com/hls/subtitles/en.vtt"),
    });
  });

  it("derives will_use_jsfetch from the site's carry_get_params flag (F7)", () => {
    expect(expectOk(buildPlan(baseInput(hlsMasterItem(), { carryGetParams: true }))).will_use_jsfetch).toBe(false);
  });

  it("clones the captured headers instead of sharing them (F36/F38)", () => {
    const media = hlsMasterItem();
    const plan = expectOk(buildPlan(baseInput(media)));
    media.sent_headers.delete("cookie");
    expect(plan.headers.get("cookie")).toBe("session=abc");
  });

  it("uses the rendered smart-naming subdirectory", () => {
    const plan = expectOk(buildPlan(baseInput(hlsMasterItem(), { meta: tabMeta({ ruleSubdir: "Clips/" }) })));
    expect(plan.good_basename).toBe("Example Video");
    expect(plan.subdir).toBe("Downloads/Clips/");
  });

  it("repairs a reserved device name in the rendered basename", () => {
    const plan = expectOk(buildPlan(baseInput({ ...hlsMediaItem(), title: "CON" })));
    expect(plan.good_basename).toBe("_CON");
  });

  it("normalises configured and rendered download directories", () => {
    const meta = { ...tabMeta(), smartnaming_rule: { ...tabMeta().smartnaming_rule, subdir: "" } };
    const configured = expectOk(
      buildPlan(baseInput(hlsMediaItem(), { downloadDirectory: "CON/foo./", meta })),
    );
    expect(configured.subdir).toBe("_CON/foo/");
    const rendered = expectOk(
      buildPlan(baseInput(hlsMediaItem(), { meta: tabMeta({ ruleSubdir: "CON/" }) })),
    );
    expect(rendered.subdir).toBe("Downloads/_CON/");
  });
});

describe("buildPlan — (b) HLS media-only playlist", () => {
  it("produces a single-source HLS plan with the summed duration", () => {
    const plan = expectOk(buildPlan(baseInput(hlsMediaItem())));
    expect(plan).toMatchObject({
      strategy: TransferStrategy.HlsAudioVideoOneSource,
      url: HLS_MEDIA_URL,
      will_use_jsfetch: true,
      duration: 16,
      extension: "mp4",
      muxer: "mp4",
    });
    expect(plan.url_audio).toBeUndefined();
    expect(plan.entry).toBeUndefined();
    expect(plan.audio_language).toBeUndefined();
  });

  it("audio-only request produces an mp3 plan", () => {
    const plan = expectOk(buildPlan(baseInput(hlsMediaItem(), { audioOnly: true })));
    expect(plan.strategy).toBe(TransferStrategy.HlsAudioOnly);
    expect(plan.extension).toBe("mp3");
    expect(plan.muxer).toBe("mp3");
  });
});

describe("buildPlan — (c) MPD audio+video", () => {
  const input = (overrides: Partial<Parameters<typeof buildPlan>[0]> = {}) =>
    baseInput(mpdMediaItem(), {
      preferredAvMuxer: "mkv",
      ...overrides,
    });

  it("produces a dash plan pointing at the master URL with entry + audio metadata", () => {
    const plan = expectOk(buildPlan(input()));
    expect(plan).toMatchObject({
      strategy: TransferStrategy.DashAudioVideoOneSource,
      url: MPD_URL,
      entry: 1,
      extension: "mkv",
      muxer: "mkv",
      will_use_jsfetch: true,
      duration: 90,
      audio_track_id: "a-en",
      audio_language: "en",
    });
    expect(plan.url_audio).toBeUndefined();
  });

  it("audio-only request produces mpd_audio_only", () => {
    const plan = expectOk(buildPlan(input({ audioOnly: true })));
    expect(plan.strategy).toBe(TransferStrategy.DashAudioOnly);
    expect(plan.entry).toBe(1);
    expect(plan.extension).toBe("mp3");
    expect(plan.muxer).toBe("mp3");
  });
});

describe("buildPlan — adaptive fMP4 pair (YouTube regression)", () => {
  it("routes a WebM video with AAC audio through MKV so both streams are copied", () => {
    const base = httpMediaItem({ withAudio: true, byteRanges: true });
    const media: typeof base = {
      ...base,
      libav_demuxer: "webm",
      extension: "webm",
      playlist: [
        {
          ...base.playlist![0]!,
          demuxer: "webm",
          av: {
            video: base.playlist![0]!.av!.video as URL,
            audio: new URL("https://cdn.example.com/files/movie-audio.m4a"),
          },
        },
      ],
    };
    const plan = expectOk(buildPlan(baseInput(media)));
    expect(plan.strategy).toBe(TransferStrategy.HttpAudioVideoTwoSourcesJsFetch);
    expect(plan.extension).toBe("mkv");
    expect(plan.muxer).toBe("mkv");
  });

  it("keeps a video-only WebM rendition as WebM", () => {
    const base = httpMediaItem({ byteRanges: true });
    const media: typeof base = {
      ...base,
      libav_demuxer: "webm",
      extension: "webm",
      playlist: [{ ...base.playlist![0]!, demuxer: "webm", av: { video: base.playlist![0]!.av!.video as URL, audio: false } }],
    };
    const plan = expectOk(buildPlan(baseInput(media)));
    expect(plan.extension).toBe("webm");
  });

  it("builds a two-source jsfetch plan for a video+audio adaptive pair", () => {
    const media = httpMediaItem({ withAudio: true, byteRanges: true });
    const plan = expectOk(buildPlan(baseInput(media)));
    expect(plan.strategy).toBe(TransferStrategy.HttpAudioVideoTwoSourcesJsFetch);
    expect(plan.url).toEqual(HTTP_URL);
    expect(plan.url_audio).toBeInstanceOf(URL);
    expect(plan.will_use_jsfetch).toBe(true);
  });
});

describe("buildPlan — (d) direct HTTP item", () => {
  it("progressive single request: no byte ranges => plain one-source plan", () => {
    const plan = expectOk(buildPlan(baseInput(httpMediaItem())));
    expect(plan).toMatchObject({
      strategy: TransferStrategy.HttpAudioVideoOneSource,
      url: HTTP_URL,
      will_use_jsfetch: false,
      extension: "mp4",
      muxer: "mp4",
      size: 12_345_678,
    });
    expect(plan.duration).toBeUndefined();
  });

  it("byte-range-capable container => js-fetch plan (also with a second audio source)", () => {
    const single = expectOk(buildPlan(baseInput(httpMediaItem({ byteRanges: true }))));
    expect(single.strategy).toBe(TransferStrategy.HttpAudioVideoOneSourceJsFetch);
    expect(single.will_use_jsfetch).toBe(true);
    const dual = expectOk(buildPlan(baseInput(httpMediaItem({ byteRanges: true, withAudio: true }))));
    expect(dual.strategy).toBe(TransferStrategy.HttpAudioVideoTwoSourcesJsFetch);
    expect(dual.url_audio).toEqual(new URL("https://cdn.example.com/files/movie-audio.mp4"));
    expect(dual.duration).toBe("unknown");
  });

  it("audio-only request => strip-audio js-fetch plan", () => {
    const plan = expectOk(buildPlan(baseInput(httpMediaItem(), { audioOnly: true })));
    expect(plan.strategy).toBe(TransferStrategy.HttpStripAudioJsFetch);
    expect(plan.extension).toBe("mp3");
    expect(plan.will_use_jsfetch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Preview plans (F23)
// ---------------------------------------------------------------------------

describe("buildPreviewPlan", () => {
  const settings = { downloadDirectory: "Downloads/", downloadIdFactory: fixedIdFactory("download_preview") };

  it("HLS master preview uses the 480p rendition and a literal 'unused' basename", () => {
    const plan = expectOk(buildPreviewPlan(hlsMasterItem(), settings));
    expect(plan.strategy).toBe(TransferStrategy.HlsVideoPreview);
    expect(plan.url.href).toBe("https://cdn.example.com/hls/v480.m3u8");
    expect(plan.good_basename).toBe("unused");
    expect(plan.subdir).toBe("Downloads/");
    expect(plan.will_use_jsfetch).toBe(true);
    expect(plan.duration).toBe(120);
    expect(plan.extension).toBe("mp4");
  });

  it("HLS preview respects carry_get_params", () => {
    const plan = expectOk(buildPreviewPlan(hlsMasterItem(), { ...settings, carryGetParams: true }));
    expect(plan.will_use_jsfetch).toBe(false);
  });

  it("normalises a configured download directory Chrome would refuse", () => {
    const plan = expectOk(buildPreviewPlan(hlsMasterItem(), { ...settings, downloadDirectory: "CON/" }));
    expect(plan.subdir).toBe("_CON/");
  });

  it("MPD preview points at the master URL with the default rendition entry", () => {
    const plan = expectOk(buildPreviewPlan(mpdMediaItem(), settings));
    expect(plan.strategy).toBe(TransferStrategy.DashVideoPreview);
    expect(plan.url).toBe(MPD_URL);
    // No 480/260 rendition in the fixture, so Qn falls back to the last (lowest) entry: 720p, index 0.
    expect(plan.entry).toBe(0);
    expect(plan.extension).toBe("mp4");
    expect(plan.will_use_jsfetch).toBe(true);
  });

  it("HTTP preview uses the js-fetch strategy", () => {
    const plan = expectOk(buildPreviewPlan(httpMediaItem(), settings));
    expect(plan.strategy).toBe(TransferStrategy.HttpVideoPreview);
    expect(plan.will_use_jsfetch).toBe(true);
  });

  it("defaultPreviewEntry falls back to the last (lowest) rendition", () => {
    const media = hlsMasterItem();
    const withoutDefaultHeights: MediaItem = {
      ...media,
      playlist: media.playlist?.map((entry) => ({ ...entry, quality: {} })),
    };
    expect(defaultPreviewEntry(withoutDefaultHeights)?.index).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Small exported helpers
// ---------------------------------------------------------------------------

describe("plan helpers", () => {
  it("extensionForDemuxer mirrors the shipped it/fv mapping", () => {
    expect(extensionForDemuxer("mp4", "mp4")).toBe("mp4");
    expect(extensionForDemuxer("mp4", "mkv")).toBe("mkv");
    expect(extensionForDemuxer("webm", "mp4")).toBe("mkv");
    expect(extensionForDemuxer("mkv", "mp4")).toBe("mkv");
  });

  it("isAudioOnlyDemuxer covers the shipped audio set", () => {
    expect(["mp3", "m4a", "ogg"].every((demuxer) => isAudioOnlyDemuxer(demuxer))).toBe(true);
    expect(isAudioOnlyDemuxer("mp4")).toBe(false);
    expect(isAudioOnlyDemuxer(undefined)).toBe(false);
  });

  it("selectSubtitleTrack matches exact then base languages, and needs a user language set", () => {
    const tracks = [
      { language: "fr", type: "http" as const, url: new URL("https://cdn.example.com/fr.vtt") },
      { language: "en", type: "http" as const, url: new URL("https://cdn.example.com/en.vtt") },
    ];
    expect(selectSubtitleTrack(tracks, new Set(["en"]))?.language).toBe("en");
    expect(selectSubtitleTrack(tracks, new Set(["fr-CA"]))?.language).toBe("fr");
    expect(selectSubtitleTrack(tracks, new Set(["de"]))).toBeUndefined();
    expect(selectSubtitleTrack(tracks, undefined)).toBeUndefined();
  });

  it("buildPlan rejects an item type it cannot resolve", () => {
    const item = { ...hlsMediaItem(), type: "youtube_format" as const, playlist: [] };
    const result = buildPlan(baseInput(item));
    expect(result.tag).toBe("Err");
  });
});

describe("buildPlan — preferred quality entry (QoL)", () => {
  it("uses the requested playlist entry and defaults to the best one", () => {
    const media = httpMediaItem();
    media.playlist = [
      {
        demuxer: "mp4",
        quality: { size: { height: 1080, width: 1920 }, bitrate: 4_000_000 },
        av: { video: new URL("https://cdn.example.com/v1080.mp4"), audio: false },
      },
      {
        demuxer: "mp4",
        quality: { size: { height: 720, width: 1280 }, bitrate: 2_000_000 },
        av: { video: new URL("https://cdn.example.com/v720.mp4"), audio: false },
      },
    ];
    const chosen = expectOk(buildPlan(baseInput(media, { preferredEntry: 1 })));
    expect(chosen.url.href).toBe("https://cdn.example.com/v720.mp4");
    const fallback = expectOk(buildPlan(baseInput(media)));
    expect(fallback.url.href).toBe("https://cdn.example.com/v1080.mp4");
  });

  it("uses the requested entry for HLS master playlists too", () => {
    const media = hlsMasterItem();
    const chosen = expectOk(buildPlan(baseInput(media, { preferredEntry: 1 })));
    expect(chosen.url.href).toBe("https://cdn.example.com/hls/v720hi.m3u8");
  });

  it("uses the requested entry for YouTube-shaped items too", () => {
    const media: MediaItem = {
      ...httpMediaItem(),
      type: "youtube_format",
      is_youtube: true,
      playlist: [
        {
          demuxer: "mp4",
          quality: { size: { height: 1080, width: 1920 } },
          av: { video: new URL("https://cdn.example.com/yt1080.mp4"), audio: false },
        },
        {
          demuxer: "mp4",
          quality: { size: { height: 720, width: 1280 } },
          av: { video: new URL("https://cdn.example.com/yt720.mp4"), audio: false },
        },
      ],
    };
    const chosen = expectOk(buildPlan(baseInput(media, { preferredEntry: 1 })));
    expect(chosen.url.href).toBe("https://cdn.example.com/yt720.mp4");
  });
});
