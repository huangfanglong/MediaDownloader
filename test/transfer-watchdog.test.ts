/**
 * The transfer budget must be silence, not wall-clock (regression guard).
 *
 * A healthy slow download that keeps reporting progress must never be killed by a fixed budget —
 * the budget only exists so a transfer with NO reports (a hung fetch, a dead worker) is torn down
 * instead of running forever. Remuxing follows the same contract: FFmpeg emits log lines only
 * while it actually advances, so they are the liveness channel during the silent remux phase.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService } from "../src/extension/service-worker.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import type { WorkerClient } from "../src/extension/worker-client.js";
import { itemFromHint } from "../src/extension/content-script.js";
import { createStagedFile } from "../src/extension/staging.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { encode } from "../src/protocol/serde.js";
import type { Envelope } from "../src/extension/gateways.js";
import type { DownloadPlan, DownloadProgress, MediaItem, TabMeta } from "../src/core/types.js";
import type { FetchLike, FetchResponseLike } from "../src/transfer/fetch.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";
import { createFakeGateway, flush } from "./helpers/service-harness.js";

const PAGE_URL = "https://www.youtube.com/watch?v=abc";
const CHUNK_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_ID = "download_watchdog";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function rangedResponse(bytes: Uint8Array, start: number, total: number): FetchResponseLike {
  const end = start + bytes.byteLength;
  return {
    status: start === 0 && end === total ? 200 : 206,
    ok: true,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-range" ? `bytes ${start}-${end - 1}/${total}` : null,
    },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: bytes };
          },
          cancel: async () => undefined,
        };
      },
    },
  };
}

/** Every range request answers after `gapMs`, until `totalChunks` chunks have been served. */
function chunkCadenceWithGap(gapMs: number, totalChunks: number): FetchLike {
  let calls = 0;
  return async (_url, init) => {
    calls += 1;
    const total = totalChunks * CHUNK_BYTES;
    if (calls > totalChunks) return { status: 200, ok: true, body: null } as FetchResponseLike;
    const range = new Headers(init?.headers).get("range") ?? "bytes=0-";
    const start = Number(/bytes=(\d+)-/u.exec(range)?.[1] ?? 0);
    await new Promise((resolve) => setTimeout(resolve, gapMs));
    return rangedResponse(new Uint8Array(CHUNK_BYTES).fill(calls), start, total);
  };
}

/** First chunk succeeds; every later request stalls until the abort signal rejects it. */
function stallsAfterFirstChunk(): FetchLike {
  let calls = 0;
  return async (_url, init) => {
    calls += 1;
    if (calls === 1) {
      return rangedResponse(new Uint8Array(CHUNK_BYTES).fill(1), 0, 5 * CHUNK_BYTES);
    }
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
  };
}

interface WorkerProbe {
  streams: number;
  cancels: number;
  aborts: number;
  relayAborts: number;
}

function fakeWorker(): { probe: WorkerProbe; client: WorkerClient } {
  const probe: WorkerProbe = { streams: 0, cancels: 0, aborts: 0, relayAborts: 0 };
  let resolveFirst: ((value: unknown) => void) | undefined;
  const client = {
    streamDownload: () => {
      probe.streams += 1;
      if (probe.streams === 1) {
        return new Promise<unknown>((resolve) => {
          resolveFirst = resolve;
        });
      }
      // The page-relay retry has no producer in this test; resolve without a blob so it errors
      // out immediately instead of waiting.
      return Promise.resolve({ download_id: DOWNLOAD_ID });
    },
    sendRelayChunk: () => undefined,
    endRelay: () => resolveFirst?.({ download_id: DOWNLOAD_ID, internal_bloburl: "blob:liveness" }),
    abortRelay: () => {
      probe.relayAborts += 1;
    },
    cancel: () => {
      probe.cancels += 1;
    },
    abort: () => {
      probe.aborts += 1;
    },
    revokeBlobUrl: () => undefined,
    dispose: () => undefined,
    isReady: () => true,
    ensureReady: async () => undefined,
  } as unknown as WorkerClient;
  return { probe, client };
}

