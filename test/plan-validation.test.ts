import { describe, expect, it } from "vitest";
import type { DownloadPlan } from "../src/core/types.js";
import { validateDownloadPlan } from "../src/extension/service-worker.js";

function planWithBasename(good_basename: string, subdir = "Downloads/"): DownloadPlan {
  return {
    download_id: "download_test",
    headers: new Headers(),
    good_basename,
    subdir,
    save_as: false,
    will_use_jsfetch: false,
    strategy: "http_video_preview_jsfetch",
    url: new URL("https://cdn.example/video.mp4"),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    is_youtube: false,
    throttle: false,
    cache: "default",
  };
}

describe("download-plan filename validation", () => {
  it("accepts ellipses and internal dots from ordinary video titles", () => {
    expect(validateDownloadPlan(planWithBasename("Wait for it..."))).toBeUndefined();
    expect(validateDownloadPlan(planWithBasename("Episode 1..2 (final)"))).toBeUndefined();
    expect(validateDownloadPlan(planWithBasename("file.name.mp4"))).toBeUndefined();
  });

  it("still rejects path separators and control characters", () => {
    expect(validateDownloadPlan(planWithBasename("../escape"))).toBe("Unsafe filename");
    expect(validateDownloadPlan(planWithBasename("dir/name"))).toBe("Unsafe filename");
    expect(validateDownloadPlan(planWithBasename("dir\\\\name"))).toBe("Unsafe filename");
    expect(validateDownloadPlan(planWithBasename("bad\\nname"))).toBe("Unsafe filename");
    expect(validateDownloadPlan(planWithBasename(""))).toBe("Unsafe filename");
  });

  it("rejects the names Chrome refuses once the media extension is appended", () => {
    expect(validateDownloadPlan(planWithBasename("CON"))).toBe("Unsafe filename");
    expect(validateDownloadPlan(planWithBasename("nul.zip"))).toBe("Unsafe filename");
    expect(validateDownloadPlan(planWithBasename("_CON"))).toBeUndefined();
    expect(validateDownloadPlan(planWithBasename("COM0"))).toBeUndefined();
  });

  it("rejects directory segments Chrome refuses", () => {
    expect(validateDownloadPlan(planWithBasename("clip", "CON/"))).toBe("Unsafe download directory");
    expect(validateDownloadPlan(planWithBasename("clip", "foo./"))).toBe("Unsafe download directory");
    expect(validateDownloadPlan(planWithBasename("clip", "Downloads/_CON/"))).toBeUndefined();
  });
});
