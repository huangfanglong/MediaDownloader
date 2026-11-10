/**
 * The save phase must wait for the browser to settle.
 *
 * `waitForDownload` must never treat a still-running `in_progress` browser download as a terminal
 * failure: the staged OPFS file and the blob URL back the actual PC write while the item runs.
 * A settled snapshot (`complete` / `interrupted` / removed item) is the only thing that may
 * resolve the wait.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService, type SessionState } from "../src/extension/service-worker.js";
import { MSG, makeContentToServiceEnvelope } from "../src/protocol/messages.js";
import {
  createHarness,
  doDownloadEnvelope,
  fmp4MediaPlaylist,
  masterPlaylist,
  sniffDetails,
} from "./helpers/service-harness.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const FIXTURE = {
  masterUrl: "https://cdn.test/master.m3u8",
  mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
  mediaPlaylist: fmp4MediaPlaylist,
  segmentPrefix: "https://cdn.test/1080/",
  segments: 3,
  initBytes: "INIT",
} as const;

/** Controlled downloads fake: the test decides when (and whether) the item settles. */
function controlledDownloads() {
  const handlers = new Set<
    (delta: { id: number; state?: { current: string }; error?: { current: string } }) => void
  >();
  const items = new Map<number, { id: number; state: string; error?: string; filename?: string }>();
  const requests: Array<{ url: string; filename: string }> = [];
  const cancelled: number[] = [];
  let nextId = 100;
  const fake = {
    download: async (request: { url: string; filename: string }) => {
      const id = nextId++;
      requests.push(request);
      items.set(id, { id, state: "in_progress", filename: request.filename });
      return id;
    },
    search: async (query: { id: number }) => {
      const item = items.get(query.id);
      return item ? [item] : [];
    },
    onChanged: (handler: (delta: { id: number; state?: { current: string } }) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onDeterminingFilename: () => () => undefined,
    cancel: async (id: number) => {
      cancelled.push(id);
    },
    removeFile: async () => undefined,
    erase: async () => undefined,
  };
  return {
    items,
    requests,
    cancelled,
    emit(id: number, state: "complete" | "interrupted", error?: string) {
      const item = items.get(id);
      if (item) {
        item.state = state;
        if (error !== undefined) item.error = error;
      }
      for (const handler of handlers) {
        handler({ id, state: { current: state }, ...(error !== undefined ? { error: { current: error } } : {}) });
      }
    },
    fake,
  };
}

async function discoverStandard(harness: Awaited<ReturnType<typeof createHarness>>) {
  await harness.service.start();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:save-test");
  harness.gateway.triggerSendHeaders({
    requestId: "req-master",
    url: FIXTURE.masterUrl,
    tabId: 7,
    frameId: 0,
    type: "xmlhttprequest",
    timeStamp: 1_700_000_000_000,
    requestHeaders: [{ name: "referer", value: "https://site.test/watch" }],
  });
  await harness.gateway.triggerResponseStarted(sniffDetails(FIXTURE.masterUrl, "application/vnd.apple.mpegurl"));
  const discovered = harness.service.getSession().discovered.get(7);
  const item = [...(discovered?.media.values() ?? [])][0];
  const meta = harness.service.getSession().discovered.get(7)?.meta;
  return { item: item as NonNullable<typeof item>, meta: meta as NonNullable<typeof meta> };
}

async function waitForSavedRequest(downloads: ReturnType<typeof controlledDownloads>) {
  for (let i = 0; i < 400 && downloads.requests.length === 0; i++) {
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(downloads.requests).toHaveLength(1);
  expect(downloads.requests[0]?.url).toBe("blob:save-test");
}

/** The plan id of the single in-flight download (entries live until the save settles). */
function currentPlanId(harness: Awaited<ReturnType<typeof createHarness>>): string | undefined {
  return [...harness.service.getSession().downloading.keys()][0];
}

describe("save settle semantics ", () => {
  it("settles a user-cancelled browser save as a silent abort, not a failure", async () => {
    const harness = createHarness(FIXTURE);
    const { item, meta } = await discoverStandard(harness);
    const downloads = controlledDownloads();
    (harness.gateway as unknown as { downloads: unknown }).downloads = downloads.fake;

    vi.useFakeTimers();
    const delivery = harness.gateway.deliverToService(doDownloadEnvelope(item, meta));
    await waitForSavedRequest(downloads);
    const planId = currentPlanId(harness);
    expect(planId).toBeDefined();

    // The user discards the download in Chrome's UI mid-save.
    downloads.emit(100, "interrupted", "USER_CANCELED");
    for (let i = 0; i < 50 && harness.service.getSession().downloading.has(planId!); i++) {
      await vi.advanceTimersByTimeAsync(50);
    }

    const session = harness.service.getSession();
    expect(session.downloading.size).toBe(0);
    expect(session.transient_history).toHaveLength(0);
    expect(
      [...session.notifications.values()].some((n) => n.type === "download_error"),
    ).toBe(false);
    expect(harness.opfs.removed.has("download_test.mp4")).toBe(true);

    await delivery;
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    harness.service.stop();
  }, 60_000);

  it("stops the browser-level download when the panel cancels during the save phase", async () => {
    const harness = createHarness(FIXTURE);
    const { item, meta } = await discoverStandard(harness);
    const downloads = controlledDownloads();
    (harness.gateway as unknown as { downloads: unknown }).downloads = downloads.fake;

    vi.useFakeTimers();
    const delivery = harness.gateway.deliverToService(doDownloadEnvelope(item, meta));
    await waitForSavedRequest(downloads);
    const planId = currentPlanId(harness);
    expect(planId).toBeDefined();

    // The panel's Cancel button while the browser copy is running.
    harness.gateway.deliverToService(
      makeContentToServiceEnvelope(MSG.contentToService.AbortDownload, {
        download_id: planId!,
      }),
    );
    for (let i = 0; i < 50 && downloads.cancelled.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(downloads.cancelled).toEqual([100]);

    // Chrome confirms the cancel via the interrupted delta.
    downloads.emit(100, "interrupted", "USER_CANCELED");
    for (let i = 0; i < 50 && harness.service.getSession().downloading.has(planId!); i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    const session = harness.service.getSession();
    expect(session.transient_history).toHaveLength(0);
    expect(
      [...session.notifications.values()].some((n) => n.type === "download_error"),
    ).toBe(false);
    expect(harness.opfs.removed.has("download_test.mp4")).toBe(true);

    await delivery;
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    harness.service.stop();
  }, 60_000);

  it("records the browser's real download id in the history entry", async () => {
    const harness = createHarness(FIXTURE);
    const { item, meta } = await discoverStandard(harness);
    const downloads = controlledDownloads();
    (harness.gateway as unknown as { downloads: unknown }).downloads = downloads.fake;

    vi.useFakeTimers();
    const delivery = harness.gateway.deliverToService(doDownloadEnvelope(item, meta));
    await waitForSavedRequest(downloads);
    downloads.emit(100, "complete");
    for (let i = 0; i < 50 && harness.service.getSession().transient_history.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    const record = harness.service.getSession().transient_history[0];
    expect(record?.path).toContain("Test Page");
    expect(record?.browser_download_id).toBe(100);

    await delivery;
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    harness.service.stop();
  }, 60_000);

  it("keeps waiting (and its artifacts) while the browser item is in_progress, then records the real outcome", async () => {
    const harness = createHarness(FIXTURE);
    const { item, meta } = await discoverStandard(harness);
    const downloads = controlledDownloads();
    (harness.gateway as unknown as { downloads: unknown }).downloads = downloads.fake;
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");

    vi.useFakeTimers();
    const delivery = harness.gateway.deliverToService(doDownloadEnvelope(item, meta));
    await waitForSavedRequest(downloads);

    // Well past the old 30-minute abandon mark, the download is still running:
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(downloads.items.get(100)?.state).toBe("in_progress");
    // ... and the service must NOT have declared failure or torn down what the browser needs:
    expect(harness.opfs.files.has("download_test.mp4")).toBe(true);
    expect(harness.opfs.removed.size).toBe(0);
    expect(revokeSpy).not.toHaveBeenCalled();
    const session = harness.service.getSession();
    expect(session.downloading.has("download_test")).toBe(true);
    expect(session.transient_history).toHaveLength(0);
    expect([...session.notifications.values()].some((n) => n.type === "download_error")).toBe(false);

    // The browser finishes later; only then does the wait settle and the artifacts go.
    downloads.emit(100, "complete");
    for (let i = 0; i < 50 && harness.service.getSession().transient_history.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(downloads.items.get(100)?.state).toBe("complete");
    expect(harness.service.getSession().transient_history[0]?.path).toContain("Test Page");
    expect(harness.opfs.removed.has("download_test.mp4")).toBe(true); // staged copy cleaned AFTER settle
    expect(revokeSpy).toHaveBeenCalledWith("blob:save-test"); // blob revoked AFTER settle
    expect(
      [...harness.service.getSession().notifications.values()].some((n) => n.type === "download_error"),
    ).toBe(false);

    await delivery;
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    harness.service.stop();
  }, 60_000);

  it("settles as interrupted when the user removes the download item", async () => {
    const harness = createHarness(FIXTURE);
    const { item, meta } = await discoverStandard(harness);
    const downloads = controlledDownloads();
    (harness.gateway as unknown as { downloads: unknown }).downloads = downloads.fake;

    vi.useFakeTimers();
    const delivery = harness.gateway.deliverToService(doDownloadEnvelope(item, meta));
    await waitForSavedRequest(downloads);

    // The user deletes the item from the download manager; the next re-check notices.
    downloads.items.delete(100);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100);

    const session = harness.service.getSession();
    expect(session.downloading.has("download_test")).toBe(false);
    expect(
      [...session.notifications.values()].some(
        (n) => n.type === "download_error" && n.details === "Download interrupted.",
      ),
    ).toBe(true);
    expect(session.transient_history).toHaveLength(0);
    expect(harness.opfs.removed.has("download_test.mp4")).toBe(true);

    await delivery;
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    harness.service.stop();
  }, 60_000);

  it("survives a transient search failure instead of reporting it as interrupted", async () => {
    const harness = createHarness(FIXTURE);
    const { item, meta } = await discoverStandard(harness);
    const downloads = controlledDownloads();
    (harness.gateway as unknown as { downloads: unknown }).downloads = downloads.fake;
    let searchFailed = false;
    const realSearch = downloads.fake.search.bind(downloads.fake);
    downloads.fake.search = async (query: { id: number }) => {
      if (!searchFailed) {
        searchFailed = true;
        throw new Error("transient storage glitch");
      }
      return realSearch(query);
    };

    vi.useFakeTimers();
    const delivery = harness.gateway.deliverToService(doDownloadEnvelope(item, meta));
    await waitForSavedRequest(downloads);

    // First re-check hits the failing search; the wait must stay pending, not fail.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100);
    expect(downloads.items.get(100)?.state).toBe("in_progress");
    expect(harness.opfs.files.has("download_test.mp4")).toBe(true);
    expect(
      [...harness.service.getSession().notifications.values()].some((n) => n.type === "download_error"),
    ).toBe(false);

    // The item completes; the next tick (or onChanged) settles it as a success.
    downloads.emit(100, "complete");
    for (let i = 0; i < 50 && harness.service.getSession().transient_history.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(harness.service.getSession().transient_history[0]?.path).toContain("Test Page");

    await delivery;
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    harness.service.stop();
  }, 60_000);
});
