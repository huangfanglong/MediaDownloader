/**
 * Ranged downloads must report the same 0..100 percentage as the worker paths and the
 * panel. The browser-side loop used to send `offset / total` (0..1), so the panel rounded every
 * update to 0 or 1 per cent for the whole transfer.
 */
import { describe, expect, it } from "vitest";
import type { DownloadPlan, DownloadProgress, MediaItem, TabMeta } from "../src/core/types.js";
import type { FetchLike } from "../src/transfer/fetch.js";
import type { WorkerClient } from "../src/extension/worker-client.js";
import {
  MediaDownloaderService,
  type DownloadingEntry,
  type SessionState,
} from "../src/extension/service-worker.js";
import { statusPresentation } from "../src/extension/panel-status.js";
import { createFakeGateway, flush } from "./helpers/service-harness.js";

const CHUNK_BYTES = 2 * 1024 * 1024;

function rangedFetch(payload: Uint8Array, advance: () => void): FetchLike {
  return async (_url, init) => {
    advance();
    const range = new Headers(init?.headers).get("range");
    const match = range === null ? null : /^bytes=(\d+)-(\d+)$/u.exec(range);
    if (match === null) return { status: 403, ok: false, body: null };
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), payload.length - 1);
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

function makePlan(payload: Uint8Array): DownloadPlan {
  return {
    download_id: "download_u11",
    headers: new Headers(),
    good_basename: "u11 clip",
    subdir: "Media Downloader",
    save_as: false,
    will_use_jsfetch: false,
    strategy: "youtube_audio_video_one_source",
    url: new URL(`https://rr1---sn-u11.googlevideo.com/videoplayback?id=1&clen=${payload.byteLength}`),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    is_youtube: true,
    throttle: true,
    cache: "default",
  } as unknown as DownloadPlan;
}

function entryFor(plan: DownloadPlan): DownloadingEntry {
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

function stubWorker(plan: DownloadPlan): WorkerClient {
  let resolve: ((value: unknown) => void) | undefined;
  return {
    streamDownload: () => new Promise<unknown>((settle) => (resolve = settle)),
    sendRelayChunk: () => undefined,
    endRelay: () => resolve?.({ download_id: plan.download_id, internal_bloburl: "blob:u11" }),
    cancel: () => undefined,
    abortRelay: () => undefined,
    revokeBlobUrl: () => undefined,
    dispose: () => undefined,
  } as unknown as WorkerClient;
}

interface RangedProgressResult {
  emitted: number[];
  storedPercent: number | undefined;
  storedBytes: number | undefined;
}

async function runRanged(chunks: number): Promise<RangedProgressResult> {
  const payload = new Uint8Array(CHUNK_BYTES * chunks);
  const plan = makePlan(payload);
  const nowRef = { value: 1_000_000 };
  const gateway = createFakeGateway("https://www.youtube.com/watch?v=abc", new Map());
  const service = new MediaDownloaderService({
    gateway,
    fetchImpl: rangedFetch(payload, () => {
      // One accepted update per chunk: the service enforces the documented 2 Hz contract.
      nowRef.value += 500;
    }),
    now: () => nowRef.value,
    downloadIdFactory: () => plan.download_id,
    workerClient: stubWorker(plan),
  });
  const session: SessionState = {
    current_win_tab: { tab_id: 7 },
    discovered: new Map(),
    downloading: new Map([[plan.download_id, entryFor(plan)]]),
    notifications: new Map(),
    transient_history: [],
  };
  (service as unknown as { session: SessionState }).session = session;

  const emitted: number[] = [];
  const originalProgress = (
    service as unknown as { onProgress(id: string, progress: DownloadProgress): void }
  ).onProgress.bind(service);
  (service as unknown as { onProgress(id: string, progress: DownloadProgress): void }).onProgress = (
    id,
    progress,
  ) => {
    if (progress.percent?.is_known === true) emitted.push(progress.percent.value);
    originalProgress(id, progress);
  };

  await (
    service as unknown as {
      rangedDownloadThroughWorker(plan: DownloadPlan, signal: AbortSignal): Promise<unknown>;
    }
  ).rangedDownloadThroughWorker(plan, new AbortController().signal);
  for (let index = 0; index < 5; index += 1) await flush();
  service.stop();

  const stored = session.downloading.get(plan.download_id);
  return {
    emitted,
    storedPercent: stored?.percent,
    storedBytes: stored?.fetched_bytes_count,
  };
}

describe("ranged transfer progress scale", () => {
  it("reports percentages that the panel can render", async () => {
    const result = await runRanged(4);
    expect(result.emitted).toEqual([25, 50, 75, 99]);
    expect(result.storedPercent).toBe(99);
    expect(result.storedBytes).toBe(4 * CHUNK_BYTES);
  });

  it("renders a real progress bar mid-transfer and at the last chunk", async () => {
    const result = await runRanged(4);
    const [, half, , last] = result.emitted;
    expect(half).toBe(50);
    expect(last).toBe(99);

    const mid = statusPresentation([{ download_id: "download_u11", status: "downloading", percent: half }], []);
    expect(mid.detail).toContain("50% complete");
    expect(mid.percent).toBe(50);

    const nearEnd = statusPresentation(
      [{ download_id: "download_u11", status: "downloading", percent: last }],
      [],
    );
    expect(nearEnd.detail).toContain("99% complete");
    expect(nearEnd.percent).toBe(99);
  });

  it("stays in progress (99) instead of claiming completion while saving", async () => {
    const result = await runRanged(2);
    expect(result.emitted).toEqual([50, 99]);
    expect(result.storedPercent).toBe(99);
  });
});
