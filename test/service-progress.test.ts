/**
 * The 2 Hz progress contract is enforced on receipt, not only by the worker that emits it.
 *
 * Evidence for the rule: `core/types.ts` promises at most two `downloading` updates per second.
 * The browser-side ranged loop used to call `onProgress` once per 2 MiB chunk, which made the
 * service push and persist at chunk rate.
 */
import { describe, expect, it } from "vitest";
import type { DownloadPlan, DownloadProgress, MediaItem, TabMeta } from "../src/core/types.js";
import type { WorkerClient } from "../src/extension/worker-client.js";
import { REBUILD_MESSAGES } from "../src/protocol/rebuild-messages.js";
import {
  MediaDownloaderService,
  type DownloadingEntry,
  type SessionState,
} from "../src/extension/service-worker.js";
import { createFakeGateway, flush, type FakeGateway } from "./helpers/service-harness.js";

function stubWorker(): WorkerClient {
  return {
    download: async () => {
      throw new Error("worker not used");
    },
    streamDownload: async () => {
      throw new Error("worker not used");
    },
    sendRelayChunk: () => undefined,
    endRelay: () => undefined,
    abortRelay: () => undefined,
    cancel: () => undefined,
    abort: () => undefined,
    revokeBlobUrl: () => undefined,
    dispose: () => undefined,
  } as unknown as WorkerClient;
}

function downloadingEntry(downloadId: string): DownloadingEntry {
  const plan = {
    download_id: downloadId,
    headers: new Headers(),
    good_basename: "clip",
    subdir: "Media Downloader",
    save_as: false,
    will_use_jsfetch: false,
    strategy: "youtube_audio_video_one_source",
    url: new URL("https://rr1---sn-abc.googlevideo.com/videoplayback?clen=100"),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    is_youtube: true,
    throttle: false,
    cache: "default",
  } as unknown as DownloadPlan;
  return {
    bitrate: 0,
    status: "queuing",
    download_args: plan,
    media: { sent_headers: new Headers() } as unknown as MediaItem,
    meta: {} as TabMeta,
  };
}

function createService(nowRef: { value: number }): {
  gateway: FakeGateway;
  service: MediaDownloaderService;
  session: SessionState;
  progress: (downloadId: string, progress: DownloadProgress) => void;
} {
  const gateway = createFakeGateway("https://www.youtube.com/watch?v=abc", new Map());
  const service = new MediaDownloaderService({
    gateway,
    fetchImpl: async () => ({ status: 200, ok: true, body: null }) as never,
    now: () => nowRef.value,
    downloadIdFactory: () => "download_test",
    workerClient: stubWorker(),
  });
  const session: SessionState = {
    current_win_tab: { tab_id: 7 },
    discovered: new Map(),
    downloading: new Map(),
    notifications: new Map(),
    transient_history: [],
  };
  (service as unknown as { session: SessionState }).session = session;
  return {
    gateway,
    service,
    session,
    progress: (downloadId, progress) =>
      (
        service as unknown as {
          onProgress(id: string, update: DownloadProgress): void;
        }
      ).onProgress(downloadId, progress),
  };
}

const UPDATE = (index: number): DownloadProgress => ({
  status: "downloading",
  percent: { is_known: true, value: index + 1 },
  fetched_bytes_count: (index + 1) * 1000,
});

describe("service-side progress rate limiting", () => {
  it("applies at most one downloading update per 500 ms of wall clock", async () => {
    const nowRef = { value: 1_000_000 };
    const { service, session, progress } = createService(nowRef);
    session.downloading.set("download_rate", downloadingEntry("download_rate"));

    // Ten updates 100 ms apart: only the ones at t=0 and t=500 may land.
    for (let index = 0; index < 10; index += 1) {
      nowRef.value = 1_000_000 + index * 100;
      progress("download_rate", UPDATE(index));
    }
    const entry = session.downloading.get("download_rate");
    expect(entry?.fetched_bytes_count).toBe(6000);
    expect(entry?.percent).toBe(6);
    await flush();
    service.stop();
  });

  it("still applies finalizing immediately inside the throttle window", async () => {
    const nowRef = { value: 2_000_000 };
    const { service, session, progress } = createService(nowRef);
    session.downloading.set("download_final", downloadingEntry("download_final"));

    progress("download_final", UPDATE(0));
    nowRef.value += 100;
    progress("download_final", { status: "finalizing" });
    expect(session.downloading.get("download_final")?.status).toBe("finalizing");
    await flush();
    service.stop();
  });

  it("throttles each download independently", async () => {
    const nowRef = { value: 3_000_000 };
    const { service, session, progress } = createService(nowRef);
    session.downloading.set("download_a", downloadingEntry("download_a"));
    session.downloading.set("download_b", downloadingEntry("download_b"));

    progress("download_a", UPDATE(0));
    progress("download_b", UPDATE(4));
    expect(session.downloading.get("download_a")?.fetched_bytes_count).toBe(1000);
    expect(session.downloading.get("download_b")?.fetched_bytes_count).toBe(5000);
    await flush();
    service.stop();
  });
});

describe("publication cost dedupe", () => {
  it("skips badge API calls when the badge did not change", async () => {
    const nowRef = { value: 4_000_000 };
    const { gateway, service } = createService(nowRef);
    let backgroundCalls = 0;
    let textColorCalls = 0;
    const originalBackground = gateway.action.setBadgeBackgroundColor;
    gateway.action.setBadgeBackgroundColor = async (details) => {
      backgroundCalls += 1;
      await originalBackground(details);
    };
    const originalTextColor = gateway.action.setBadgeTextColor;
    gateway.action.setBadgeTextColor = async (details) => {
      textColorCalls += 1;
      await originalTextColor(details);
    };

    await service.publish();
    await service.publish();
    expect(gateway.badgeTextLog).toEqual([""]);
    expect(backgroundCalls).toBe(0);
    expect(textColorCalls).toBe(0);

    // A real change updates all three parts exactly once and is then cached again.
    const session = (service as unknown as { session: SessionState }).session;
    session.notifications.set("notification_1", { type: "download_error", message: "failed" });
    await service.publish();
    await service.publish();
    expect(gateway.badgeTextLog).toEqual(["", "1"]);
    expect(backgroundCalls).toBe(1);
    expect(textColorCalls).toBe(1);
    service.stop();
  });

  it("does not rebuild and push an unchanged snapshot", async () => {
    const nowRef = { value: 5_000_000 };
    const { gateway, service } = createService(nowRef);
    const pushes = (): number =>
      gateway.contentSends.filter((envelope) => envelope.msg.name === REBUILD_MESSAGES.SessionSnapshot).length;

    await service.publish();
    expect(pushes()).toBe(1);
    // Identical content is not re-sent, however much time passed in between.
    await service.publish();
    expect(pushes()).toBe(1);
    nowRef.value += 300;
    await service.publish();
    expect(pushes()).toBe(1);

    nowRef.value += 10;
    const session = (service as unknown as { session: SessionState }).session;
    session.notifications.set("notification_2", { type: "download_error", message: "failed" });
    await service.publish(); // structural change pushes immediately
    expect(pushes()).toBe(2);
    await service.publish();
    expect(pushes()).toBe(2);
    service.stop();
  });
});
