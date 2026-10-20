/**
 * Authored manifest fixtures + discovery-shape builders for the resolution tests.
 *
 * No fixture data ships in the original bundle (grep for `#EXTM3U` outside the vendored parser
 * only finds site-specific injected scripts), so these playlists are authored to exercise each
 * proven rule from analysis/evidence/03-manifest-resolution.md. The HLS/DASH expectations are
 * documented inline next to each fixture.
 */
import type { MediaItem, PlaylistEntry, SubtitleTrack, TabMeta } from "../../src/core/types.js";
import { parseMpd } from "../../src/manifests/dash.js";
import { parsePlaylist, selectAudioRendition, type HlsResult } from "../../src/manifests/hls.js";
import { defaultSmartnaming, materializeRule, selectRule } from "../../src/naming/rules.js";

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export const HLS_MASTER_URL = new URL("https://cdn.example.com/hls/master.m3u8");
export const HLS_MEDIA_URL = new URL("https://cdn.example.com/hls/media/index.m3u8");
export const MPD_URL = new URL("https://cdn.example.com/vod/manifest.mpd");
export const HTTP_URL = new URL("https://cdn.example.com/files/movie.mp4");

export function capturedHeaders(): Headers {
  return new Headers([
    ["referer", "https://example.com/watch"],
    ["cookie", "session=abc"],
    ["x-token", "token-123"],
    ["user-agent", "FixtureAgent/1.0"],
  ]);
}

// ---------------------------------------------------------------------------
// HLS fixtures
// ---------------------------------------------------------------------------

/**
 * Master playlist (F12-F16):
 * - 1080p / 720p@3M / 720p@2M / 480p variants with an AUDIO group (`en` default, `fr`),
 * - a PQ (HDR) variant that must be skipped,
 * - an unknown-codec variant that must be skipped,
 * - a variant without CODECS that must default to demuxer mp4,
 * - an English subtitle rendition.
 * Expected (after filter + sort): 1080, 720@3M, 720@2M, 480, 360@700k(no codecs).
 */
export const MASTER_HLS = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="French",LANGUAGE="fr",DEFAULT=NO,URI="audio/fr.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subtitles/en.vtt"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
v1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
v720hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
v720lo.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
v480.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L153.B0",VIDEO-RANGE=PQ,AUDIO="aud"
v2160hdr.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="theora",AUDIO="aud"
v360weird.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,AUDIO="aud"
v360.mp4
`;

/** Media playlist (F9/F11/F17): durations sum to 16 s, AES-128 key, EXT-X-MAP, BYTERANGE. */
export const MEDIA_HLS = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/key.bin",IV=0x0123456789abcdef0123456789abcdef
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXT-X-PROGRAM-DATE-TIME:2020-01-01T00:00:00Z
#EXT-X-BYTERANGE:1000@0
#EXTINF:5.5,
seg1.m4s
#EXT-X-BYTERANGE:2000
#EXTINF:6,
seg2.m4s
#EXT-X-DISCONTINUITY
#EXTINF:4.5,
seg3.m4s
#EXT-X-ENDLIST
`;

/** Subtitle-only playlist (F10): every segment URI is a subtitle resource. */
export const SUBTITLE_HLS = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10,
subtitles/en.vtt
#EXTINF:10,
subtitles/en2.vtt
`;

/** Mixed playlist: a video segment means it is NOT a subtitle-only playlist. */
export const MIXED_HLS = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10,
seg1.ts
#EXTINF:10,
subtitles/en.vtt
`;

/** Live classification fixture (F11): future PROGRAM-DATE-TIME, ENDLIST deliberately present. */
export const LIVE_HLS = `#EXTM3U
#EXT-X-PROGRAM-DATE-TIME:2030-01-01T00:00:00Z
#EXTINF:4,
seg.ts
#EXT-X-ENDLIST
`;

/** Missing/unparsable #EXTINF duration => duration "unknown" (F11). */
export const UNKNOWN_DURATION_HLS = `#EXTM3U
#EXTINF:abc,
seg.ts
`;

/** DRM media playlist: FairPlay key format must mark `hasDrm` (F37/F45). */
export const DRM_MEDIA_HLS = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fairplay-key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6,
seg1.ts
`;

/** Master playlist whose only variant is filtered out => invalid "not a valid m3u8". */
export const EMPTY_MASTER_HLS = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="theora"
v360weird.m3u8
`;

export const INVALID_HLS = "this is not a playlist at all";
export const HEADER_ONLY_HLS = "#EXTM3U\n#EXT-X-VERSION:3\n";

