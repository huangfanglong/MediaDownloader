import { describe, expect, it } from "vitest";
import {
  HLS_NOT_VALID,
  HLS_PARSE_ERROR,
  LIVE_WINDOW_MS,
  defaultPreviewVariant,
  durationOf,
  decodeCharacterCodedManifest,
  isSubtitleUri,
  parseAttributes,
  parsePlaylist,
  selectAudioRendition,
  selectVariant,
  sortVariants,
  videoDemuxerForCodecs,
  type HlsAudioRendition,
  type HlsSegment,
  type HlsVariant,
} from "../src/manifests/hls.js";
import {
  DRM_MEDIA_HLS,
  EMPTY_MASTER_HLS,
  HEADER_ONLY_HLS,
  HLS_MASTER_URL,
  HLS_MEDIA_URL,
  INVALID_HLS,
  LIVE_HLS,
  MASTER_HLS,
  MEDIA_HLS,
  MIXED_HLS,
  SUBTITLE_HLS,
  UNKNOWN_DURATION_HLS,
  parseMasterFixture,
  parseMediaFixture,
} from "./fixtures/manifests.js";

const variant = (
  height: number | undefined,
  bandwidth: number | undefined,
  uri = "https://cdn.example.com/segment.m3u8",
): HlsVariant => ({
  uri: new URL(uri, "https://cdn.example.com/"),
  ...(height === undefined ? {} : { resolution: { width: Math.round(height * 1.7), height } }),
  ...(bandwidth === undefined ? {} : { bandwidth }),
});

describe("parsePlaylist — validation (F9/F10)", () => {
  it.each([[INVALID_HLS], [""], ["<!doctype html><html></html>"]])(
    "rejects unparsable input %j with 'parse error'",
    (text) => {
      const result = parsePlaylist(text, HLS_MASTER_URL);
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") expect(result.reason).toBe(HLS_PARSE_ERROR);
    },
  );

  it("rejects a playlist with no variants and no segments with 'not a valid m3u8'", () => {
    const result = parsePlaylist(HEADER_ONLY_HLS, HLS_MASTER_URL);
    expect(result).toEqual({ kind: "invalid", reason: HLS_NOT_VALID });
  });

  it("rejects a master whose every variant is filtered out with 'not a valid m3u8'", () => {
    const result = parsePlaylist(EMPTY_MASTER_HLS, HLS_MASTER_URL);
    expect(result).toEqual({ kind: "invalid", reason: HLS_NOT_VALID });
  });

  it("classifies a STREAM-INF playlist as master and an EXTINF playlist as media", () => {
    expect(parsePlaylist(MASTER_HLS, HLS_MASTER_URL).kind).toBe("master");
    expect(parsePlaylist(MEDIA_HLS, HLS_MEDIA_URL).kind).toBe("media");
  });

  it("separates a subtitle-only playlist, but accepts a mixed one (F10)", () => {
    const subtitle = parsePlaylist(SUBTITLE_HLS, HLS_MEDIA_URL);
    expect(subtitle.kind).toBe("subtitle");
    if (subtitle.kind === "subtitle") expect(subtitle.segments).toHaveLength(2);
    expect(parsePlaylist(MIXED_HLS, HLS_MEDIA_URL).kind).toBe("media");
  });
});

