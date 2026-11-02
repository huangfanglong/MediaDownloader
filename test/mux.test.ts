import { describe, expect, it, vi } from "vitest";
import { muxFragmentedMp4, muxFragmentedMp4ToSink, readBoxes } from "../src/transfer/mux-fmp4.js";
import { FfmpegInputTooLargeError } from "../src/transfer/ffmpeg.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import type { DownloadPlan } from "../src/core/types.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import { createFakeOpfs, createFetch, createRangedFetch } from "./helpers/transfer-fakes.js";
import { createStagedFile } from "../src/extension/staging.js";

const encoder = new TextEncoder();

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...encoder.encode(type), ...payload];
}

/** Box type of one muxer sink chunk (each chunk is exactly one box). */
function boxTypeOf(chunk: Uint8Array): string {
  return new TextDecoder().decode(chunk.subarray(4, 8));
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

/** Split a fragmented track into its init bytes and its `moof`+`mdat` fragments (for EXT-X-MAP). */
function splitFragmentedTrack(track: Uint8Array): { init: Uint8Array; fragments: Uint8Array[] } {
  const boxes = readBoxes(track);
  const initEnd = boxes[0]?.type === "ftyp" && boxes[1]?.type === "moov" ? (boxes[1]?.end ?? 0) : 0;
  const fragments: Uint8Array[] = [];
  for (let index = 0; index < boxes.length; index += 1) {
    const moof = boxes[index];
    if (moof?.type !== "moof") continue;
    const mdat = boxes[index + 1];
    const end = mdat?.type === "mdat" ? mdat.end : moof.end;
    fragments.push(track.slice(moof.start, end));
  }
  return { init: track.slice(0, initEnd), fragments };
}

/** `#EXT-X-MAP` fMP4 media playlist plus the URLs the case needs served. */
function fragmentedHlsPlaylist(
  prefix: string,
  init: Uint8Array,
  fragments: Uint8Array[],
): { playlist: string; entries: Array<[string, Uint8Array]> } {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:2",
    `#EXT-X-MAP:URI="${prefix}-init.mp4"`,
  ];
  const entries: Array<[string, Uint8Array]> = [[`${prefix}-init.mp4`, init]];
  fragments.forEach((fragment, index) => {
    lines.push("#EXTINF:2,");
    lines.push(`${prefix}${index}.m4s`);
    entries.push([`${prefix}${index}.m4s`, fragment]);
  });
  lines.push("#EXT-X-ENDLIST");
  return { playlist: lines.join("\n"), entries };
}

describe("fMP4 audio+video muxer", () => {
  it("merges two fragmented tracks into one moov with two traks and patched fragments", async () => {
    const video = fragmentedTrack(1, [0, 1000, 2000]);
    const audio = fragmentedTrack(1, [0, 1024, 2048]);
    const muxed = await muxFragmentedMp4(video, audio);
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

  it("returns undefined for non-fragmented inputs", async () => {
    await expect(
      muxFragmentedMp4(new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]), new Uint8Array(0)),
    ).resolves.toBeUndefined();
  });
});

