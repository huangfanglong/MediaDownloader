/**
 * Concurrency settings must survive a service-worker restart.
 *
 * `restoreState()` loads persisted settings for boot 2; the download queue constructed at
 * construction time still runs the DEFAULTS unless it is re-applied from the loaded settings.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService, PERSISTENT_KEY } from "../src/extension/service-worker.js";
import { DownloadQueue } from "../src/transfer/queue.js";
import { MSG, makeContentToServiceEnvelope } from "../src/protocol/messages.js";
import type { MutSettingsPayload } from "../src/protocol/messages.js";
import { createFakeGateway } from "./helpers/service-harness.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";
import type { FetchLike } from "../src/transfer/fetch.js";
import type { FakeGateway } from "./helpers/service-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function boot(gateway: FakeGateway) {
  return new MediaDownloaderService({
    gateway,
    fetchImpl: createFetch(new Map()) as unknown as FetchLike,
    opfsRoot: async () => createFakeOpfs().root,
    now: () => 1_700_000_000_000,
  });
}

function queueOf(service: MediaDownloaderService): DownloadQueue {
  return (service as unknown as { queue: DownloadQueue }).queue;
}

const settingsOf = (service: MediaDownloaderService) =>
  service as unknown as { settings: { max_concurrent_downloads: number; youtube_throttle: boolean } };

const mutate = (gateway: FakeGateway, payload: MutSettingsPayload) =>
  gateway.deliverToService(
    makeContentToServiceEnvelope(MSG.contentToService.MutSettings, payload),
  );

describe("queue capacities across a service-worker restart", () => {
  it("applies the stored max_concurrent_downloads/youtube_throttle to the queue on every boot", async () => {
    const gateway = createFakeGateway("https://site.test/watch", new Map());
    const first = boot(gateway);
    await first.start();
    await mutate(gateway, { max_concurrent_downloads: 2 });
    await mutate(gateway, { youtube_throttle: false });
    expect(queueOf(first).getStats()).toMatchObject({ capacity: 2, ytCapacity: 2 });
    first.stop();

    // Boot 2 over the same storage: no panel interaction in between.
    const second = boot(gateway);
    await second.start();
    expect(settingsOf(second).settings.max_concurrent_downloads).toBe(2);
    expect(settingsOf(second).settings.youtube_throttle).toBe(false);
    expect(queueOf(second).getStats()).toMatchObject({ capacity: 2, ytCapacity: 2 });
    expect(await gateway.storage.local.get(PERSISTENT_KEY)).toBeDefined();
    second.stop();
  });

  it("recovers to the user's settings when a later panel mutation arrives", async () => {
    const gateway = createFakeGateway("https://site.test/watch", new Map());
    const first = boot(gateway);
    await first.start();
    await mutate(gateway, { max_concurrent_downloads: 2 });
    await mutate(gateway, { youtube_throttle: false });
    first.stop();

    const second = boot(gateway);
    await second.start();
    await mutate(gateway, { history_days: 30 });
    expect(queueOf(second).getStats()).toMatchObject({ capacity: 2, ytCapacity: 2 });
    second.stop();
  });

  it("applies a shrink below the current youtube capacity without throwing", async () => {
    const gateway = createFakeGateway("https://site.test/watch", new Map());
    const service = boot(gateway);
    await service.start();
    await mutate(gateway, { max_concurrent_downloads: 2 });
    await mutate(gateway, { youtube_throttle: false });
    expect(queueOf(service).getStats()).toMatchObject({ capacity: 2, ytCapacity: 2 });

    // Lowering the cap below the running youtube capacity: total 2 -> 1, yt stays unthrottled.
    await mutate(gateway, { max_concurrent_downloads: 1 });
    expect(settingsOf(service).settings.max_concurrent_downloads).toBe(1);
    expect(queueOf(service).getStats()).toMatchObject({ capacity: 1, ytCapacity: 1 });
    service.stop();
  });
});