describe("parsePlaylist — media playlist semantics (F11/F17)", () => {
  const media = parseMediaFixture();

  it("resolves segment URIs against the playlist URL", () => {
    expect(media.segments.map((segment) => segment.uri.href)).toEqual([
      "https://cdn.example.com/hls/media/seg1.m4s",
      "https://cdn.example.com/hls/media/seg2.m4s",
      "https://cdn.example.com/hls/media/seg3.m4s",
    ]);
  });

  it("sums EXTINF durations for a VOD playlist (5.5 + 6 + 4.5)", () => {
    expect(media.duration).toBe(16);
    expect(media.mediaSequence).toBe(100);
    expect(media.hasDrm).toBe(false);
  });

  it("parses EXT-X-MAP init segments (uri, byterange, active key)", () => {
    const map = media.segments[0]?.map;
    expect(map?.uri.href).toBe("https://cdn.example.com/hls/media/init.mp4");
    expect(map?.byterange).toEqual({ offset: 0, length: 720 });
    expect(map?.key?.method).toBe("AES-128");
  });

  it("parses EXT-X-BYTERANGE including the implicit offset of the next segment", () => {
    expect(media.segments[0]?.byterange).toEqual({ offset: 0, length: 1000 });
    expect(media.segments[1]?.byterange).toEqual({ offset: 1000, length: 2000 });
    expect(media.segments[2]?.byterange).toBeUndefined();
  });

  it("parses EXT-X-KEY AES-128 with URI and explicit IV", () => {
    const key = media.segments[0]?.key;
    expect(key?.method).toBe("AES-128");
    expect(key?.uri?.href).toBe("https://keys.example.com/key.bin");
    expect(key?.iv).toBe("0x0123456789abcdef0123456789abcdef");
  });

  it("parses EXT-X-PROGRAM-DATE-TIME as epoch milliseconds", () => {
    expect(media.segments[0]?.programDateTime).toBe(Date.parse("2020-01-01T00:00:00Z"));
    expect(media.segments[1]?.programDateTime).toBeUndefined();
  });

  it("marks the EXT-X-DISCONTINUITY segment", () => {
    expect(media.segments.map((segment) => segment.discontinuity)).toEqual([undefined, undefined, true]);
  });

  it("does not treat a FairPlay streamingkeydelivery key as DRM (shipped predicate keys)", () => {
    // The shipped parser stores FairPlay under `com.apple.fps.1_0`, which its DRM predicate
    // (`kv` = playready/streamingkeydelivery/widevine.alpha) does not match — verified against
    // analysis/pretty service lines 7952-7954 and 8339-8341. The worker still refuses to save
    // SAMPLE-AES ciphertext explicitly (test/parity-fixes.test.ts).
    const drm = parsePlaylist(DRM_MEDIA_HLS, HLS_MEDIA_URL);
    expect(drm.kind).toBe("media");
    if (drm.kind === "media") expect(drm.hasDrm).toBe(false);
  });
});

describe("durationOf — unknown / live / sum (F11)", () => {
  it("is 'unknown' for an empty or partially-unparsable playlist", () => {
    expect(durationOf([], 0)).toBe("unknown");
    const unknown = parsePlaylist(UNKNOWN_DURATION_HLS, HLS_MEDIA_URL);
    expect(unknown.kind).toBe("media");
    if (unknown.kind === "media") expect(unknown.duration).toBe("unknown");
  });

  it("is 'live' when the last PROGRAM-DATE-TIME is within 600 s", () => {
    const live = parsePlaylist(LIVE_HLS, HLS_MEDIA_URL);
    expect(live.kind).toBe("media");
    if (live.kind === "media") expect(live.duration).toBe("live");
  });

  it("does NOT consult EXT-X-ENDLIST (LIVE_HLS carries ENDLIST and is still live)", () => {
    expect(LIVE_HLS).toContain("#EXT-X-ENDLIST");
    const live = parsePlaylist(LIVE_HLS, HLS_MEDIA_URL);
    if (live.kind === "media") expect(live.duration).toBe("live");
  });

  it("uses the last segment's timestamp and the exact 600 s boundary", () => {
    const now = 1_700_000_000_000;
    const fresh: HlsSegment = { uri: new URL("https://cdn.example.com/seg.ts"), duration: 4, programDateTime: now - LIVE_WINDOW_MS + 1 };
    const stale: HlsSegment = { uri: new URL("https://cdn.example.com/seg.ts"), duration: 4, programDateTime: now - LIVE_WINDOW_MS };
    expect(durationOf([fresh], now)).toBe("live");
    expect(durationOf([stale], now)).toBe(4);
  });
});