function makeService(
  gateway: ReturnType<typeof createFakeGateway>,
  fetchImpl: FetchLike,
  worker: WorkerClient,
  transferDeadlineMs: number,
): MediaDownloaderService {
  return new MediaDownloaderService({
    gateway,
    fetchImpl,
    opfsRoot: async () => createFakeOpfs().root,
    downloadIdFactory: () => DOWNLOAD_ID,
    now: () => 1_700_000_000_000,
    workerClient: worker,
    transferDeadlineMs,
  });
}

function rangedPlan(): DownloadPlan {
  return {
    download_id: DOWNLOAD_ID,
    headers: new Headers(),
    good_basename: "watchdog",
    subdir: "",
    save_as: false,
    will_use_jsfetch: false,
    strategy: "http_audio_video_one_source",
    url: new URL(
      `https://rr1---sn-x.googlevideo.com/videoplayback?id=abc&itag=18&clen=${5 * CHUNK_BYTES}`,
    ),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    is_youtube: true,
    throttle: true,
    cache: "default",
  } as DownloadPlan;
}

type AttemptHarness = {
  executeDownloadAttempt(
    plan: DownloadPlan,
    media: MediaItem,
    meta: TabMeta,
    signal: AbortSignal,
  ): Promise<{ tag: string; error?: string }>;
  transferAborts: Map<string, AbortController>;
};

