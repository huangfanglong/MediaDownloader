import { describe, expect, it } from "vitest";
import {
  AUDIO_CODEC_DEMUXER_ROWS,
  AUDIO_EXTENSIONS,
  BLOCKED_INITIATOR_HOSTS,
  CODEC_DEMUXER_ROWS,
  KNOWN_MEDIA_FILE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  MIME_DEMUXER_ROWS,
  SEGMENT_PATH_PATTERN,
  VIDEO_EXTENSIONS,
  codecToDemuxer,
  containerToMuxer,
  extensionFromUrl,
  isAudioExtension,
  isBlockedInitiatorHost,
  isMediaExtension,
  isVideoExtension,
  mimeToDemuxer,
  resolveMediaDescriptor,
  tryUrl,
  videoCodecToDemuxer,
  audioCodecToDemuxer,
} from "../src/discovery/classify.js";
import {
  DASH_CONTENT_TYPE_PATTERN,
  DASH_URL_PATTERN,
  EXTENSION_INITIATOR_PATTERN,
  FIFO_DISCOVERED_ITEM_CAP,
  HLS_CONTENT_TYPE_PATTERN,
  HLS_MASTER_API_PATTERN,
  HLS_URL_PATTERN,
  INITIATOR_SUPPRESSION_THRESHOLD_BYTES,
  MPD_EXTENSION_PATTERN,
  SAME_TYPE_ITEM_CAP,
  SEND_HEADERS_TTL_MS,
  SMALL_FILE_THRESHOLD_BYTES,
} from "../src/discovery/engine.js";
import {
  FIXTURE_AUDIO_CODEC_ROWS,
  FIXTURE_AUDIO_EXTENSIONS,
  FIXTURE_BLOCKED_INITIATOR_HOSTS,
  FIXTURE_DESCRIPTORS,
  FIXTURE_FIFO_DISCOVERED_ITEM_CAP,
  FIXTURE_INITIATOR_SUPPRESSION_THRESHOLD_BYTES,
  FIXTURE_KNOWN_MEDIA_FILE_EXTENSIONS,
  FIXTURE_MEDIA_EXTENSIONS,
  FIXTURE_MIME_DEMUXER_ROWS,
  FIXTURE_REGEXES,
  FIXTURE_SAME_TYPE_ITEM_CAP,
  FIXTURE_SEND_HEADERS_TTL_MS,
  FIXTURE_SMALL_FILE_THRESHOLD_BYTES,
  FIXTURE_VIDEO_CODEC_ROWS,
  FIXTURE_VIDEO_EXTENSIONS,
} from "./fixtures/detection.js";

const flattenMimeRows = (): unknown =>
  MIME_DEMUXER_ROWS.map((row) => ({ source: row.regex.source, flags: row.regex.flags, audio: row.audio, video: row.video }));

const flattenCodecRows = (rows: readonly { mime_regex: RegExp; demuxer: string; codec: string }[]) =>
  rows.map((row) => ({ source: row.mime_regex.source, flags: row.mime_regex.flags, demuxer: row.demuxer, codec: row.codec }));

