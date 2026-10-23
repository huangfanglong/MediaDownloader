import { describe, expect, it } from "vitest";
import { TransferStrategy } from "../src/core/types.js";
import {
  AUDIO_CODEC_DEMUXER_ROWS,
  AUDIO_EXTENSIONS,
  AUDIO_ONLY_EXTENSION,
  AUDIO_ONLY_TRANSCODE,
  CODEC_DEMUXER_ROWS,
  DIRECT_COPY_STRATEGY,
  VIDEO_EXTENSIONS,
  blobMimeType,
  codecToDemuxer,
  decideOutput,
  isDirectCopy,
  muxerForDemuxer,
  muxerFormatName,
  shouldRemux,
  strategyNeedsRemux,
} from "../src/transfer/remux.js";

// ===========================================================================
// Codec tables — imported from discovery/classify.ts (E24: gv/hv)
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

// ===========================================================================
// Container/remux truth table (E25/E26)
// ===========================================================================

describe("decideOutput truth table", () => {
  it("audio-only always becomes an MP3 transcode", () => {
    for (const demuxer of ["mp4", "webm", "mkv", "m4a", "ogg"]) {
      const decision = decideOutput({
        demuxer,
        preferredMuxer: "mp4",
        audioOnly: true,
        willUseJsFetch: true,
      });
      expect(decision).toEqual({
        extension: AUDIO_ONLY_EXTENSION,
        muxer: "mp3",
        remux: true,
        audioTranscode: { codec: "mp3", sampleRate: 44_100, bitrateKbps: 128 },
      });
    }
    expect(AUDIO_ONLY_TRANSCODE).toEqual({
      codec: "mp3",
      sampleRate: 44_100,
      bitrateKbps: 128,
    });
  });

  it("progressive single-source strategy saves source bytes verbatim (no remux)", () => {
    const decision = decideOutput({
      demuxer: "mp4",
      preferredMuxer: "mp4",
      audioOnly: false,
      willUseJsFetch: false,
      strategy: TransferStrategy.HttpAudioVideoOneSource,
      sourceExtension: "mp4",
    });
    expect(decision).toEqual({ extension: "mp4", muxer: "mp4", remux: false });
    expect(isDirectCopy(decision)).toBe(true);
    expect(shouldRemux(decision)).toBe(false);
    expect(DIRECT_COPY_STRATEGY).toBe("http_audio_video_one_source");
  });

  it("falls back to the demuxer when the direct-copy plan has no source extension", () => {
    expect(
      decideOutput({
        demuxer: "flv",
        preferredMuxer: "mp4",
        audioOnly: false,
        willUseJsFetch: false,
        strategy: TransferStrategy.HttpAudioVideoOneSource,
      }),
    ).toEqual({ extension: "flv", muxer: "flv", remux: false });
  });

  it("mp4 source follows the preferred muxer", () => {
    const asMp4 = decideOutput({
      demuxer: "mp4",
      preferredMuxer: "mp4",
      audioOnly: false,
      willUseJsFetch: true,
    });
    const asMkv = decideOutput({
      demuxer: "mp4",
      preferredMuxer: "mkv",
      audioOnly: false,
      willUseJsFetch: true,
    });
    expect(asMp4).toEqual({ extension: "mp4", muxer: "mp4", remux: true });
    expect(asMkv).toEqual({ extension: "mkv", muxer: "mkv", remux: true });
  });

  it("webm and mkv sources always become mkv", () => {
    for (const demuxer of ["webm", "mkv"]) {
      for (const preferredMuxer of ["mp4", "mkv"] as const) {
        expect(
          decideOutput({
            demuxer,
            preferredMuxer,
            audioOnly: false,
            willUseJsFetch: true,
          }),
        ).toEqual({ extension: "mkv", muxer: "mkv", remux: true });
      }
    }
  });

  it("the jsfetch flag does not change the container decision", () => {
    const jsfetch = decideOutput({
      demuxer: "webm",
      preferredMuxer: "mp4",
      audioOnly: false,
      willUseJsFetch: true,
    });
    const native = decideOutput({
      demuxer: "webm",
      preferredMuxer: "mp4",
      audioOnly: false,
      willUseJsFetch: false,
      strategy: TransferStrategy.HlsAudioVideoOneSource,
    });
    expect(jsfetch).toEqual(native);
  });

  it("an audio demuxer without the audio-only flag still resolves to MP3", () => {
    expect(
      decideOutput({
        demuxer: "m4a",
        preferredMuxer: "mp4",
        audioOnly: false,
        willUseJsFetch: true,
      }),
    ).toMatchObject({ extension: "mp3", muxer: "mp3", remux: true });
  });

  it("rejects unknown video containers like it()'s Unreachable", () => {
    expect(() =>
      decideOutput({
        demuxer: "flv",
        preferredMuxer: "mp4",
        audioOnly: false,
        willUseJsFetch: true,
      }),
    ).toThrow("Unreachable");
  });

  it("muxerForDemuxer implements it(): mp4→preferred, webm/mkv→mkv", () => {
    expect(muxerForDemuxer("mp4", "mp4")).toBe("mp4");
    expect(muxerForDemuxer("mp4", "mkv")).toBe("mkv");
    expect(muxerForDemuxer("webm", "mp4")).toBe("mkv");
    expect(muxerForDemuxer("mkv", "mkv")).toBe("mkv");
    expect(() => muxerForDemuxer("mp3", "mp4")).toThrow("Unreachable");
  });
});

describe("remux decisions helpers", () => {
  it("muxer format name rewrites mkv to matroska", () => {
    expect(muxerFormatName("mkv")).toBe("matroska");
    expect(muxerFormatName("mp4")).toBe("mp4");
    expect(muxerFormatName("mp3")).toBe("mp3");
  });

  it("provides explicit blob MIME types for media outputs", () => {
    expect(blobMimeType("mkv")).toBe("video/x-matroska");
    expect(blobMimeType("flv")).toBe("video/x-flv");
    expect(blobMimeType("mp4")).toBe("video/mp4");
    expect(blobMimeType("m2ts")).toBe("video/mp2t");
    expect(blobMimeType("unknown")).toBe("application/octet-stream");
  });

  it("every strategy except the progressive copy needs libav", () => {
    expect(strategyNeedsRemux(TransferStrategy.HttpAudioVideoOneSource)).toBe(
      false,
    );
    for (const strategy of Object.values(TransferStrategy)) {
      if (strategy === TransferStrategy.HttpAudioVideoOneSource) continue;
      expect(strategyNeedsRemux(strategy)).toBe(true);
    }
  });
});