describe("fMP4 muxer staging sink", () => {
  it("writes one box at a time so the merged file never has to be built in memory", async () => {
    const video = fragmentedTrack(1, [0, 1000, 2000]);
    const audio = fragmentedTrack(1, [0, 1024, 2048]);
    const expected = await muxFragmentedMp4(video, audio);
    expect(expected).toBeDefined();
    if (expected === undefined) return;

    const chunks: Uint8Array[] = [];
    const written = await muxFragmentedMp4ToSink(video, audio, {
      write: async (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(written).toBe(expected.byteLength);
    const joined = new Uint8Array(written ?? 0);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect([...joined]).toEqual([...expected]);
    // ftyp + moov + one moof and one mdat per fragment: nothing is concatenated before writing.
    const boxTypes = chunks.map((chunk) => boxTypeOf(chunk));
    expect(boxTypes[0]).toBe("ftyp");
    expect(boxTypes[1]).toBe("moov");
    expect(boxTypes.filter((type) => type === "moof")).toHaveLength(6);
    expect(boxTypes.filter((type) => type === "mdat")).toHaveLength(6);
    // Media payloads are written as views of the inputs, never copied into a new array.
    const mediaChunks = chunks.filter((chunk) => boxTypeOf(chunk) === "mdat");
    expect(mediaChunks.every((chunk) => chunk.buffer === video.buffer || chunk.buffer === audio.buffer)).toBe(true);
  });

  it("writes nothing when the inputs are not fragmented fMP4", async () => {
    const chunks: Uint8Array[] = [];
    const written = await muxFragmentedMp4ToSink(
      new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]),
      new Uint8Array(0),
      {
        write: async (chunk) => {
          chunks.push(chunk);
        },
      },
    );
    expect(written).toBeUndefined();
    expect(chunks).toHaveLength(0);
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
    const expected = await muxFragmentedMp4(video, audio);
    expect(expected).toBeDefined();
    const staged = [...(files.get(`download_two_source.mp4`) ?? [])];
    const total = staged.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(total).toBe(expected?.byteLength);
  });
});

describe("worker HLS two-source muxing without FFmpeg", () => {
  const channel = {
    postMessage: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: () => undefined,
  } as unknown as BroadcastChannelLike;

  const twoSourcePlan = (downloadId: string): DownloadPlan => ({
    download_id: downloadId,
    headers: new Headers(),
    good_basename: "hls-two",
    subdir: "",
    save_as: false,
    will_use_jsfetch: true,
    strategy: "m3u8_audio_video_two_sources",
    url: new URL("https://cdn.test/video.m3u8"),
    url_audio: new URL("https://cdn.test/audio.m3u8"),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    source_demuxer: "mp4",
    is_youtube: false,
    throttle: false,
    cache: "default",
  });

  /** Two fragmented HLS renditions and the bytes their playlists reference. */
  const fmp4Payloads = (): {
    payloads: Map<string, string | Uint8Array>;
    videoTrack: Uint8Array;
    audioTrack: Uint8Array;
  } => {
    const videoTrack = fragmentedTrack(1, [0, 1000, 2000]);
    const audioTrack = fragmentedTrack(1, [0, 1024, 2048]);
    const videoParts = splitFragmentedTrack(videoTrack);
    const audioParts = splitFragmentedTrack(audioTrack);
    const videoPlaylist = fragmentedHlsPlaylist("v", videoParts.init, videoParts.fragments);
    const audioPlaylist = fragmentedHlsPlaylist("a", audioParts.init, audioParts.fragments);
    const payloads = new Map<string, string | Uint8Array>([
      ["https://cdn.test/video.m3u8", videoPlaylist.playlist],
      ["https://cdn.test/audio.m3u8", audioPlaylist.playlist],
    ]);
    for (const [name, bytes] of [...videoPlaylist.entries, ...audioPlaylist.entries]) {
      payloads.set(`https://cdn.test/${name}`, bytes);
    }
    return { payloads, videoTrack, audioTrack };
  };

  it("muxes two fMP4 renditions straight into a staged file", async () => {
    const { payloads, videoTrack, audioTrack } = fmp4Payloads();
    const { root, files } = createFakeOpfs();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:hls-two-muxed");
    const worker = new DownloadWorker({
      channel,
      fetchImpl: createFetch(payloads),
      openRoot: async () => root,
    });

    const result = await worker.runPlan(twoSourcePlan("download_hls_two_mux"));

    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    if (result.tag === "Ok") expect(result.value.output_extension).toBe("mp4");
    const expected = await muxFragmentedMp4(videoTrack, audioTrack);
    expect(expected).toBeDefined();
    const staged = [...(files.get("download_hls_two_mux.mp4") ?? [])];
    expect(staged.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(expected?.byteLength);
  });

  it("reports a requested conversion instead of saving the muxed MP4", async () => {
    const { payloads } = fmp4Payloads();
    const { root, files } = createFakeOpfs();
    const worker = new DownloadWorker({
      channel,
      fetchImpl: createFetch(payloads),
      openRoot: async () => root,
    });
    const plan = { ...twoSourcePlan("download_hls_two_convert"), output_format: "mkv" } as DownloadPlan;

    const result = await worker.runPlan(plan);

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toMatch(/cannot convert mp4 to mkv/u);
    expect(files.has("download_hls_two_convert.mp4")).toBe(false);
  });

  it("refuses non-fragmented HLS tracks without leaving a partial file behind", async () => {
    const media = (prefix: string): string =>
      `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n${prefix}0.ts\n#EXTINF:4,\n${prefix}1.ts\n#EXT-X-ENDLIST\n`;
    const payloads = new Map<string, string | Uint8Array>([
      ["https://cdn.test/video.m3u8", media("v")],
      ["https://cdn.test/audio.m3u8", media("a")],
      ["https://cdn.test/v0.ts", new Uint8Array(600).fill(1)],
      ["https://cdn.test/v1.ts", new Uint8Array(600).fill(2)],
      ["https://cdn.test/a0.ts", new Uint8Array(600).fill(3)],
      ["https://cdn.test/a1.ts", new Uint8Array(600).fill(4)],
    ]);
    const { root, files } = createFakeOpfs();
    const worker = new DownloadWorker({
      channel,
      fetchImpl: createFetch(payloads),
      openRoot: async () => root,
    });

    const result = await worker.runPlan(twoSourcePlan("download_hls_two_bad"));

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toMatch(/not fragmented MP4/u);
    expect(files.has("download_hls_two_bad.mp4")).toBe(false);
  });
});

/** Fake ffmpeg runner: records jobs and returns a large deterministic output. */
function fakeFfmpeg() {
  const jobs: Array<{ args: string[]; outputName: string; inputs: Array<{ name: string; bytes?: Uint8Array; file?: File }> }> = [];
  return {
    jobs,
    runner: {
      run: async (job: { args: string[]; outputName: string; inputs: Array<{ name: string; bytes?: Uint8Array; file?: File }> }) => {
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
    // Root fix: both tracks are staged files mounted through WORKERFS, not byte arrays.
    expect(ffmpeg.jobs[0]?.inputs).toHaveLength(2);
    for (const input of ffmpeg.jobs[0]?.inputs ?? []) {
      expect(input.file).toBeInstanceOf(File);
      expect(input.bytes).toBeUndefined();
    }
    expect(files.has("download_mkv-video.bin")).toBe(false);
    expect(files.has("download_mkv-audio.bin")).toBe(false);
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
  it("reports audio extraction unsupported when ffmpeg is unavailable", async () => {
    const { root } = createFakeOpfs();
    const worker = new DownloadWorker({
      channel: {
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      } as unknown as BroadcastChannelLike,
      fetchImpl: (async () => {
        throw new Error("audio extraction without ffmpeg must not fetch tracks");
      }) as never,
      openRoot: async () => root,
    });
    const plan = {
      download_id: "download_mp3_no_ffmpeg",
      headers: new Headers(),
      good_basename: "mp3",
      subdir: "",
      save_as: false,
      will_use_jsfetch: true,
      strategy: "http_audio_video_two_sources_jsfetch",
      url: new URL("https://rr1---sn-x.googlevideo.com/videoplayback?itag=137"),
      url_audio: new URL("https://rr1---sn-x.googlevideo.com/videoplayback?itag=140"),
      carry_get_params: false,
      extension: "mp3",
      muxer: "mp3",
      source_demuxer: "mp4",
      is_youtube: true,
      throttle: false,
      cache: "default",
    } as DownloadPlan;

    const result = await worker.runPlan(plan);

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toMatch(/ffmpeg unavailable: audio extraction/iu);
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
    expect(ffmpeg.jobs[0]?.inputs[0]?.file).toBeInstanceOf(File);
    expect(ffmpeg.jobs[0]?.inputs[0]?.bytes).toBeUndefined();
    expect(files.has("download_convert.mp4")).toBe(false);
    const staged = [...(files.get("download_convert.mp3") ?? [])];
    expect(staged.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(2048);
  });
});

describe("HLS TS output formats", () => {
  async function runHlsTs(options: { outputFormat?: "mp4"; withFfmpeg?: boolean } = {}) {
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
      ...(options.withFfmpeg === false ? {} : { ffmpeg: ffmpeg.runner }),
    });
    vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValueOnce("blob:temp").mockReturnValueOnce("blob:final");
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
      ...(options.outputFormat === undefined ? {} : { output_format: options.outputFormat }),
      is_youtube: false,
      throttle: false,
      cache: "default",
    } as DownloadPlan;

    const result = await worker.runPlan(plan);
    return { result, files, ffmpeg, revoke };
  }

  it("keeps the original M2TS unless MP4 was requested", async () => {
    const { result, files, ffmpeg } = await runHlsTs();

    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    if (result.tag === "Ok") expect(result.value.output_extension).toBe("m2ts");
    expect(ffmpeg.jobs).toHaveLength(0);
    expect(files.has("download_hls_remux.m2ts")).toBe(true);
  });

  it("remuxes explicit MP4 and removes the temporary M2TS file", async () => {
    const { result, files, ffmpeg, revoke } = await runHlsTs({ outputFormat: "mp4" });

    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.output_extension).toBe("mp4");
      expect(result.value.internal_bloburl).toBe("blob:final");
    }
    expect(ffmpeg.jobs[0]?.inputs[0]?.file?.size).toBe(1200);
    expect(ffmpeg.jobs[0]?.inputs[0]?.bytes).toBeUndefined();
    expect(files.has("download_hls_remux.m2ts")).toBe(false);
    expect(files.has("download_hls_remux.mp4")).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:temp");
  });

  it("reports an error instead of saving M2TS when MP4 conversion is unavailable", async () => {
    const { result } = await runHlsTs({ outputFormat: "mp4", withFfmpeg: false });

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toMatch(/MP4 conversion requires FFmpeg/i);
  });
});

