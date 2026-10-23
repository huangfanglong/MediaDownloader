import { describe, expect, it, vi } from "vitest";
import { muxFragmentedMp4, readBoxes } from "../src/transfer/mux-fmp4.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import type { DownloadPlan } from "../src/core/types.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import { createFakeOpfs, createFetch, createRangedFetch } from "./helpers/transfer-fakes.js";

const encoder = new TextEncoder();

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...encoder.encode(type), ...payload];
}

function fullBox(type: string, version: number, flags: number): number[] {
  return box(type, [(version << 24) | flags, 0, 0, 0]);
}

/** A minimal fragmented-MP4 track: ftyp + moov(mvhd, trak(tkhd), mvex(trex)) + fragments. */
function fragmentedTrack(trackId: number, fragmentTimes: number[]): Uint8Array {
  const ftyp = box("ftyp", [...encoder.encode("iso5"), ...u32(512), ...encoder.encode("iso5"), ...encoder.encode("mp41")]);
  const mvhd = box("mvhd", [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(1000), ...u32(0), ...u32(0), 0, 1, 0, 0, ...new Array(10).fill(0), ...new Array(36).fill(0), ...new Array(24).fill(0), ...u32(3)]);
  const tkhd = box("tkhd", [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(trackId), ...new Array(68).fill(0)]);
  const trak = box("trak", [...tkhd]);
  const trex = box("trex", [0, 0, 0, 0, ...u32(trackId), ...u32(1), ...u32(0), ...u32(0), ...u32(0)]);
  const mvex = box("mvex", [...trex]);
  const moov = box("moov", [...mvhd, ...trak, ...mvex]);
  const parts: number[] = [...ftyp, ...moov];
  fragmentTimes.forEach((time, index) => {
    const mfhd = box("mfhd", [0, 0, 0, 0, ...u32(index + 1)]);
    const tfhd = box("tfhd", [0, 0, 0, 0, ...u32(trackId), ...u32(1)]);
    const tfdt = box("tfdt", [0, 0, 0, 0, ...u32(time)]);
    const traf = box("traf", [...tfhd, ...tfdt]);
    const moof = box("moof", [...mfhd, ...traf]);
    const mdat = box("mdat", [...new Array(256).fill(index + 7)]);
    parts.push(...moof, ...mdat);
  });
  return new Uint8Array(parts);
}

describe("fMP4 audio+video muxer", () => {
  it("merges two fragmented tracks into one moov with two traks and patched fragments", () => {
    const video = fragmentedTrack(1, [0, 1000, 2000]);
    const audio = fragmentedTrack(1, [0, 1024, 2048]);
    const muxed = muxFragmentedMp4(video, audio);
    expect(muxed).toBeDefined();
    if (!muxed) return;
    const boxes = readBoxes(muxed);
    expect(boxes[0]?.type).toBe("ftyp");
    expect(boxes[1]?.type).toBe("moov");
    const moovChildren = readBoxes(muxed, boxes[1]?.payloadStart, boxes[1]?.end);
    expect(moovChildren.filter((child) => child.type === "trak")).toHaveLength(2);
    const mvex = moovChildren.find((child) => child.type === "mvex");
    expect(mvex).toBeDefined();
    if (mvex) expect(readBoxes(muxed, mvex.payloadStart, mvex.end).filter((child) => child.type === "trex")).toHaveLength(2);
    const moofs = boxes.filter((box) => box.type === "moof");
    expect(moofs).toHaveLength(6);
    const tkhdIds = moovChildren
      .filter((child) => child.type === "trak")
      .map((trak) => {
        const tkhd = readBoxes(muxed, trak.payloadStart, trak.end).find((child) => child.type === "tkhd");
        if (!tkhd) return undefined;
        const version = muxed[tkhd.payloadStart];
        return new DataView(muxed.buffer, muxed.byteOffset + tkhd.payloadStart + (version === 1 ? 20 : 12), 4).getUint32(0);
      });
    expect(tkhdIds).toEqual([1, 2]);
    const trackIds = moofs.map((moof) => {
      const mfhd = readBoxes(muxed, moof.payloadStart, moof.end).find((child) => child.type === "mfhd");
      const seq = mfhd
        ? ((muxed[mfhd.payloadStart + 4] ?? 0) << 24) |
          ((muxed[mfhd.payloadStart + 5] ?? 0) << 16) |
          ((muxed[mfhd.payloadStart + 6] ?? 0) << 8) |
          (muxed[mfhd.payloadStart + 7] ?? 0)
        : undefined;
      return seq;
    });
    expect(trackIds).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("returns undefined for non-fragmented inputs", () => {
    expect(muxFragmentedMp4(new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]), new Uint8Array(0))).toBeUndefined();
  });
});

