/**
 * A service-worker restart keeps `storage.session` but loses the queue tasks and worker
 * correlations that owned in-flight downloads. A restored session must not present that dead work
 * as an active transfer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MediaDownloaderService,
  SESSION_KEY,
  reconcileRestoredSession,
  type DownloadingEntry,
  type SessionState,
} from "../src/extension/service-worker.js";
import { statusPresentation } from "../src/extension/panel-status.js";
import { WorkerClient } from "../src/extension/worker-client.js";
import { itemFromHint } from "../src/extension/content-script.js";
import { composeFilename } from "../src/transfer/save.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { decode, encode } from "../src/protocol/serde.js";
import type { Envelope } from "../src/extension/gateways.js";
import type { MediaItem } from "../src/core/types.js";
import { createFakeOpfs } from "./helpers/transfer-fakes.js";
import { FakeChannelHub, createFakeGateway, flush } from "./helpers/service-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type KeepAliveInternals = { keepAliveTimer?: ReturnType<typeof setInterval> };

function makeService(gateway: ReturnType<typeof createFakeGateway>): MediaDownloaderService {
  return new MediaDownloaderService({
    gateway,
    fetchImpl: async () => ({ status: 404, ok: false, body: null }),
    opfsRoot: async () => createFakeOpfs().root,
    now: () => 1_700_000_000_000,
    workerClient: new WorkerClient({
      channel: new FakeChannelHub().endpoint("service"),
      offscreen: gateway.offscreen,
      offscreenUrl: "chrome-extension://fake/factory/factory.html",
      readyTimeoutMs: 500,
    }),
  });
}

function clearKeepAlive(service: MediaDownloaderService): void {
  const internals = service as unknown as KeepAliveInternals;
  if (internals.keepAliveTimer !== undefined) {
    clearInterval(internals.keepAliveTimer);
    internals.keepAliveTimer = undefined;
  }
}

/**
 * Persist one real in-flight download the way a killed worker leaves it: the status change is
 * written, byte work never starts. Returns the exact payload `storage.session` held.
 */
async function captureStoredInFlightSession(): Promise<{
  raw: unknown;
  downloadId: string;
  filename: string;
}> {
  const gateway = createFakeGateway("https://site.test/watch", new Map());
  const service = makeService(gateway);
  await service.start();
  const item = itemFromHint(
    { url: "https://cdn.test/direct.mp4", source: "player-response", kind: "file" },
    "https://site.test/watch",
  );
  if (item === undefined) throw new Error("the hint should produce a media item");
  await gateway.deliverToService({
    msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(item) } },
    channel: Channel.FromInjectedToService,
  } as Envelope);
  // Freeze the transfer after its status is recorded but before any bytes are fetched.
  gateway.network.updateSessionRules = () => new Promise<void>(() => undefined);
  await gateway.deliverToService({
    msg: { name: MSG.contentToService.DoDownload, data: { tab_id: 7, media_hash: item.hash } },
    channel: Channel.FromContentToService,
  } as Envelope);

  let raw: unknown;
  let downloadId = "";
  let filename = "";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const stored = (await gateway.storage.session.get(SESSION_KEY)) as Record<string, unknown>;
    const encodedSession = stored[SESSION_KEY];
    if (encodedSession !== undefined) {
      const session = decode(encodedSession) as SessionState;
      const first = [...session.downloading.entries()][0];
      if (first !== undefined) {
        raw = encodedSession;
        downloadId = first[0];
        filename = composeFilename(first[1].download_args);
        if (first[1].status === "downloading") break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  clearKeepAlive(service);
  service.stop();
  if (raw === undefined) throw new Error("no in-flight download was persisted");
  return { raw, downloadId, filename };
}

/** A fresh extension context with the same browser-session storage contents. */
async function seedRestartedWorker(raw: unknown): Promise<ReturnType<typeof createFakeGateway>> {
  const gateway = createFakeGateway("https://site.test/watch", new Map());
  await gateway.storage.session.set({ [SESSION_KEY]: raw });
  return gateway;
}

const restoredEntry = (downloadId: string): DownloadingEntry =>
  ({ download_args: { download_id: downloadId } }) as unknown as DownloadingEntry;

const sessionWith = (downloads: Array<[string, DownloadingEntry]>): SessionState =>
  ({
    current_win_tab: { tab_id: 7 },
    discovered: new Map(),
    downloading: new Map(downloads),
    notifications: new Map([["notice", { type: "tos" }]]),
    transient_history: [],
  }) as unknown as SessionState;

describe("reconcileRestoredSession", () => {
  it("detaches rows owned by the previous worker and keeps the rest of the session", () => {
    const session = sessionWith([
      ["a", restoredEntry("a")],
      ["b", restoredEntry("b")],
    ]);
    const reconciled = reconcileRestoredSession(session);
    expect(reconciled.session.downloading.size).toBe(0);
    expect(reconciled.interrupted.map((entry) => entry.download_args.download_id)).toEqual(["a", "b"]);
    expect(reconciled.session.notifications).toBe(session.notifications);
    expect(reconciled.session.current_win_tab).toEqual({ tab_id: 7 });
    // The decoded session itself is not mutated.
    expect(session.downloading.size).toBe(2);
  });

  it("returns a session with nothing in flight unchanged", () => {
    const session = sessionWith([]);
    expect(reconcileRestoredSession(session)).toEqual({ session, interrupted: [] });
  });
});

describe("session restore after a worker restart", () => {
  it("reports a download left over from the previous worker as interrupted instead of active", async () => {
    const captured = await captureStoredInFlightSession();
    const gateway = await seedRestartedWorker(captured.raw);
    const service = makeService(gateway);
    await service.start();
    await flush();

    // The dead row is gone, not restored as live work.
    expect(service.getSession().downloading.size).toBe(0);
    const snapshot = service.panelSnapshot();
    expect(snapshot.downloading).toEqual([]);
    expect(service.getQueue().getStats()).toMatchObject({ running: 0, pending: 0 });

    // The user is told which download died; the panel maps the type to "Download interrupted".
    const notifications = [...service.getSession().notifications.values()];
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "download_interrupted",
      message: captured.filename,
    });
    const presentation = statusPresentation(snapshot.downloading, snapshot.notifications);
    expect(presentation).toMatchObject({ tone: "error", label: "Download interrupted" });
    expect(gateway.badgeTextLog.at(-1)).toBe("1");

    // The cleaned session is what the next restart will restore.
    const stored = (await gateway.storage.session.get(SESSION_KEY)) as Record<string, unknown>;
    const persisted = decode(stored[SESSION_KEY]) as SessionState;
    expect(persisted.downloading.size).toBe(0);
    expect([...persisted.notifications.values()].map((notification) => notification.type)).toEqual([
      "download_interrupted",
    ]);

    service.stop();
  });

  it("does not keep the worker alive for work that no longer exists", async () => {
    const captured = await captureStoredInFlightSession();
    const gateway = await seedRestartedWorker(captured.raw);
    const keepAlive = vi.spyOn(gateway.runtime, "keepAlive");

    vi.useFakeTimers();
    const service = makeService(gateway);
    await service.start();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    await Promise.resolve();
    expect(keepAlive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(keepAlive).not.toHaveBeenCalled();

    vi.clearAllTimers();
    vi.useRealTimers();
    service.stop();
  });
});
