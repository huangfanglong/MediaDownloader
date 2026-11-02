/**
 * A ranged transfer must not re-write the whole session once per 2 MiB chunk.
 *
 * The service-owned YouTube path fetches bounded ranges and calls `onProgress` per chunk. Both
 * session persistence and the panel only need a bounded update rate, so the number of
 * `storage.session` writes must depend on elapsed time, not on how many chunks a file has.
 */
import { describe, expect, it } from "vitest";
import type { DownloadPlan, MediaItem, TabMeta } from "../src/core/types.js";
import type { FetchLike } from "../src/transfer/fetch.js";
import type { WorkerClient } from "../src/extension/worker-client.js";
import {
  MediaDownloaderService,
  type DownloadingEntry,
  type SessionState,
} from "../src/extension/service-worker.js";
import { createFakeGateway, flush } from "./helpers/service-harness.js";

const CHUNK_BYTES = 2 * 1024 * 1024;

interface WorkerProbe {
  client: WorkerClient;
  sentChunks: number;
  ended: boolean;
}

function fakeWorker(plan: DownloadPlan): WorkerProbe {
  let resolveOutcome: ((value: unknown) => void) | undefined;
  const probe: WorkerProbe = {
    sentChunks: 0,
    ended: false,
    client: {
      streamDownload: () =>
        new Promise<unknown>((resolve) => {
          resolveOutcome = resolve;
        }),
      sendRelayChunk: () => {
        probe.sentChunks += 1;
      },
      endRelay: () => {
        probe.ended = true;
        resolveOutcome?.({
          download_id: plan.download_id,
          internal_bloburl: "blob:ranged",
          ending_reason: {
            user_abort: false,
            e4XX_5XX_failure: false,
            percentage_incomplete: false,
            other_failure: false,
          },
        });
      },
      cancel: () => undefined,
      abortRelay: () => undefined,
      revokeBlobUrl: () => undefined,
      dispose: () => undefined,
    } as unknown as WorkerClient,
  };
  return probe;
}

function rangedFetch(payload: Uint8Array, advance: () => void): FetchLike {
  return async (_url, init) => {
    advance();
    const range = new Headers(init?.headers).get("range");
    const match = range === null ? null : /^bytes=(\d+)-(\d+)$/u.exec(range);
    if (match === null) return { status: 403, ok: false, body: null };
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), payload.length - 1);
    if (start >= payload.length) return { status: 416, ok: false, body: null };
    const slice = payload.slice(start, end + 1);
    let sent = false;
    return {
      status: 206,
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: slice };
          },
          cancel: async () => undefined,
        }),
      },
    };
  };
}

function makePlan(payload: Uint8Array, declaredBytes = payload.byteLength): DownloadPlan {
  return {
    download_id: "download_budget",
    headers: new Headers(),
    good_basename: "budget clip",
    subdir: "Media Downloader",
    save_as: false,
    will_use_jsfetch: false,
    strategy: "youtube_audio_video_one_source",
    url: new URL(
      `https://rr1---sn-budget.googlevideo.com/videoplayback?id=1&clen=${declaredBytes}`,
    ),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    is_youtube: true,
    throttle: true,
    cache: "default",
  } as unknown as DownloadPlan;
}

function downloadingEntry(plan: DownloadPlan): DownloadingEntry {
  return {
    bitrate: 0,
    status: "downloading",
    download_args: plan,
    media: { sent_headers: new Headers() } as unknown as MediaItem,
    meta: {} as TabMeta,
    percent: 0,
    fetched_bytes_count: 0,
  };
}

interface RunResult {
  writes: Array<{ at: number; bytes: number }>;
  sentChunks: number;
  ended: boolean;
  error?: string;
}

async function runRanged(chunks: number, declaredChunks = chunks, extraBytes = 0): Promise<RunResult> {
  const payload = new Uint8Array(CHUNK_BYTES * chunks + extraBytes);
  const plan = makePlan(payload, CHUNK_BYTES * declaredChunks);
  const nowRef = { value: 1_000_000 };
  const advance = (): void => {
    // Each chunk takes 50 ms of wall clock; 8 chunks stay inside one checkpoint window and 32
    // chunks cross several 500 ms progress windows.
    nowRef.value += 50;
  };
  const gateway = createFakeGateway("https://www.youtube.com/watch?v=abc", new Map());
  const writes: Array<{ at: number; bytes: number }> = [];
  const originalSet = gateway.storage.session.set;
  gateway.storage.session.set = async (record) => {
    let bytes = 0;
    for (const value of Object.values(record)) bytes += JSON.stringify(value).length;
    writes.push({ at: nowRef.value, bytes });
    await originalSet(record);
  };
  const worker = fakeWorker(plan);
  const service = new MediaDownloaderService({
    gateway,
    fetchImpl: rangedFetch(payload, advance),
    now: () => nowRef.value,
    downloadIdFactory: () => plan.download_id,
    workerClient: worker.client,
  });
  const session: SessionState = {
    current_win_tab: { tab_id: 7 },
    discovered: new Map(),
    downloading: new Map([[plan.download_id, downloadingEntry(plan)]]),
    notifications: new Map(),
    transient_history: [],
  };
  (service as unknown as { session: SessionState }).session = session;
  const outcome = (await (
    service as unknown as {
      rangedDownloadThroughWorker(
        plan: DownloadPlan,
        signal: AbortSignal,
      ): Promise<{ tag: string; error?: string }>;
    }
  ).rangedDownloadThroughWorker(plan, new AbortController().signal)) as { tag: string; error?: string };
  for (let index = 0; index < 5; index += 1) await flush();
  service.stop();
  return {
    writes,
    sentChunks: worker.sentChunks,
    ended: worker.ended,
    ...(outcome.tag === "Err" && outcome.error !== undefined ? { error: outcome.error } : {}),
  };
}

describe("ranged transfer session-write budget", () => {
  it("does not persist the session once per chunk", async () => {
    const eight = await runRanged(8);
    const thirtyTwo = await runRanged(32);

    expect(eight.sentChunks).toBe(8);
    expect(thirtyTwo.sentChunks).toBe(32);
    expect(eight.ended).toBe(true);
    expect(thirtyTwo.ended).toBe(true);

    // Writes are time-bounded: a 400 ms transfer and a 1600 ms transfer both stay inside a single
    // checkpoint window, so their write counts must match and stay tiny.
    expect(thirtyTwo.writes.length).toBe(eight.writes.length);
    expect(thirtyTwo.writes.length).toBeLessThanOrEqual(2);

    // And they are full-session writes, not per-chunk copies of each other.
    const sizes = new Set(thirtyTwo.writes.map((write) => write.bytes));
    expect(sizes.size).toBeLessThanOrEqual(1);
  });

  it("fails instead of finishing when the object is shorter than clen", async () => {
    // The object ends with a short chunk after 2 MiB + 123 bytes; the URL advertises 4 MiB.
    const result = await runRanged(1, 2, 123);
    expect(result.error).toMatch(/ended early/);
    // The worker never received the end marker, so it cannot save a truncated file.
    expect(result.ended).toBe(false);
  });
});
