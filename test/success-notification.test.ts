/**
 * A download that saves successfully must leave a success notification behind.
 *
 * The panel renders success notifications ("Download complete" in the notification list and the
 * status bar) and both must survive a closed panel: the failure paths already record persistent
 * rows in the service session, but a success used to notify only the desktop channel — so
 * reopening the panel after a background download showed nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaDownloaderService, type SessionState } from "../src/extension/service-worker.js";
import { statusPresentation } from "../src/extension/panel-status.js";
import { buildPanelSnapshot } from "../src/extension/panel-snapshot.js";
import {
  createHarness,
  doDownloadEnvelope,
  fmp4MediaPlaylist,
  sniffDetails,
} from "./helpers/service-harness.js";

const FIXTURE = {
  masterUrl: "https://cdn.test/master.m3u8",
  mediaPlaylistUrl: "https://cdn.test/1080/index.m3u8",
  mediaPlaylist: fmp4MediaPlaylist,
  segmentPrefix: "https://cdn.test/1080/",
  segments: 3,
  initBytes: "INIT",
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

async function discoverStandard(harness: Awaited<ReturnType<typeof createHarness>>) {
  await harness.service.start();
  harness.gateway.triggerSendHeaders({
    requestId: "req-master",
    url: FIXTURE.masterUrl,
    tabId: 7,
    frameId: 0,
    type: "xmlhttprequest",
    timeStamp: 1_700_000_000_000,
    requestHeaders: [{ name: "referer", value: "https://site.test/watch" }],
  });
  await harness.gateway.triggerResponseStarted(
    sniffDetails(FIXTURE.masterUrl, "application/vnd.apple.mpegurl"),
  );
  const discovered = harness.service.getSession().discovered.get(7);
  const item = [...(discovered?.media.values() ?? [])][0];
  const meta = harness.service.getSession().discovered.get(7)?.meta;
  return { item: item as NonNullable<typeof item>, meta: meta as NonNullable<typeof meta> };
}

describe("success notifications survive a closed panel", () => {
  it("records the success notification the panel can render after reopening", async () => {
    const harness = createHarness(FIXTURE);
    const { item, meta } = await discoverStandard(harness);

    await harness.gateway.deliverToService(doDownloadEnvelope(item, meta));
    await vi.waitUntil(
      async () => harness.service.getSession().transient_history.length === 1,
      { timeout: 20_000 },
    );

    const session: SessionState = harness.service.getSession();
    // The desktop notification is unaffected.
    expect(harness.gateway.notificationLog[0]?.title).toBe("Download complete");

    const records = [...session.notifications.values()];
    expect(records).toHaveLength(1);
    const supportedName = harness.gateway.downloadRequestsLog[0]?.filename;
    expect(records[0]?.type).toBe("download_success");
    expect(records[0]?.timestamp).toBe(1_700_000_000_000);
    expect(records[0]?.message).toBe(supportedName);

    // The panel marshals it through the snapshot like any other notification row...
    const snapshot = buildPanelSnapshot({
      media: new Map(),
      downloading: session.downloading,
      notifications: session.notifications,
    });
    expect(snapshot.notifications[0]).toEqual({
      type: "download_success",
      message: supportedName,
    });
    // ...and the status bar shows a success verdict after a fresh reopen.
    expect(statusPresentation([], snapshot.notifications)).toEqual({
      tone: "success",
      label: "Download complete",
      detail: supportedName,
    });

    harness.service.stop();
  }, 30_000);
});