export function parseMasterFixture(text: string = MASTER_HLS): Extract<HlsResult, { kind: "master" }> {
  const parsed = parsePlaylist(text, HLS_MASTER_URL);
  if (parsed.kind !== "master") throw new Error(`fixture is not a master playlist: ${parsed.kind}`);
  return parsed;
}

export function parseMediaFixture(text: string = MEDIA_HLS): Extract<HlsResult, { kind: "media" }> {
  const parsed = parsePlaylist(text, HLS_MEDIA_URL);
  if (parsed.kind !== "media") throw new Error(`fixture is not a media playlist: ${parsed.kind}`);
  return parsed;
}

// ---------------------------------------------------------------------------
// Discovery-shape builders (what the discovery module emits from a parsed manifest)
// ---------------------------------------------------------------------------

function defaultBase(overrides: Partial<MediaItem> & Pick<MediaItem, "type">): MediaItem {
  return {
    hash: "media_hash_1",
    is_youtube: false,
    sent_headers: capturedHeaders(),
    discovery_timestamp_ms: 0,
    cache: "default",
    ...overrides,
  } as MediaItem;
}

/** Convert a parsed HLS master to the `m3u8_playlist` MediaItem discovery would emit. */
export function hlsMasterItem(text: string = MASTER_HLS): MediaItem {
  const master = parseMasterFixture(text);
  const playlist: PlaylistEntry[] = master.variants.map((variant) => {
    const group = variant.audioGroup;
    const renditions =
      group === undefined ? [] : master.audioRenditions.filter((rendition) => rendition.group === group);
    const audioRendition = selectAudioRendition(renditions, { strategy: "original", languages: [] });
    const quality = {
      ...(variant.resolution === undefined
        ? {}
        : { size: { height: variant.resolution.height, width: variant.resolution.width } }),
      ...(variant.bandwidth === undefined ? {} : { bitrate: variant.bandwidth }),
    };
    return {
      demuxer: variant.demuxer ?? "mp4",
      quality,
      av: { video: variant.uri, audio: audioRendition?.uri ?? false },
      ...(audioRendition?.language === undefined ? {} : { audio_language: audioRendition.language }),
    };
  });
  const subtitles: SubtitleTrack[] = master.subtitleRenditions
    .filter((rendition) => rendition.url !== undefined)
    .map((rendition) => ({
      language: rendition.language ?? "und",
      type: "http" as const,
      url: rendition.url as URL,
    }));
  return defaultBase({
    type: "m3u8_playlist",
    master_url: HLS_MASTER_URL,
    playlist,
    duration: 120, // computed by discovery from the first variant's media playlist (F31)
    subtitles,
    hash: "media_hash_master",
  });
}

/** Convert a parsed HLS media playlist to the `m3u8` MediaItem discovery would emit. */
export function hlsMediaItem(text: string = MEDIA_HLS): MediaItem {
  const media = parseMediaFixture(text);
  return defaultBase({
    type: "m3u8",
    url: HLS_MEDIA_URL,
    demuxer: "mp4",
    duration: media.duration,
    hash: "media_hash_media",
  });
}

/** An HLS master item whose only rendition is audio (video track absent). */
export function hlsAudioOnlyMasterItem(): MediaItem {
  return defaultBase({
    type: "m3u8_playlist",
    master_url: HLS_MASTER_URL,
    playlist: [
      {
        demuxer: "mp3",
        quality: {},
        av: { video: false, audio: new URL("https://cdn.example.com/hls/audio/en.m3u8") },
        audio_language: "en",
      },
    ],
    duration: 120,
    hash: "media_hash_audio_master",
  });
}

// ---------------------------------------------------------------------------
// DASH fixtures
// ---------------------------------------------------------------------------

/**
 * MPD fixture (F25/F28): the document lists 720p before 1080p to prove the parser sorts entries
 * (height desc) while keeping the document ordinal in `index`. Audio has `en` (128k) and `fr`
 * (96k) renditions; subtitles are TTML (stpp).
 */
