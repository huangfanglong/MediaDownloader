/**
 * abort handling tests: user-cancel detection.
 */
import { describe, expect, it, vi } from "vitest";
import { DownloadWorker } from "../src/extension/download-worker.js";
import type { DownloadPlan } from "../src/core/types.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import type { FetchLike } from "../src/transfer/fetch.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";

const noopChannel = (): BroadcastChannelLike => ({
  postMessage: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  close: () => undefined,
});

const MANIFEST_URL = "https://cdn.example.com/stream/master.m3u8";
const SIMPLE_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  "/stream/seg-0.ts",
  "#EXTINF:2.0,",
  "/stream/seg-1.ts",
  "#EXTINF:2.0,",
  "/stream/seg-2.ts",
  "#EXT-X-ENDLIST",
].join("\n");

const SEGMENT_BYTES = new Uint8Array(2048).fill(7);

describe("abort handling", () => {
  it("returns user_abort error when signal is already aborted", async () => {
    const payloads = new Map<string, string | Uint8Array>([
      [MANIFEST_URL, SIMPLE_PLAYLIST],
      ["https://cdn.example.com/stream/seg-0.ts", SEGMENT_BYTES],
      ["https://cdn.example.com/stream/seg-1.ts", SEGMENT_BYTES],
      ["https://cdn.example.com/stream/seg-2.ts", SEGMENT_BYTES],
    ]);

    const serving = createFetch(payloads);
    const fetchImpl: FetchLike = async (url, init) => serving(url, init);

    const { root } = createFakeOpfs();
    vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValue("blob:abort-test");
    const worker = new DownloadWorker({ channel: noopChannel(), fetchImpl, openRoot: async () => root });

    const controller = new AbortController();
    controller.abort(); // Abort before starting

    const plan: DownloadPlan = {
      download_id: "download_abort_test",
      headers: new Headers(),
      headers_origin: new URL(MANIFEST_URL).origin,
      good_basename: "abort-test",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "m3u8_audio_video_one_source",
      url: new URL(MANIFEST_URL),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    };

    const result = await worker.runPlan(plan, controller.signal);

    // Worker should return user_abort error
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error).toBe("user_abort");
    }
  });

  it("non-abort errors still produce regular error outcomes", async () => {
    const payloads = new Map<string, string | Uint8Array>([
      [MANIFEST_URL, SIMPLE_PLAYLIST],
      ["https://cdn.example.com/stream/seg-0.ts", SEGMENT_BYTES],
      // seg-1 and seg-2 missing to trigger failure
    ]);

    const serving = createFetch(payloads);
    const fetchImpl: FetchLike = async (url, init) => serving(url, init);

    const { root } = createFakeOpfs();
    vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValue("blob:error-test");
    const worker = new DownloadWorker({ channel: noopChannel(), fetchImpl, openRoot: async () => root });

    const plan: DownloadPlan = {
      download_id: "download_error_test",
      headers: new Headers(),
      headers_origin: new URL(MANIFEST_URL).origin,
      good_basename: "error-test",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "m3u8_audio_video_one_source",
      url: new URL(MANIFEST_URL),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    };

    const result = await worker.runPlan(plan);

    // Regular error, NOT user_abort
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error).not.toBe("user_abort");
      expect(result.error).toMatch(/too small|many/i);
    }
  });
});
