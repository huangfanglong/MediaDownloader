import { describe, expect, it } from "vitest";
import {
  AUDIO_CODEC_DEMUXER_ROWS,
  AUDIO_EXTENSIONS,
  CODEC_DEMUXER_ROWS,
  VIDEO_EXTENSIONS,
  codecToDemuxer,
} from "../src/discovery/classify.js";
import { blobMimeType } from "../src/transfer/remux.js";

// ===========================================================================
// Codec tables — owned by discovery/classify.ts (E24: gv/hv)
// ===========================================================================

describe("codec → demuxer table (gv/hv)", () => {
  it("has the six video rows in the recovered order", () => {
    expect(CODEC_DEMUXER_ROWS.map((row) => [row.codec, row.demuxer])).toEqual([
      ["H264", "mp4"],
      ["H265", "mp4"],
      ["MP4V", "mp4"],
      ["AV1", "webm"],
      ["VP8", "webm"],
      ["VP9", "webm"],
    ]);
  });

  it("has the four audio rows in the recovered order", () => {
    expect(
      AUDIO_CODEC_DEMUXER_ROWS.map((row) => [row.codec, row.demuxer]),
    ).toEqual([
      ["AAC", "m4a"],
      ["MP3", "mp3"],
      ["Opus", "ogg"],
      ["Vorbis", "ogg"],
    ]);
  });

  it("matches codec strings case-insensitively with first-match semantics", () => {
    expect(codecToDemuxer("avc1.42E01E")).toBe("mp4");
    expect(codecToDemuxer("avc3.42E01E")).toBe("mp4");
    expect(codecToDemuxer("hvc1.1.6.L93.B0")).toBe("mp4");
    expect(codecToDemuxer("hev1.1.6.L93.B0")).toBe("mp4");
    expect(codecToDemuxer("H265")).toBe("mp4");
    expect(codecToDemuxer("mp4v.20.9")).toBe("mp4");
    expect(codecToDemuxer("av01.0.05M.08")).toBe("webm");
    expect(codecToDemuxer("AV1")).toBe("webm");
    expect(codecToDemuxer("vp09.00.10.08")).toBe("webm");
    expect(codecToDemuxer("vp8")).toBe("webm");
    expect(codecToDemuxer("mp4a.40.2")).toBe("m4a");
    expect(codecToDemuxer("aac")).toBe("m4a");
    expect(codecToDemuxer("mp3")).toBe("mp3");
    expect(codecToDemuxer("mp4a.69")).toBe("mp3");
    expect(codecToDemuxer("opus")).toBe("ogg");
    expect(codecToDemuxer("mp4a.ad")).toBe("ogg");
    expect(codecToDemuxer("vorbis")).toBe("ogg");
    expect(codecToDemuxer("danmaku")).toBeUndefined();
  });

  it("uses the shared extension lists (Nm/Rm)", () => {
    expect([...VIDEO_EXTENSIONS]).toEqual(["mp4", "webm", "mkv"]);
    expect([...AUDIO_EXTENSIONS]).toEqual(["mp3", "m4a", "ogg"]);
  });
});

describe("staged-output MIME types", () => {
  it("provides explicit blob MIME types for media outputs", () => {
    expect(blobMimeType("mkv")).toBe("video/x-matroska");
    expect(blobMimeType("flv")).toBe("video/x-flv");
    expect(blobMimeType("mp4")).toBe("video/mp4");
    expect(blobMimeType("m2ts")).toBe("video/mp2t");
    expect(blobMimeType("unknown")).toBe("application/octet-stream");
  });
});