describe("master playlist filter + ordering (F12/F14)", () => {
  const master = parseMasterFixture();

  it("drops PQ/HDR and unknown-codec variants, defaults missing CODECS to mp4", () => {
    expect(master.variants).toHaveLength(5);
    expect(master.variants.some((entry) => entry.videoRange === "PQ")).toBe(false);
    const noCodecs = master.variants.find((entry) => entry.bandwidth === 700_000);
    expect(noCodecs?.demuxer).toBe("mp4");
    expect(noCodecs?.resolution).toEqual({ width: 640, height: 360 });
  });

  it("sorts variants by height descending then bandwidth descending", () => {
    expect(master.variants.map((entry) => entry.resolution?.height)).toEqual([1080, 720, 720, 480, 360]);
    expect(master.variants.map((entry) => entry.bandwidth)).toEqual([5_000_000, 3_000_000, 2_000_000, 900_000, 700_000]);
  });

  it("parses EXT-X-MEDIA audio renditions with resolved URIs and default flags", () => {
    expect(master.audioRenditions).toHaveLength(2);
    const english = master.audioRenditions.find((rendition) => rendition.language === "en");
    expect(english).toMatchObject({ group: "aud", name: "English", default: true });
    expect(english?.uri?.href).toBe("https://cdn.example.com/hls/audio/en.m3u8");
    expect(master.audioRenditions.find((rendition) => rendition.language === "fr")?.default).toBe(false);
  });

  it("parses EXT-X-MEDIA subtitle renditions", () => {
    expect(master.subtitleRenditions).toHaveLength(1);
    expect(master.subtitleRenditions[0]).toMatchObject({ kind: "subtitles", language: "en" });
    expect(master.subtitleRenditions[0]?.url?.href).toBe("https://cdn.example.com/hls/subtitles/en.vtt");
  });

  it("carries the AUDIO group id on each variant", () => {
    expect(master.variants.every((entry) => entry.audioGroup === "aud")).toBe(true);
  });
});

describe("variant selection helpers (F14/F15)", () => {
  it("sortVariants orders by height then bandwidth", () => {
    const sorted = sortVariants([variant(480, 500), variant(1080, 100), variant(1080, 900)]);
    expect(sorted.map((entry) => [entry.resolution?.height, entry.bandwidth])).toEqual([
      [1080, 900],
      [1080, 100],
      [480, 500],
    ]);
  });

  it("defaultPreviewVariant prefers 480, then 260, then the last entry", () => {
    expect(defaultPreviewVariant([variant(1080, 1), variant(480, 1), variant(260, 1)])?.resolution?.height).toBe(480);
    expect(defaultPreviewVariant([variant(1080, 1), variant(260, 1)])?.resolution?.height).toBe(260);
    expect(defaultPreviewVariant([variant(1080, 1)])?.resolution?.height).toBe(1080);
    expect(defaultPreviewVariant([])).toBeUndefined();
  });

  it("selectVariant matches the height, honours demuxer priority, and falls back to index 0", () => {
    const variants = [
      { ...variant(1080, 5_000_000, "a"), demuxer: "mp4" },
      { ...variant(720, 2_000_000, "b"), demuxer: "mp4" },
      { ...variant(480, 900_000, "c"), demuxer: "mp4" },
    ];
    expect(selectVariant(variants)?.bandwidth).toBe(5_000_000);
    expect(selectVariant(variants, 720)?.bandwidth).toBe(2_000_000);
    expect(selectVariant(variants, 1440)?.bandwidth).toBe(5_000_000); // no match => index 0
    expect(selectVariant([], 720)).toBeUndefined();

    const mp4 = { ...variant(720, 1_000_000, "d"), demuxer: "mp4" };
    const webm = { ...variant(720, 3_000_000, "e"), demuxer: "webm" };
    expect(selectVariant([webm, mp4], 720)?.demuxer).toBe("mp4");
  });

  it("videoDemuxerForCodecs maps the shipped video codec table", () => {
    expect(videoDemuxerForCodecs("avc1.640028")).toBe("mp4");
    expect(videoDemuxerForCodecs("hev1.1.6")).toBe("mp4");
    expect(videoDemuxerForCodecs("mp4v.20.9")).toBe("mp4");
    expect(videoDemuxerForCodecs("av01.0.05M.08")).toBe("webm");
    expect(videoDemuxerForCodecs("vp09.00.10.08")).toBe("webm");
    expect(videoDemuxerForCodecs("theora")).toBeUndefined();
  });

  it("isSubtitleUri implements the unanchored vtt|srt|webvtt|ttml test", () => {
    expect(isSubtitleUri(new URL("https://cdn.example.com/a/en.vtt"))).toBe(true);
    expect(isSubtitleUri(new URL("https://cdn.example.com/a/en.srt"))).toBe(true);
    expect(isSubtitleUri(new URL("https://cdn.example.com/a/en.ttml"))).toBe(true);
    expect(isSubtitleUri(new URL("https://cdn.example.com/a/seg.ts"))).toBe(false);
    expect(isSubtitleUri(new URL("https://cdn.example.com/a/mywebvtts"))).toBe(true); // unanchored, like `ro`
  });
});