describe("worker direct two-source muxing", () => {
  it("downloads the adaptive video and audio tracks and stages one muxed file", async () => {
    const video = fragmentedTrack(1, [0, 1000, 2000]);
    const audio = fragmentedTrack(1, [0, 1024, 2048]);
    const videoUrl = `https://rr1---sn-x.googlevideo.com/videoplayback?itag=137&clen=${video.byteLength}`;
    const audioUrl = `https://rr1---sn-x.googlevideo.com/videoplayback?itag=140&clen=${audio.byteLength}`;
    const payloads = new Map<string, Uint8Array>([
      [videoUrl, video],
      [audioUrl, audio],
    ]);
    const { root, files } = createFakeOpfs();
    const workerChannel: BroadcastChannelLike = {
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      close: () => undefined,
    };
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:muxed");
    const worker = new DownloadWorker({
      channel: workerChannel,
      fetchImpl: createRangedFetch(payloads),
      openRoot: async () => root,
    });
    const plan: DownloadPlan = {
      download_id: "download_two_source",
      headers: new Headers(),
      good_basename: "two-source",
      subdir: "",
      save_as: false,
      will_use_jsfetch: true,
      strategy: "http_audio_video_two_sources_jsfetch",
      url: new URL(videoUrl),
      url_audio: new URL(audioUrl),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: true,
      throttle: false,
      cache: "default",
    };
    const result = await worker.runPlan(plan);
    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    const expected = muxFragmentedMp4(video, audio);
    expect(expected).toBeDefined();
    const staged = [...(files.get(`download_two_source.mp4`) ?? [])];
    const total = staged.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(total).toBe(expected?.byteLength);
  });
});

/** Fake ffmpeg runner: records jobs and returns a large deterministic output. */
function fakeFfmpeg() {
  const jobs: Array<{ args: string[]; outputName: string; inputs: Array<{ name: string; bytes: Uint8Array }> }> = [];
  return {
    jobs,
    runner: {
      run: async (job: { args: string[]; outputName: string; inputs: Array<{ name: string; bytes: Uint8Array }> }) => {
        jobs.push(job);
        return new Uint8Array(2048).fill(9);
      },
    },
  };
}

