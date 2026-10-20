import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probeMpegTsVideoSize } from "../src/manifests/ts-probe.js";

describe("probeMpegTsVideoSize", () => {
  it("reads the resolution from an H.264 SPS in MPEG-TS", () => {
    const bytes = new Uint8Array(readFileSync("test/fixtures/h264-720p.ts.bin"));
    expect(probeMpegTsVideoSize(bytes)).toEqual({ width: 1280, height: 720 });
  });
});
