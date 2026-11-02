/**
 * Segment bodies are page-controlled input: the playlist decides every segment URI. The worker
 * must therefore refuse a body larger than its in-memory ceiling instead of buffering it, must not
 * skip it like a transient segment failure, and must keep out-of-order retention bounded while the
 * ordered write head is missing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadPlan } from "../src/core/types.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import type { FetchLike, FetchResponseLike } from "../src/transfer/fetch.js";
import { fetchRanged } from "../src/transfer/ranged.js";
import { tooLargeError, withSegmentRetry } from "../src/transfer/retry.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { createFakeOpfs, createRangedFetch } from "./helpers/transfer-fakes.js";

const MANIFEST_URL = "https://cdn.example.com/stream/media.m3u8";
const encoder = new TextEncoder();

const playlistFor = (count: number): string =>
  [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:2",
    ...Array.from({ length: count }, (_, index) => `#EXTINF:2.0,\nseg-${index}.ts`),
    "#EXT-X-ENDLIST",
  ].join("\n");

const noopChannel = (): BroadcastChannelLike => ({
  postMessage: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  close: () => undefined,
});

const planFor = (downloadId: string, overrides: Partial<DownloadPlan> = {}): DownloadPlan => ({
  download_id: downloadId,
  headers: new Headers(),
  headers_origin: new URL(MANIFEST_URL).origin,
  good_basename: "segment-limits",
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

function bodyResponse(bytes: Uint8Array, tracking?: { cancels: number }): FetchResponseLike {
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
        cancel: async () => {
          if (tracking !== undefined) tracking.cancels += 1;
        },
      }),
    },
  };
}

/** A body of `totalBytes` delivered in `chunkBytes` pieces, like a real streamed response. */
function chunkedBody(
  totalBytes: number,
  chunkBytes: number,
  tracking?: { cancels: number },
): FetchResponseLike {
  let served = 0;
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (served >= totalBytes) return { done: true };
          const size = Math.min(chunkBytes, totalBytes - served);
          served += size;
          return { done: false, value: new Uint8Array(size) };
        },
        cancel: async () => {
          if (tracking !== undefined) tracking.cancels += 1;
        },
      }),
    },
  };
}