describe("audio rendition selection (F13)", () => {
  const rendition = (
    name: string,
    language: string | undefined,
    isDefault: boolean,
    uri: string | undefined,
  ): HlsAudioRendition => ({
    group: "aud",
    name,
    default: isDefault,
    ...(language === undefined ? {} : { language }),
    ...(uri === undefined ? {} : { uri: new URL(uri, "https://cdn.example.com/") }),
  });

  it("'original' stops at the first default rendition", () => {
    const renditions = [
      rendition("English", "en", false, "audio/en.m3u8"),
      rendition("French", "fr", true, "audio/fr.m3u8"),
      rendition("German", "de", false, "audio/de.m3u8"),
    ];
    expect(selectAudioRendition(renditions, { strategy: "original", languages: [] })?.language).toBe("fr");
  });

  it("'original' resolves to the last rendition with a URI when no default exists (shipped quirk)", () => {
    const renditions = [rendition("English", "en", false, "audio/en.m3u8"), rendition("French", "fr", false, "audio/fr.m3u8")];
    expect(selectAudioRendition(renditions, { strategy: "original", languages: [] })?.language).toBe("fr");
  });

  it("user_language tries exact matches then base-language matches", () => {
    const renditions = [rendition("English", "en", false, "audio/en.m3u8"), rendition("French", "fr", true, "audio/fr.m3u8")];
    expect(selectAudioRendition(renditions, { strategy: "user_language", languages: new Set(["fr"]) })?.language).toBe("fr");
    expect(selectAudioRendition(renditions, { strategy: "user_language", languages: new Set(["en-US"]) })?.language).toBe("en");
  });

  it("user_language falls back to the default rendition, or none", () => {
    const renditions = [rendition("English", "en", false, "audio/en.m3u8"), rendition("French", "fr", true, "audio/fr.m3u8")];
    expect(selectAudioRendition(renditions, { strategy: "user_language", languages: new Set(["de"]) })?.language).toBe("fr");
    expect(
      selectAudioRendition([rendition("English", "en", false, "audio/en.m3u8")], {
        strategy: "user_language",
        languages: new Set(["de"]),
      }),
    ).toBeUndefined();
  });
});

describe("attribute parsing (RFC 8216)", () => {
  it("handles quoted values containing commas", () => {
    expect(parseAttributes('BANDWIDTH=123,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1920x1080')).toEqual({
      BANDWIDTH: "123",
      CODECS: "avc1.4d401f,mp4a.40.2",
      RESOLUTION: "1920x1080",
    });
  });

  it("keeps empty and unquoted values", () => {
    expect(parseAttributes('URI="",METHOD=AES-128')).toEqual({ URI: "", METHOD: "AES-128" });
  });
});