describe("classification tables are verbatim recoveries", () => {
  it("exposes Nm/Rm/Ms extension lists (D18)", () => {
    expect([...VIDEO_EXTENSIONS]).toEqual([...FIXTURE_VIDEO_EXTENSIONS]);
    expect([...AUDIO_EXTENSIONS]).toEqual([...FIXTURE_AUDIO_EXTENSIONS]);
    expect([...MEDIA_EXTENSIONS]).toEqual([...FIXTURE_MEDIA_EXTENSIONS]);
  });

  it("exposes the 53-entry known-media-extension set (D19)", () => {
    expect([...KNOWN_MEDIA_FILE_EXTENSIONS]).toEqual([...FIXTURE_KNOWN_MEDIA_FILE_EXTENSIONS]);
    expect(KNOWN_MEDIA_FILE_EXTENSIONS).toHaveLength(53);
  });

  it("exposes the 17-row MIME → demuxer table (D20)", () => {
    expect(MIME_DEMUXER_ROWS).toHaveLength(17);
    expect(flattenMimeRows()).toEqual(FIXTURE_MIME_DEMUXER_ROWS);
  });

  it("exposes the gv/hv codec tables (D21)", () => {
    expect(flattenCodecRows(CODEC_DEMUXER_ROWS)).toEqual(FIXTURE_VIDEO_CODEC_ROWS);
    expect(flattenCodecRows(AUDIO_CODEC_DEMUXER_ROWS)).toEqual(FIXTURE_AUDIO_CODEC_ROWS);
    expect(CODEC_DEMUXER_ROWS).toHaveLength(6);
    expect(AUDIO_CODEC_DEMUXER_ROWS).toHaveLength(4);
  });

  it("exposes the 11-entry blocked-initiator set (D25)", () => {
    expect([...BLOCKED_INITIATOR_HOSTS]).toEqual([...FIXTURE_BLOCKED_INITIATOR_HOSTS]);
  });

  it("exposes the exact dispatch regexes and thresholds (D6/D9/D10/D17/D30)", () => {
    expect([SEGMENT_PATH_PATTERN.source, SEGMENT_PATH_PATTERN.flags]).toEqual(FIXTURE_REGEXES.segmentPath);
    expect([HLS_CONTENT_TYPE_PATTERN.source, HLS_CONTENT_TYPE_PATTERN.flags]).toEqual(FIXTURE_REGEXES.hlsContentType);
    expect([HLS_URL_PATTERN.source, HLS_URL_PATTERN.flags]).toEqual(FIXTURE_REGEXES.hlsUrl);
    expect([HLS_MASTER_API_PATTERN.source, HLS_MASTER_API_PATTERN.flags]).toEqual(FIXTURE_REGEXES.hlsMasterApi);
    expect([DASH_CONTENT_TYPE_PATTERN.source, DASH_CONTENT_TYPE_PATTERN.flags]).toEqual(FIXTURE_REGEXES.dashContentType);
    expect([DASH_URL_PATTERN.source, DASH_URL_PATTERN.flags]).toEqual(FIXTURE_REGEXES.dashUrl);
    expect([MPD_EXTENSION_PATTERN.source, MPD_EXTENSION_PATTERN.flags]).toEqual(FIXTURE_REGEXES.mpdConversion);
    expect([EXTENSION_INITIATOR_PATTERN.source, EXTENSION_INITIATOR_PATTERN.flags]).toEqual(FIXTURE_REGEXES.extensionInitiator);
    expect(SEND_HEADERS_TTL_MS).toBe(FIXTURE_SEND_HEADERS_TTL_MS);
    expect(SMALL_FILE_THRESHOLD_BYTES).toBe(FIXTURE_SMALL_FILE_THRESHOLD_BYTES);
    expect(INITIATOR_SUPPRESSION_THRESHOLD_BYTES).toBe(FIXTURE_INITIATOR_SUPPRESSION_THRESHOLD_BYTES);
    expect(SAME_TYPE_ITEM_CAP).toBe(FIXTURE_SAME_TYPE_ITEM_CAP);
    expect(FIFO_DISCOVERED_ITEM_CAP).toBe(FIXTURE_FIFO_DISCOVERED_ITEM_CAP);
  });

  it("classifies extensions into audio/video/muxable groups (D18)", () => {
    for (const extension of FIXTURE_VIDEO_EXTENSIONS) {
      expect(isVideoExtension(extension)).toBe(true);
      expect(isAudioExtension(extension)).toBe(false);
      expect(isMediaExtension(extension)).toBe(true);
    }
    for (const extension of FIXTURE_AUDIO_EXTENSIONS) {
      expect(isVideoExtension(extension)).toBe(false);
      expect(isAudioExtension(extension)).toBe(true);
      expect(isMediaExtension(extension)).toBe(true);
    }
    expect(isMediaExtension("flv")).toBe(false);
    expect(isMediaExtension("MP4")).toBe(false);
  });

  it("normalises containers exactly like Gn/it/fv (D18)", () => {
    expect(containerToMuxer("mp4", "mp4")).toBe("mp4");
    expect(containerToMuxer("webm", "mp4")).toBe("mkv");
    expect(containerToMuxer("mkv", "mp4")).toBe("mkv");
    expect(containerToMuxer("mp3", "mp4")).toBe("mp3");
    expect(containerToMuxer("m4a", "mp4")).toBe("mp3");
    expect(containerToMuxer("ogg", "mp4")).toBe("mp3");
  });
});