const totalStagedBytes = (files: Map<string, Uint8Array[]>): number =>
  [...files.values()].flat().reduce((sum, chunk) => sum + chunk.byteLength, 0);

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("segment body ceiling", () => {
  it("fails the download when one segment is over the ceiling instead of buffering or skipping it", async () => {
    const opfs = createFakeOpfs();
    // Injected ceiling: 1 KiB. The hostile segment is 4 KiB, split into 1 KiB chunks, and it is
    // the *second* of four segments, so the failure ratio (1/4) is under the 35 % skip gate.
    const oversized = { cancels: 0 };
    const fetchCounts = new Map<string, number>();
    const fetchImpl: FetchLike = async (url) => {
      fetchCounts.set(url, (fetchCounts.get(url) ?? 0) + 1);
      if (url === MANIFEST_URL) return bodyResponse(encoder.encode(playlistFor(4)));
      if (url.endsWith("seg-1.ts")) return chunkedBody(4096, 1024, oversized);
      return bodyResponse(new Uint8Array(512).fill(1));
    };
    const worker = new DownloadWorker({
      channel: noopChannel(),
      fetchImpl,
      openRoot: async () => opfs.root,
      limits: { maxSegmentBytes: 1024 },
    });

    const result = await worker.runPlan(planFor("segment-over-ceiling"));
    await settle();

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error).toMatch(/Segment 2 of 4 exceeds the 1024 byte in-memory limit/);
    }
    // Terminal, not a retryable failure: the body is the same size on every attempt.
    expect(fetchCounts.get("https://cdn.example.com/stream/seg-1.ts")).toBe(1);
    // The response body is released instead of being read to the end.
    expect(oversized.cancels).toBe(1);
    // The refusal must not leave a truncated file behind, not even as "complete with holes".
    expect(opfs.files.size).toBe(0);
  }, 20_000);

  it("accepts a segment exactly at the ceiling", async () => {
    const opfs = createFakeOpfs();
    const fetchImpl: FetchLike = async (url) => {
      if (url === MANIFEST_URL) return bodyResponse(encoder.encode(playlistFor(1)));
      return bodyResponse(new Uint8Array(1024).fill(7));
    };
    const worker = new DownloadWorker({
      channel: noopChannel(),
      fetchImpl,
      openRoot: async () => opfs.root,
      limits: { maxSegmentBytes: 1024 },
    });

    const result = await worker.runPlan(planFor("segment-at-ceiling"));

    expect(result.tag).toBe("Ok");
    expect(totalStagedBytes(opfs.files)).toBe(1024);
  }, 20_000);

  it("bounds out-of-order retention while the head segment stalls", async () => {
    const segments = 12;
    const opfs = createFakeOpfs();
    let releaseHead!: () => void;
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    const started: number[] = [];
    const fetchImpl: FetchLike = async (url) => {
      if (url === MANIFEST_URL) return bodyResponse(encoder.encode(playlistFor(segments)));
      const index = Number(/seg-(\d+)\.ts/u.exec(url)?.[1] ?? -1);
      started.push(index);
      if (index === 0) await headGate;
      return bodyResponse(new Uint8Array(1024).fill(index + 1));
    };
    const worker = new DownloadWorker({
      channel: noopChannel(),
      fetchImpl,
      openRoot: async () => opfs.root,
      // Four workers, a 2 KiB retention budget, and 1 KiB segments: at most two of the workers can
      // fetch one extra segment before the budget stops them.
      limits: { maxSegmentBytes: 1024, maxRetainedSegmentBytes: 2048 },
    });

    const run = worker.runPlan(planFor("segment-stalled-head"));
    // Wait until fetching behind the gate stops moving.
    let lastCount = -1;
    for (let tick = 0; tick < 400; tick += 1) {
      if (started.length === lastCount) break;
      lastCount = started.length;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const nonHead = started.filter((index) => index !== 0);

    expect(nonHead.length).toBeGreaterThanOrEqual(3);
    expect(nonHead.length).toBeLessThanOrEqual(5);
    expect(nonHead.length).toBeLessThan(segments - 1);

    releaseHead();
    const result = await run;
    expect(result.tag).toBe("Ok");
    expect(totalStagedBytes(opfs.files)).toBe(segments * 1024);
  }, 20_000);

  it("refuses the no-staging fallback once the buffered playlist passes its ceiling", async () => {
    const opfs = createFakeOpfs();
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith(".m3u8")) return bodyResponse(encoder.encode(playlistFor(3)));
      return bodyResponse(new Uint8Array(512).fill(1));
    };
    const worker = new DownloadWorker({
      channel: noopChannel(),
      fetchImpl,
      openRoot: async () => opfs.root,
      limits: { maxUnstagedHlsBytes: 700 },
    });
    const plan = planFor("segment-unstaged", {
      strategy: "m3u8_audio_video_two_sources",
      url: new URL("https://cdn.example.com/stream/video.m3u8"),
      url_audio: new URL("https://cdn.example.com/stream/audio.m3u8"),
    });

    const result = await worker.runPlan(plan);

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error).toMatch(/Playlist output exceeds the 700 byte in-memory limit/);
    }
  }, 20_000);
});

describe("whole-body ceilings in the transfer primitives", () => {
  it("marks an over-ceiling body terminal so it is not fetched five times", async () => {
    let attempts = 0;
    const result = await withSegmentRetry(async () => {
      attempts += 1;
      return { tag: "Err" as const, error: tooLargeError("Response exceeds 1 bytes") };
    });

    expect(result.tag).toBe("Err");
    expect(attempts).toBe(1);
  });

  it("stops a ranged track when its aggregate bytes pass the ceiling", async () => {
    const payload = new Uint8Array(200 * 1024).fill(3);
    const result = await fetchRanged(
      createRangedFetch(payload),
      new URL("https://cdn.test/file.mp4"),
      new Headers(),
      { maxBytes: 100 * 1024 },
    );

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.kind).toBe("too_large");
  });
});
