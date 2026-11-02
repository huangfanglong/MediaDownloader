/**
 * HLS progress is reported from concurrent segment workers. Completion order is not assignment
 * order, so the reported percentage must follow completed work, never the worker's index.
 */
import { describe, expect, it, vi } from "vitest";
import type { DownloadPlan, TransferOutcome } from "../src/core/types.js";
import type { Result } from "../src/core/option.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import type { FetchLike, FetchResponseLike } from "../src/transfer/fetch.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { createFakeOpfs } from "./helpers/transfer-fakes.js";

const MANIFEST_URL = "https://cdn.example.com/stream/media.m3u8";
const SEGMENT_BYTES = 2048;

const playlistFor = (count: number): string =>
  [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:2",
    ...Array.from({ length: count }, (_, index) => `#EXTINF:2.0,\nseg-${index}.ts`),
    "#EXT-X-ENDLIST",
  ].join("\n");

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

const noopChannel = (): BroadcastChannelLike => ({
  postMessage: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  close: () => undefined,
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await flush();
};

interface Deferred {
  gate: Promise<void>;
  release: () => void;
}

interface RunOptions {
  count: number;
  releaseOrder: number[];
  failingIndex?: number;
  failingIndices?: number[];
  throttle?: boolean;
  /** Wall-clock added before each release; controls which events pass the 2 Hz emission throttle. */
  clockStep?: number;
}

interface RunResult {
  percents: number[];
  byteSamples: number[];
  result: Result<TransferOutcome, string>;
}

async function runHls(options: RunOptions): Promise<RunResult> {
  const gates = new Map<number, Deferred>();
  for (const index of options.releaseOrder) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(index, { gate, release });
  }
  const nowRef = { value: 1_000_000 };
  const percents: number[] = [];
  const byteSamples: number[] = [];
  const channel: BroadcastChannelLike = {
    ...noopChannel(),
    postMessage: (message) => {
      const envelope = message as {
        msg?: {
          name?: string;
          data?: { progress?: { percent?: { is_known: boolean; value: number }; fetched_bytes_count?: number } };
        };
      };
      if (envelope.msg?.name !== "download_progress") return;
      const progress = envelope.msg.data?.progress;
      if (progress?.percent?.is_known === true) percents.push(progress.percent.value);
      if (typeof progress?.fetched_bytes_count === "number") byteSamples.push(progress.fetched_bytes_count);
    },
  };
  const failing = new Set(options.failingIndices ?? (options.failingIndex === undefined ? [] : [options.failingIndex]));
  const fetchImpl: FetchLike = async (url) => {
    if (url === MANIFEST_URL) return bytesResponse(new TextEncoder().encode(playlistFor(options.count)));
    const index = Number(/seg-(\d+)\.ts/u.exec(url)?.[1] ?? -1);
    if (index < 0) return { status: 404, ok: false, body: null };
    if (failing.has(index)) return { status: 404, ok: false, body: null };
    await gates.get(index)?.gate;
    return bytesResponse(new Uint8Array(SEGMENT_BYTES).fill(index + 1));
  };
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:hls-progress");
  const worker = new DownloadWorker({
    channel,
    fetchImpl,
    openRoot: async () => createFakeOpfs().root,
    now: () => nowRef.value,
  });
  const plan: DownloadPlan = {
    download_id: "download_hls_progress",
    headers: new Headers(),
    headers_origin: new URL(MANIFEST_URL).origin,
    good_basename: "hls-progress",
    subdir: "",
    save_as: false,
    will_use_jsfetch: false,
    strategy: "m3u8_audio_video_one_source",
    url: new URL(MANIFEST_URL),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    is_youtube: false,
    throttle: options.throttle ?? false,
    cache: "default",
  };

  // Production runs go through `onDownload`, which registers the active download before the
  // transfer; that registration is what enables the 2 Hz emission throttle.
  (worker as unknown as {
    active: Map<string, { controller: AbortController; lastProgressAt: number }>;
  }).active.set(plan.download_id, { controller: new AbortController(), lastProgressAt: 0 });

  const run = worker.runPlan(plan);
  await settle(); // workers hold their first segments (or the failing segment resolves at once)
  for (const index of options.releaseOrder) {
    nowRef.value += options.clockStep ?? 1_000;
    gates.get(index)?.release();
    await settle();
  }
  const result = await run;
  return { percents, byteSamples, result };
}

describe("HLS segment progress under concurrent workers", () => {
  it("reports a monotonic percentage when segments finish out of order", async () => {
    const { percents, byteSamples, result } = await runHls({
      count: 6,
      releaseOrder: [3, 0, 4, 1, 5, 2],
    });

    expect(result.tag).toBe("Ok");
    expect(percents.map((value) => Math.round(value))).toEqual([17, 33, 50, 67, 83, 99]);
    expect(percents.every((value, index) => index === 0 || value >= (percents[index - 1] as number))).toBe(true);
    expect(percents).not.toContain(100);
    expect(byteSamples.every((value, index) => index === 0 || value >= (byteSamples[index - 1] as number))).toBe(true);
  });

  it("counts a failed segment as settled work without jumping ahead", async () => {
    const { percents, result } = await runHls({
      count: 4,
      releaseOrder: [3, 0, 1],
      failingIndex: 2,
    });

    // Four planned segments: the failure and the three successes each advance one step.
    expect(percents.map((value) => Math.round(value))).toEqual([25, 50, 75, 99]);
    expect(percents.every((value, index) => index === 0 || value >= (percents[index - 1] as number))).toBe(true);
    expect(percents).not.toContain(100);
    // A quarter of the stream duration is missing, so the output completeness gate (E19) refuses
    // to save the short file as a finished download.
    expect(result).toEqual({ tag: "Err", error: "Incomplete percentage." });
  });

  it("accepts a failure that costs little of the stream duration", async () => {
    const { result } = await runHls({ count: 40, releaseOrder: [0], failingIndex: 1 });
    expect(result.tag).toBe("Ok");
  });

  it("aborts when too many segments fail", async () => {
    const { result } = await runHls({
      count: 4,
      releaseOrder: [0],
      failingIndices: [1, 2],
    });
    expect(result).toEqual({ tag: "Err", error: "Too many invalid segments, aborting download." });
  });

  it("reports the same sequence when the plan is throttled to one segment at a time", async () => {
    const { percents, result } = await runHls({
      count: 6,
      releaseOrder: [0, 1, 2, 3, 4, 5],
      throttle: true,
    });

    expect(result.tag).toBe("Ok");
    expect(percents.map((value) => Math.round(value))).toEqual([17, 33, 50, 67, 83, 99]);
    expect(percents.every((value, index) => index === 0 || value >= (percents[index - 1] as number))).toBe(true);
  });

  it("cannot jump forward when intermediate events are dropped by the emission throttle", async () => {
    const { percents, result } = await runHls({
      count: 3,
      releaseOrder: [2, 0, 1],
      clockStep: 100, // all but the first update fall inside the 2 Hz window
    });

    expect(result.tag).toBe("Ok");
    // Dropped events may hide intermediate steps, but the reported value is settled work and is
    // far below completion: the old assignment-index formula would have emitted 100 here.
    expect(percents.map((value) => Math.round(value))).toEqual([33]);
    expect(percents.every((value) => value < 100)).toBe(true);
  });
});