describe("ffmpeg inputs are staged files", () => {
  const channel = {
    postMessage: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: () => undefined,
  } as unknown as BroadcastChannelLike;
  const hlsMedia = (prefix: string): string =>
    `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n${prefix}0.ts\n#EXTINF:4,\n${prefix}1.ts\n#EXT-X-ENDLIST\n`;

  it("merges separate HLS audio and video renditions from mounted files", async () => {
    const payloads = new Map<string, string | Uint8Array>([
      ["https://cdn.test/video.m3u8", hlsMedia("v")],
      ["https://cdn.test/audio.m3u8", hlsMedia("a")],
      ["https://cdn.test/v0.ts", new Uint8Array(600).fill(1)],
      ["https://cdn.test/v1.ts", new Uint8Array(600).fill(2)],
      ["https://cdn.test/a0.ts", new Uint8Array(600).fill(3)],
      ["https://cdn.test/a1.ts", new Uint8Array(600).fill(4)],
    ]);
    const { root, files } = createFakeOpfs();
    const ffmpeg = fakeFfmpeg();
    const worker = new DownloadWorker({
      channel,
      fetchImpl: createFetch(payloads),
      openRoot: async () => root,
      ffmpeg: ffmpeg.runner,
    });
    const plan: DownloadPlan = {
      download_id: "download_hls_two",
      headers: new Headers(),
      good_basename: "two",
      subdir: "",
      save_as: false,
      will_use_jsfetch: true,
      strategy: "m3u8_audio_video_two_sources",
      url: new URL("https://cdn.test/video.m3u8"),
      url_audio: new URL("https://cdn.test/audio.m3u8"),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      source_demuxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    };

    const result = await worker.runPlan(plan);

    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    if (result.tag === "Ok") expect(result.value.output_extension).toBe("mp4");
    expect(ffmpeg.jobs).toHaveLength(1);
    const inputs = ffmpeg.jobs[0]?.inputs ?? [];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.file).toBeInstanceOf(File);
      expect(input.bytes).toBeUndefined();
    }
    // The two staged tracks are temporary; the merged output is what remains.
    expect(files.has("download_hls_two-video.m2ts")).toBe(false);
    expect(files.has("download_hls_two-audio.m2ts")).toBe(false);
    const output = [...(files.get("download_hls_two.mp4") ?? [])];
    expect(output.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(2048);
  });

  it("converts an HLS stream from its mounted file instead of buffering it", async () => {
    const payloads = new Map<string, string | Uint8Array>([
      ["https://cdn.test/media.m3u8", hlsMedia("m")],
      ["https://cdn.test/m0.ts", new Uint8Array(600).fill(1)],
      ["https://cdn.test/m1.ts", new Uint8Array(600).fill(2)],
    ]);
    const { root, files } = createFakeOpfs();
    const ffmpeg = fakeFfmpeg();
    const worker = new DownloadWorker({
      channel,
      fetchImpl: createFetch(payloads),
      openRoot: async () => root,
      ffmpeg: ffmpeg.runner,
    });
    const plan = {
      download_id: "download_hls_convert",
      headers: new Headers(),
      good_basename: "convert",
      subdir: "",
      save_as: false,
      will_use_jsfetch: true,
      strategy: "m3u8_audio_video_one_source",
      url: new URL("https://cdn.test/media.m3u8"),
      carry_get_params: false,
      extension: "mp3",
      muxer: "mp3",
      output_format: "mp3",
      is_youtube: false,
      throttle: false,
      cache: "default",
    } as DownloadPlan;

    const result = await worker.runPlan(plan);

    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    if (result.tag === "Ok") expect(result.value.output_extension).toBe("mp3");
    expect(ffmpeg.jobs).toHaveLength(1);
    expect(ffmpeg.jobs[0]?.inputs[0]?.file).toBeInstanceOf(File);
    expect(ffmpeg.jobs[0]?.inputs[0]?.bytes).toBeUndefined();
    expect(files.has("download_hls_convert.m2ts")).toBe(false);
    expect(files.has("download_hls_convert.mp3")).toBe(true);
  });

  it("surfaces the byte-input budget as a normal download error", async () => {
    const source = new Uint8Array(4096).fill(7);
    const { root, files } = createFakeOpfs();
    const runner = {
      run: async (): Promise<Uint8Array> => {
        throw new FfmpegInputTooLargeError(700 * 1024 * 1024, 600 * 1024 * 1024);
      },
    };
    const worker = new DownloadWorker({
      channel,
      fetchImpl: (async () => new Response(source)) as never,
      openRoot: async () => root,
      ffmpeg: runner,
    });
    const plan = {
      download_id: "download_budget",
      headers: new Headers(),
      good_basename: "budget",
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
    } as DownloadPlan;

    const result = await worker.runPlan(plan);

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toMatch(/too large to process in the browser/iu);
    // The staged source is cleaned up even when the job is rejected.
    expect(files.has("download_budget.mp4")).toBe(false);
  });
});