describe("the transfer budget is silence, not wall-clock", () => {
  it("lets a slow but progressing transfer outlive the no-progress window", async () => {
    vi.useFakeTimers();
    const gateway = createFakeGateway(PAGE_URL, new Map());
    const worker = fakeWorker();
    const service = makeService(gateway, chunkCadenceWithGap(20, 5), worker.client, 50);
    await service.start();
    const controller = new AbortController();
    const harness = service as unknown as AttemptHarness;
    harness.transferAborts.set(DOWNLOAD_ID, controller);

    const pending = harness.executeDownloadAttempt(
      rangedPlan(),
      { sent_headers: new Headers() } as unknown as MediaItem,
      {} as TabMeta,
      controller.signal,
    );
    // 5 chunks, one every 20 ms: the transfer runs ~100 ms, twice the 50 ms window, reporting
    // all the way. The silence window must re-arm on each report instead of firing mid-flight.
    for (let i = 0; i < 14; i += 1) {
      await vi.advanceTimersByTimeAsync(20);
    }
    const result = await pending;

    expect(result.tag).toBe("Ok");
    // The browser save actually happened — the transfer was never torn down.
    expect(gateway.downloadRequestsLog.length).toBeGreaterThan(0);
    service.stop();
  }, 60_000);

  it("still kills a transfer that reports nothing while it runs (hung fetch)", async () => {
    const gateway = createFakeGateway(PAGE_URL, new Map());
    const worker = fakeWorker();
    const service = makeService(gateway, stallsAfterFirstChunk(), worker.client, 50);
    const controller = new AbortController();
    const harness = service as unknown as AttemptHarness;
    harness.transferAborts.set(DOWNLOAD_ID, controller);
    const result = await Promise.race([
      harness.executeDownloadAttempt(
        rangedPlan(),
        { sent_headers: new Headers() } as unknown as MediaItem,
        {} as TabMeta,
        controller.signal,
      ),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    await flush();
    await flush();

    expect(result).not.toBe("hung");
    if (result === "hung") return;
    expect(result.tag).toBe("Err");
    expect(result.error).toBe("transfer timed out");
    // The silence teardown aborts the service-owned work and the worker relay staging.
    expect(worker.probe.cancels).toBeGreaterThan(0);
    expect(worker.probe.aborts).toBeGreaterThan(0);
    expect(gateway.downloadRequestsLog).toHaveLength(0);
    service.stop();
  });
});

// ---------------------------------------------------------------------------
// Remux liveness: ffmpeg log lines are genuine progress reports.
// ---------------------------------------------------------------------------

const REMUX_FIXTURE = new Map<string, string | Uint8Array>([
  [
    "https://cdn.test/media.m3u8",
    "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n0.ts\n#EXTINF:4,\n1.ts\n#EXT-X-ENDLIST\n",
  ],
  ["https://cdn.test/0.ts", new Uint8Array(600).fill(1)],
  ["https://cdn.test/1.ts", new Uint8Array(600).fill(2)],
]);

function remuxPlan(id: string): DownloadPlan {
  return {
    download_id: id,
    headers: new Headers(),
    good_basename: "hls",
    subdir: "",
    save_as: false,
    will_use_jsfetch: false,
    strategy: "m3u8_audio_video_one_source",
    url: new URL("https://cdn.test/media.m3u8"),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    output_format: "mp4",
    is_youtube: false,
    throttle: false,
    cache: "default",
  } as DownloadPlan;
}

function progressCapturingWorker(ffmpeg: unknown): {
  progress: DownloadProgress[];
  worker: DownloadWorker;
} {
  const progress: DownloadProgress[] = [];
  const worker = new DownloadWorker({
    channel: {
      postMessage: (message: unknown) => {
        const data = (message as { msg?: { name?: string; data?: { progress?: DownloadProgress } } })
          .msg;
        if (data?.name === "download_progress" && data.data?.progress !== undefined) {
          progress.push(data.data.progress);
        }
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      close: () => undefined,
    } as unknown as BroadcastChannelLike,
    fetchImpl: createFetch(REMUX_FIXTURE),
    openRoot: async () => createFakeOpfs().root,
    ffmpeg: ffmpeg as never,
  });
  return { progress, worker };
}

describe("remux keeps reporting while ffmpeg advances", () => {
  it("turns an ffmpeg log line into living progress for the plan being remuxed", async () => {
    let enteredStaging = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { root } = createFakeOpfs();
    const runner = {
      run: async (): Promise<Uint8Array> => new Uint8Array(2048).fill(9),
      runToStaging: async (
        _job: unknown,
        target: { root: typeof root; directory: string; filename: string },
      ) => {
        enteredStaging += 1;
        const staged = await createStagedFile(target.root, target.filename);
        await staged.append(new Uint8Array(2048).fill(5));
        await staged.finish();
        await held;
      },
    };
    const { progress, worker } = progressCapturingWorker(runner);

    const running = worker.runPlan(remuxPlan("download_remux_liveness"));
    for (let i = 0; i < 400 && enteredStaging === 0; i += 1) await flush();
    expect(enteredStaging).toBe(1);
    const before = progress.length;

    // While the remux job is in flight, an ffmpeg advancement line is living progress.
    worker.onFfmpegLog("frame= 1000 fps= 60 time=00:00:41.00");
    const fresh = progress.slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.status).toBe("finalizing");

    release();
    const result = await running;
    expect(result.tag).toBe("Ok");
  }, 60_000);

  it("emits nothing while no plan owns the ffmpeg runner", async () => {
    const { progress, worker } = progressCapturingWorker({
      run: async (): Promise<Uint8Array> => new Uint8Array(8).fill(1),
    });
    worker.onFfmpegLog("frame= 1 time=00:00:00.01");
    expect(progress).toHaveLength(0);
  });
});

/** E2E smoke: the watchdog re-arms on progress that arrives through the real pipeline. */
describe("watchdog through the panel path", () => {
  it("survives a slow download end to end and records success", async () => {
    const gateway = createFakeGateway(PAGE_URL, new Map());
    const worker = fakeWorker();
    const service = makeService(gateway, chunkCadenceWithGap(20, 5), worker.client, 50);
    await service.start();
    const url = `https://rr1---sn-x.googlevideo.com/videoplayback?id=ok&itag=18&clen=${5 * CHUNK_BYTES}`;
    const hinted = itemFromHint({ url, source: "player-response", kind: "file" }, PAGE_URL) as MediaItem;
    await gateway.deliverToService({
      msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(hinted) } },
      channel: Channel.FromInjectedToService,
    } as Envelope);
    await gateway.deliverToService({
      msg: { name: MSG.contentToService.DoDownload, data: { tab_id: 7, media_hash: hinted.hash } },
      channel: Channel.FromContentToService,
    } as Envelope);

    // Five chunks land at ~20 ms each: the whole transfer runs ~100 ms, twice the 50 ms
    // wall-clock used to kill mid-flight; only the silence window may decide.
    let settled = false;
    for (let i = 0; i < 40 && !settled; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = service.getSession().transient_history.length > 0;
    }
    expect(settled).toBe(true);
    expect(gateway.downloadRequestsLog.length).toBeGreaterThan(0);
    const failures = [...service.getSession().notifications.values()].filter(
      (n) => n.type === "download_error",
    );
    expect(failures).toHaveLength(0);
    service.stop();
  }, 60_000);
});