describe("worker ffmpeg outputs", () => {
  it("merges adaptive tracks into MKV through the injected ffmpeg runner", async () => {
    const video = fragmentedTrack(1, [0, 1000, 2000]);
    const audio = fragmentedTrack(1, [0, 1024, 2048]);
    const videoUrl = `https://rr1---sn-x.googlevideo.com/videoplayback?itag=137&clen=${video.byteLength}`;
    const audioUrl = `https://rr1---sn-x.googlevideo.com/videoplayback?itag=140&clen=${audio.byteLength}`;
    const payloads = new Map<string, Uint8Array>([
      [videoUrl, video],
      [audioUrl, audio],
    ]);
    const { root, files } = createFakeOpfs();
    const ffmpeg = fakeFfmpeg();
    const worker = new DownloadWorker({
      channel: {
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      } as unknown as BroadcastChannelLike,
      fetchImpl: createRangedFetch(payloads),
      openRoot: async () => root,
      ffmpeg: ffmpeg.runner,
    });
    const plan: DownloadPlan = {
      download_id: "download_mkv",
      headers: new Headers(),
      good_basename: "mkv",
      subdir: "",
      save_as: false,
      will_use_jsfetch: true,
      strategy: "http_audio_video_two_sources_jsfetch",
      url: new URL(videoUrl),
      url_audio: new URL(audioUrl),
      carry_get_params: false,
      extension: "mkv",
      muxer: "mkv",
      source_demuxer: "mp4",
      is_youtube: true,
      throttle: false,
      cache: "default",
    };
    const result = await worker.runPlan(plan);
    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    if (result.tag === "Ok") expect(result.value.output_extension).toBe("mkv");
    expect(ffmpeg.jobs).toHaveLength(1);
    expect(ffmpeg.jobs[0]?.outputName).toBe("out.mkv");
    expect(ffmpeg.jobs[0]?.args).toContain("-c");
    const staged = [...(files.get("download_mkv.mkv") ?? [])];
    expect(staged.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(2048);
  });

  it("extracts MP3 from the audio track only", async () => {
    const audio = fragmentedTrack(1, [0, 1024, 2048]);
    const videoUrl = `https://rr1---sn-x.googlevideo.com/videoplayback?itag=137&clen=999`;
    const audioUrl = `https://rr1---sn-x.googlevideo.com/videoplayback?itag=140&clen=${audio.byteLength}`;
    const payloads = new Map<string, Uint8Array>([[audioUrl, audio]]);
    const { root, files } = createFakeOpfs();
    const ffmpeg = fakeFfmpeg();
    const worker = new DownloadWorker({
      channel: {
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      } as unknown as BroadcastChannelLike,
      fetchImpl: createRangedFetch(payloads),
      openRoot: async () => root,
      ffmpeg: ffmpeg.runner,
    });
    const plan: DownloadPlan = {
      download_id: "download_mp3",
      headers: new Headers(),
      good_basename: "mp3",
      subdir: "",
      save_as: false,
      will_use_jsfetch: true,
      strategy: "http_audio_video_two_sources_jsfetch",
      url: new URL(videoUrl),
      url_audio: new URL(audioUrl),
      carry_get_params: false,
      extension: "mp3",
      muxer: "mp3",
      source_demuxer: "mp4",
      is_youtube: true,
      throttle: false,
      cache: "default",
    };
    const result = await worker.runPlan(plan);
    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    expect(ffmpeg.jobs).toHaveLength(1);
    expect(ffmpeg.jobs[0]?.args).toContain("libmp3lame");
    expect([...(files.get("download_mp3.mp3") ?? [])].reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(2048);
  });
});

describe("single-source FFmpeg conversion", () => {
  it("converts a fetched MP4 to MP3 when the requested format differs from the source", async () => {
    const source = new Uint8Array(4096).fill(7);
    const { root, files } = createFakeOpfs();
    const ffmpeg = fakeFfmpeg();
    const worker = new DownloadWorker({
      channel: {
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      } as unknown as BroadcastChannelLike,
      fetchImpl: (async () => new Response(source)) as never,
      openRoot: async () => root,
      ffmpeg: ffmpeg.runner,
    });
    const plan: DownloadPlan = {
      download_id: "download_convert",
      headers: new Headers(),
      good_basename: "convert",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "http_audio_video_one_source",
      url: new URL("https://cdn.test/clip.mp4"),
      carry_get_params: false,
      extension: "mp3",
      muxer: "mp3",
      source_demuxer: "mp4",
      output_format: "mp3",
      is_youtube: false,
      throttle: false,
      cache: "default",
    };
    const result = await worker.runPlan(plan);
    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    if (result.tag === "Ok") expect(result.value.output_extension).toBe("mp3");
    expect(ffmpeg.jobs).toHaveLength(1);
    expect(ffmpeg.jobs[0]?.args).toContain("libmp3lame");
    const staged = [...(files.get("download_convert.mp3") ?? [])];
    expect(staged.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(2048);
  });
});

describe("HLS TS remux", () => {
  it("remuxes a staged stream and removes the temporary file", async () => {
    const manifest = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n0.ts\n#EXTINF:4,\n1.ts\n#EXT-X-ENDLIST\n";
    const payloads = new Map<string, Uint8Array>([
      ["https://cdn.test/media.m3u8", encoder.encode(manifest)],
      ["https://cdn.test/0.ts", new Uint8Array(600).fill(1)],
      ["https://cdn.test/1.ts", new Uint8Array(600).fill(2)],
    ]);
    const fetchImpl = createFetch(payloads);
    const { root, files } = createFakeOpfs();
    const ffmpeg = fakeFfmpeg();
    const worker = new DownloadWorker({
      channel: {
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      } as unknown as BroadcastChannelLike,
      fetchImpl,
      openRoot: async () => root,
      ffmpeg: ffmpeg.runner,
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:temp").mockReturnValueOnce("blob:final");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const plan = {
      download_id: "download_hls_remux",
      headers: new Headers(),
      good_basename: "hls",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "m3u8_audio_video_one_source",
      url: new URL("https://cdn.test/media.m3u8"),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    } as DownloadPlan;

    const result = await worker.runPlan(plan);

    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.output_extension).toBe("mp4");
      expect(result.value.internal_bloburl).toBe("blob:final");
    }
    expect(ffmpeg.jobs[0]?.inputs[0]?.bytes.byteLength).toBe(1200);
    expect(files.has("download_hls_remux.m2ts")).toBe(false);
    expect(files.has("download_hls_remux.mp4")).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:temp");
  });
});

describe("webm copy merge", () => {
  it("stream-copies VP9/Opus tracks into WebM without transcoding", async () => {
    const video = fragmentedTrack(1, [0, 1000, 2000]);
    const audio = fragmentedTrack(1, [0, 1024, 2048]);
    const videoUrl = `https://rr1---sn-x.googlevideo.com/videoplayback?itag=248&clen=${video.byteLength}`;
    const audioUrl = `https://rr1---sn-x.googlevideo.com/videoplayback?itag=251&clen=${audio.byteLength}`;
    const payloads = new Map<string, Uint8Array>([[videoUrl, video], [audioUrl, audio]]);
    const { root, files } = createFakeOpfs();
    const ffmpeg = fakeFfmpeg();
    const worker = new DownloadWorker({
      channel: {
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      } as unknown as BroadcastChannelLike,
      fetchImpl: createRangedFetch(payloads),
      openRoot: async () => root,
      ffmpeg: ffmpeg.runner,
    });
    const plan: DownloadPlan = {
      download_id: "download_webm",
      headers: new Headers(),
      good_basename: "webm",
      subdir: "",
      save_as: false,
      will_use_jsfetch: true,
      strategy: "http_audio_video_two_sources_jsfetch",
      url: new URL(videoUrl),
      url_audio: new URL(audioUrl),
      carry_get_params: false,
      extension: "webm",
      muxer: "webm",
      source_demuxer: "webm",
      is_youtube: true,
      throttle: false,
      cache: "default",
    };
    const result = await worker.runPlan(plan);
    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    if (result.tag === "Ok") expect(result.value.output_extension).toBe("webm");
    expect(ffmpeg.jobs[0]?.args).toContain("copy");
    expect(ffmpeg.jobs[0]?.args).not.toContain("libvpx");
  });
});