describe("mimeToDemuxer (original Pf, D20)", () => {
  it.each([
    ["video/mp4", "mp4"], ["video/mp4; codecs=avc1.42E01E", "mp4"], ["audio/mp4", "mp3"],
    ["audio/mpeg", "mp3"], ["audio/ogg", "oga"], ["video/webm", "webm"], ["video/x-matroska", "mkv"],
    ["video/mp2t", "mp2t"], ["video/x-flv", "flv"], ["audio/x-m4a", "m4a"], ["application/x-mpegurl", "mpeg"],
    ["application/vnd.apple.mpegurl", "mpeg"], ["APPLICATION/X-MPEGURL", "mpeg"], ["application/octet-stream", undefined],
    ["video/quicktime", undefined], ["text/html", undefined], ["", undefined], [undefined, undefined],
  ])("maps %j to %j", (contentType, expected) => {
    expect(mimeToDemuxer(contentType)).toBe(expected);
  });
});

describe("codecToDemuxer (original Zn/Mm, D21)", () => {
  it.each([
    ["avc1.64001f", "mp4"], ["avc3.64001f", "mp4"], ["hev1.1.6", "mp4"], ["hvc1.1.6", "mp4"],
    ["h265", "mp4"], ["h.265", "mp4"], ["mp4v.20.3", "mp4"], ["av01.0.04M", "webm"], ["av1", "webm"],
    ["vp08.00", "webm"], ["vp8", "webm"], ["vp09.00", "webm"], ["vp9", "webm"], ["h264", undefined],
    ["something-else", undefined], ["", undefined],
  ])("maps video codec %j to %j", (codec, expected) => {
    expect(videoCodecToDemuxer(codec)).toBe(expected);
  });

  it.each([
    ["aac", "m4a"], ["mp4a.40.2", "m4a"], ["mp4a.40.5", "m4a"], ["mp3", "mp3"], ["mp4a.69", "mp3"],
    ["mp4a.6b", "mp3"], ["opus", "ogg"], ["mp4a.ad", "ogg"], ["vorbis", "ogg"], ["avc1", undefined], ["", undefined],
  ])("maps audio codec %j to %j", (codec, expected) => {
    expect(audioCodecToDemuxer(codec)).toBe(expected);
  });

  it("codecToDemuxer scans video rows before audio rows", () => {
    expect(codecToDemuxer("avc1")).toBe("mp4");
    expect(codecToDemuxer("aac")).toBe("m4a");
    expect(codecToDemuxer("vorbis")).toBe("ogg");
    expect(codecToDemuxer("nope")).toBeUndefined();
  });
});

describe("extensionFromUrl (original Tf over de, D22)", () => {
  it.each([
    ["https://cdn.example.com/a.MP4", "mp4"],
    ["https://cdn.example.com/path/movie.webm?token=1#frag", "webm"],
    ["https://cdn.example.com/a.tar.gz", "gz"],
    ["https://cdn.example.com/path/", undefined],
    ["https://cdn.example.com/noext", undefined],
    ["not a url", undefined],
  ])("extracts extension from %j as %j", (url, expected) => {
    expect(extensionFromUrl(url)).toBe(expected);
  });
});

describe("segment path rejection (D9 step 3)", () => {
  it.each([
    ["/segments/1.ts", true], ["/segments/1.m4s", true], ["/segments/1.m2ts", true],
    ["/segments/1.TS", true], ["/segments/1.tsx", false], ["/media/video.mp4", false],
    ["/b-hls-08/73697527_693_x_1792462825_part0.mp4", true],
    ["/b-hls-08/73697527_init_jk9NeJb8Tz5Z882F.mp4", true],
  ])("matches %j -> %j", (pathname, expected) => {
    expect(SEGMENT_PATH_PATTERN.test(pathname)).toBe(expected);
  });
});

describe("blocked initiator hosts (D25)", () => {
  it.each([
    ["www.youtube.com", true], ["youtube.com", true], ["player.vimeo.com", true], ["vimeo.com", true],
    ["sub.vkvideo.ru", true], ["intl-api.iq.com", true], ["notvimeo.com", false],
    ["vimeo.com.evil.example", false], ["example.com", false],
  ])("isBlockedInitiatorHost(%j) -> %j", (hostname, expected) => {
    expect(isBlockedInitiatorHost(hostname)).toBe(expected);
  });
});

describe("resolveMediaDescriptor (original $S, D22)", () => {
  it.each(FIXTURE_DESCRIPTORS)("$name", (fixture) => {
    const url = tryUrl(fixture.url);
    expect(url).toBeDefined();
    const descriptor = resolveMediaDescriptor(fixture.contentDisposition, fixture.contentType, url!);
    expect(descriptor).toEqual(fixture.expected);
  });
});