export const MPD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1M30S" minBufferTime="PT2S">
  <BaseURL>https://cdn.example.com/vod/</BaseURL>
  <Period id="0" duration="PT1M30S">
    <BaseURL>period0/</BaseURL>
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4">
      <BaseURL>video/</BaseURL>
      <Representation id="v720" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f">
        <BaseURL>720/</BaseURL>
      </Representation>
      <Representation id="v1080" bandwidth="4000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" lang="en">
      <BaseURL>audio/en/</BaseURL>
      <Representation id="a-en" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet id="3" contentType="audio" mimeType="audio/mp4" lang="fr">
      <Representation id="a-fr" bandwidth="96000" codecs="mp4a.40.2"/>
    </AdaptationSet>
    <AdaptationSet id="4" contentType="text" mimeType="application/ttml+xml" lang="en">
      <Representation id="sub-en" codecs="stpp"/>
    </AdaptationSet>
  </Period>
</MPD>
`;

/** Same shape with Widevine + PlayReady ContentProtection on the video adaptation. */
export const MPD_DRM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <Period id="0">
    <AdaptationSet id="1" contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="cenc"/>
      <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95" value="MSPR 2.0"/>
      <Representation id="v0" bandwidth="1000000" width="1280" height="720" codecs="avc1.64001f"/>
    </AdaptationSet>
    <AdaptationSet id="2" contentType="audio" mimeType="audio/mp4" lang="en">
      <Representation id="a0" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>
`;

/** clear-key only: the shipped `kv` set does not treat it as DRM (F25/F37). */
export const MPD_CLEARKEY_XML = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT5S">
  <Period id="0">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b" value="cenc"/>
      <Representation id="v0" bandwidth="1000" width="640" height="360" codecs="avc1.42e01e"/>
    </AdaptationSet>
  </Period>
</MPD>
`;

/** Convert a parsed MPD to the `mpd_playlist` MediaItem discovery would emit. */
export function mpdMediaItem(text: string = MPD_XML): MediaItem {
  const parsed = parseMpd(text, MPD_URL);
  if (parsed.tag !== "Ok") throw new Error(`MPD fixture failed to parse: ${parsed.error.message}`);
  const manifest = parsed.value;
  const playlist: PlaylistEntry[] = manifest.video.map((entry) => {
    const audio = manifest.audio.find((candidate) => candidate.id === entry.audioId);
    return {
      demuxer: entry.demuxer,
      quality: {
        ...(entry.height === undefined
          ? {}
          : { size: { height: entry.height, ...(entry.width === undefined ? {} : { width: entry.width }) } }),
        ...(entry.bandwidth === undefined ? {} : { bitrate: entry.bandwidth }),
      },
      index: entry.index,
      ...(entry.audioId === undefined ? {} : { audio_id: entry.audioId }),
      ...(audio?.language === undefined ? {} : { audio_language: audio.language }),
    };
  });
  return defaultBase({
    type: "mpd_playlist",
    master_url: MPD_URL,
    playlist,
    duration: manifest.duration,
    has_drm: manifest.hasDrm,
    hash: "media_hash_mpd",
  });
}

// ---------------------------------------------------------------------------
// Progressive HTTP fixtures
// ---------------------------------------------------------------------------

export function httpMediaItem(options: { withAudio?: boolean; byteRanges?: boolean } = {}): MediaItem {
  const video = HTTP_URL;
  const audio = options.withAudio === true ? new URL("https://cdn.example.com/files/movie-audio.mp4") : false;
  return defaultBase({
    type: "http_playlist",
    url: HTTP_URL,
    libav_demuxer: "mp4",
    extension: "mp4",
    supports_byte_ranges: options.byteRanges === true,
    duration: "unknown",
    playlist: [
      {
        demuxer: "mp4",
        quality: {},
        size: 12_345_678,
        av: { video, audio },
      },
    ],
    hash: "media_hash_http",
  });
}

// ---------------------------------------------------------------------------
// Tab metadata / naming
// ---------------------------------------------------------------------------

export interface TabMetaOptions {
  /** Rule subdirectory (joined with the download directory by materializeRule). */
  ruleSubdir?: string;
  template?: string;
}

export function tabMeta(options: TabMetaOptions = {}): TabMeta {
  const selected = selectRule(defaultSmartnaming(), undefined);
  const rule = materializeRule(
    {
      ...selected,
      template: options.template ?? selected.template,
      subdir: options.ruleSubdir ?? "",
    },
    null,
    "Downloads/",
  );
  return {
    incognito: false,
    tab_id: 7,
    title: "Example Video",
    url: new URL("https://example.com/watch"),
    default_action: "download",
    smartnaming_rule: rule,
  };
}

/** Deterministic id factory: the builder must call it exactly once per plan. */
export function fixedIdFactory(value = "download_test-id"): () => string {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? value : `${value}-${calls}`;
  };
}
