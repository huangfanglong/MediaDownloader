/**
 * Abort handling: user-cancel detection and the cleanup a cancel must leave behind.
 *
 * Cancelling stops the transfer at the next segment boundary, reports the structural `user_abort`
 * outcome, and removes the partially written OPFS staging file instead of leaving it for the next
 * worker boot to purge.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadWorker } from "../src/extension/download-worker.js";
import type { DownloadPlan, TransferOutcome } from "../src/core/types.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import type { FetchLike, FetchResponseLike } from "../src/transfer/fetch.js";
import type { FfmpegRunnerLike } from "../src/transfer/ffmpeg.js";
import type { Result } from "../src/core/option.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";

const noopChannel = (): BroadcastChannelLike => ({
  postMessage: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  close: () => undefined,
});

const MANIFEST_URL = "https://cdn.example.com/stream/master.m3u8";
const AUDIO_MANIFEST_URL = "https://cdn.example.com/stream/audio.m3u8";
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
const encoder = new TextEncoder();

/** One segment per track: enough for a complete HLS assembly without extra fetches. */
const ONE_SEGMENT_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  "/stream/seg-0.ts",
  "#EXT-X-ENDLIST",
].join("\n");

const planFor = (downloadId: string, overrides: Partial<DownloadPlan> = {}): DownloadPlan => ({
  download_id: downloadId,
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
  ...overrides,
});

function textResponse(text: string): FetchResponseLike {
  return bytesResponse(encoder.encode(text));
}

function bytesResponse(bytes: Uint8Array): FetchResponseLike {
  let sent = false;
  return {
    status: 200,
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: bytes };
        },
        cancel: async () => undefined,
      }),
    },
  };
}

/** A response that never lands; the abort signal rejects it like a cancelled browser fetch. */
const hangUntilAbort: FetchLike = async (_url, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true,
    });
  });

/** Poll a condition instead of sleeping a fixed amount: abort tests need a deterministic point. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never reached");
}

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const errorOf = (result: Result<TransferOutcome, string>): string => {
  expect(result.tag).toBe("Err");
  return result.tag === "Err" ? result.error : "";
};

afterEach(() => {
  vi.restoreAllMocks();
});

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

    const result = await worker.runPlan(planFor("download_abort_test"), controller.signal);

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

    const result = await worker.runPlan(planFor("download_error_test"));

    // Regular error, NOT user_abort
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error).not.toBe("user_abort");
      expect(result.error).toMatch(/too small|many/i);
    }
  });

  it("cancelling between segments stops fetching and removes the partial staged file", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const opfs = createFakeOpfs();
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(url);
      if (url === MANIFEST_URL) return textResponse(SIMPLE_PLAYLIST);
      if (url.endsWith("seg-0.ts")) return bytesResponse(SEGMENT_BYTES);
      return hangUntilAbort(url, init);
    };
    vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValue("blob:abort-cleanup");
    const worker = new DownloadWorker({
      channel: noopChannel(),
      fetchImpl,
      openRoot: async () => opfs.root,
    });

    const run = worker.runPlan(planFor("download_abort_cleanup", { throttle: true }), controller.signal);
    await waitFor(() => calls.some((url) => url.endsWith("seg-1.ts")));
    await settle();
    controller.abort();
    const result = await run;

    expect(errorOf(result)).toBe("user_abort");
    // The cancelled worker must not keep pulling the rest of the playlist.
    expect(calls.some((url) => url.endsWith("seg-2.ts"))).toBe(false);
    // The partially written staging file is removed now, not left for the next worker boot.
    expect([...opfs.files.keys()]).toEqual([]);
    expect([...opfs.removed.keys()]).toEqual(["download_abort_cleanup.m2ts"]);
  });

  it("cancelling while workers wait for the write head does not stall the transfer", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const opfs = createFakeOpfs();
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(url);
      if (url === MANIFEST_URL) {
        return textResponse(
          [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            "#EXT-X-TARGETDURATION:2",
            ...Array.from({ length: 6 }, (_, index) => `#EXTINF:2.0,\nseg-${index}.ts`),
            "#EXT-X-ENDLIST",
          ].join("\n"),
        );
      }
      if (url.endsWith("seg-0.ts")) return hangUntilAbort(url, init);
      return bytesResponse(SEGMENT_BYTES);
    };
    vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValue("blob:abort-head");
    const worker = new DownloadWorker({
      channel: noopChannel(),
      fetchImpl,
      openRoot: async () => opfs.root,
      // Force the out-of-order workers to wait for the missing head before fetching more segments.
      limits: { maxRetainedSegmentBytes: 1000 },
    });

    const run = worker.runPlan(planFor("download_abort_head"), controller.signal);
    await waitFor(() => calls.filter((url) => url.includes("seg-")).length >= 3);
    controller.abort();
    const result = await Promise.race([
      run,
      new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 2_000)),
    ]);

    expect(result).not.toBe("stalled");
    if (result === "stalled") return;
    expect(errorOf(result)).toBe("user_abort");
    expect([...opfs.files.keys()]).toEqual([]);
  });

  it("cancelling the audio rendition removes the already staged video track", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const opfs = createFakeOpfs();
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(url);
      if (url === MANIFEST_URL) return textResponse(ONE_SEGMENT_PLAYLIST);
      if (url.endsWith("seg-0.ts")) return bytesResponse(SEGMENT_BYTES);
      if (url === AUDIO_MANIFEST_URL) return hangUntilAbort(url, init);
      return { status: 404, ok: false, body: null };
    };
    // FFmpeg is injected because only the streaming branch stages both HLS tracks; the abort
    // arrives before the merge, so the stub itself is never called.
    const ffmpeg: FfmpegRunnerLike = {
      run: async () => {
        throw new Error("ffmpeg must not run after the cancel");
      },
    };
    vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValue("blob:abort-two-source");
    const worker = new DownloadWorker({
      channel: noopChannel(),
      fetchImpl,
      openRoot: async () => opfs.root,
      ffmpeg,
    });

    const run = worker.runPlan(
      planFor("download_abort_two_source", {
        strategy: "m3u8_audio_video_two_sources",
        url_audio: new URL(AUDIO_MANIFEST_URL),
      }),
      controller.signal,
    );
    await waitFor(() => calls.includes(AUDIO_MANIFEST_URL));
    await settle();
    controller.abort();
    const result = await run;

    expect(errorOf(result)).toBe("user_abort");
    // The video track was already assembled and staged when the audio cancel arrived.
    expect([...opfs.files.keys()]).toEqual([]);
    expect([...opfs.removed.keys()]).toEqual(["download_abort_two_source-video.m2ts"]);
  });
});
