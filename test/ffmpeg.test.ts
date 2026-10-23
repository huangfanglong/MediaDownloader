import { describe, expect, it, vi } from "vitest";
import { convertArgs, FfmpegRunner, mergeArgs, mp3Args, type FfmpegJob } from "../src/transfer/ffmpeg.js";

const ffmpegState = vi.hoisted(() => ({ active: 0, maxActive: 0, failNext: false }));

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: class {
    loaded = true;

    on(): void {}

    async load(): Promise<void> {}

    async writeFile(): Promise<void> {}

    async exec(): Promise<number> {
      ffmpegState.active += 1;
      ffmpegState.maxActive = Math.max(ffmpegState.maxActive, ffmpegState.active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      ffmpegState.active -= 1;
      if (ffmpegState.failNext) {
        ffmpegState.failNext = false;
        return 1;
      }
      return 0;
    }

    async readFile(): Promise<Uint8Array> {
      return new Uint8Array([1]);
    }

    async deleteFile(): Promise<void> {}

    terminate(): void {}
  },
}));
import { applyOutputFormat, normalizeOutputFormat } from "../src/plan/output-format.js";
import type { DownloadPlan } from "../src/core/types.js";

describe("ffmpeg argument builders", () => {
  it("merges with stream copy for MP4/MKV", () => {
    expect(mergeArgs("v.mp4", "a.m4a", "out.mp4", "mp4", false)).toEqual([
      "-hide_banner", "-y", "-i", "v.mp4", "-i", "a.m4a", "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "out.mp4",
    ]);
    expect(mergeArgs("v", "a", "out.mkv", "mkv", false)).toContain("out.mkv");
  });

  it("transcodes only when explicitly requested (WebM fallback args)", () => {
    const args = mergeArgs("v", "a", "out.webm", "webm", true);
    expect(args).toContain("libvpx");
    expect(args).toContain("libopus");
  });

  it("extracts MP3 and re-containers single inputs", () => {
    expect(mp3Args("in.mp4", "out.mp3")).toContain("libmp3lame");
    expect(mp3Args("in.mp4", "out.mp3")).toContain("-vn");
    expect(convertArgs("in.mp4", "out.mkv", "mkv", false)).toContain("copy");
    expect(convertArgs("in.mp4", "out.webm", "webm", true)).toContain("libvpx");
  });
});

describe("ffmpeg job scheduling", () => {
  it("runs one job at a time on a shared runner", async () => {
    ffmpegState.active = 0;
    ffmpegState.maxActive = 0;
    const runner = new FfmpegRunner("https://extension.test/vendor/");
    const job: FfmpegJob = {
      inputs: [{ name: "video.bin", bytes: new Uint8Array([1]) }],
      args: ["-i", "video.bin", "out.mp4"],
      outputName: "out.mp4",
    };

    await Promise.all([runner.run(job), runner.run(job)]);

    expect(ffmpegState.maxActive).toBe(1);
  });

  it("continues with the next job after a failure", async () => {
    const runner = new FfmpegRunner("https://extension.test/vendor/");
    const job: FfmpegJob = { inputs: [], args: ["out.mp4"], outputName: "out.mp4" };
    ffmpegState.failNext = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runner.run(job)).rejects.toThrow("ffmpeg exited with 1");
    await expect(runner.run(job)).resolves.toEqual(new Uint8Array([1]));
  });
});

describe("output format plumbing", () => {
  it("accepts only the supported formats", () => {
    expect(normalizeOutputFormat("mkv")).toBe("mkv");
    expect(normalizeOutputFormat("mp3")).toBe("mp3");
    expect(normalizeOutputFormat("exe")).toBeUndefined();
    expect(normalizeOutputFormat(undefined)).toBeUndefined();
  });

  it("applies the format to a plan without mutating the original", () => {
    const plan = { extension: "mp4", muxer: "mp4" } as DownloadPlan;
    const converted = applyOutputFormat(plan, "mkv");
    expect(converted.extension).toBe("mkv");
    expect(converted.muxer).toBe("mkv");
    expect(converted.output_format).toBe("mkv");
    expect(plan.extension).toBe("mp4");
  });
});