describe("streamed FFmpeg output", () => {
  it("writes an HLS TS remux through the staging runner instead of memory", async () => {
    const manifest = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n0.ts\n#EXTINF:4,\n1.ts\n#EXT-X-ENDLIST\n";
    const payloads = new Map<string, string | Uint8Array>([
      ["https://cdn.test/media.m3u8", manifest],
      ["https://cdn.test/0.ts", new Uint8Array(600).fill(1)],
      ["https://cdn.test/1.ts", new Uint8Array(600).fill(2)],
    ]);
    const { root, files } = createFakeOpfs();
    let memoryRuns = 0;
    let stagedRuns = 0;
    const runner = {
      run: async (): Promise<Uint8Array> => {
        memoryRuns += 1;
        return new Uint8Array(2048).fill(9);
      },
      runToStaging: async (_job: unknown, target: { root: typeof root; directory: string; filename: string }) => {
        stagedRuns += 1;
        const staged = await createStagedFile(target.root, target.filename);
        await staged.append(new Uint8Array(2048).fill(5));
        await staged.finish();
      },
    };
    const worker = new DownloadWorker({
      channel: {
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        close: () => undefined,
      } as unknown as BroadcastChannelLike,
      fetchImpl: createFetch(payloads),
      openRoot: async () => root,
      ffmpeg: runner,
    });
    const plan = {
      download_id: "download_staged_remux",
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
      output_format: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    } as DownloadPlan;

    const result = await worker.runPlan(plan);

    expect(result.tag === "Ok" ? "Ok" : result.error).toBe("Ok");
    expect(stagedRuns).toBe(1);
    expect(memoryRuns).toBe(0);
    expect(files.has("download_staged_remux.mp4")).toBe(true);
  });
});
describe("webm copy merge", () => {  it("stream-copies VP9/Opus tracks into WebM without transcoding", async () => {
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
