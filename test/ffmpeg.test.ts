import { describe, expect, it } from "vitest";
import { convertArgs, mergeArgs, mp3Args } from "../src/transfer/ffmpeg.js";
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
