import { describe, expect, it } from "vitest";
import { statusPresentation } from "../src/extension/panel-status.js";
import type { PanelDownloadRow, PanelNotificationRow } from "../src/extension/panel-snapshot.js";

const download = (status: string, percent?: number): PanelDownloadRow => ({
  download_id: `download_${status}`,
  status,
  ...(percent !== undefined ? { percent } : {}),
});

const notice = (type: string, message?: string): PanelNotificationRow => ({
  type,
  ...(message !== undefined ? { message } : {}),
});

describe("panel status presentation", () => {
  it("shows a calm Ready state when nothing is happening", () => {
    expect(statusPresentation([], [])).toEqual({ tone: "idle", label: "Ready" });
  });

  it("maps machine states to human phase copy (never doubles the word Downloading)", () => {
    expect(statusPresentation([download("queuing")], [])).toMatchObject({
      tone: "progress",
      label: "Preparing download",
    });
    const active = statusPresentation([download("downloading", 42.6)], []);
    expect(active.tone).toBe("progress");
    expect(active.label).toBe("Downloading");
    expect(active.detail).toBe("43% complete");
    expect(active.percent).toBe(43);
    expect(active.label).not.toBe("Downloading downloading");

    const finishing = statusPresentation([download("finalizing")], []);
    expect(finishing.label).toBe("Finishing file");
    expect(finishing.tone).toBe("progress");
  });

  it("shows downloaded bytes and live speed when the total is unknown", () => {
    const active = statusPresentation(
      [{ ...download("downloading"), fetched_bytes_count: 1_500_000, bitrate: 22_400_000 }],
      [],
    );
    expect(active.detail).toBe("1.5 MB downloaded · 2.8 MB/s");
    expect(active.percent).toBeUndefined();
  });

  it("shows live speed alongside a known percentage", () => {
    expect(
      statusPresentation([{ ...download("downloading", 42.6), bitrate: 22_400_000 }], []).detail,
    ).toBe("43% complete · 2.8 MB/s");
  });

  it("humanizes unknown worker states", () => {
    expect(statusPresentation([download("waiting_for_network")], [])).toMatchObject({
      label: "Waiting for network",
      tone: "progress",
    });
  });

  it("summarises multiple active transfers", () => {
    expect(statusPresentation([download("downloading", 10), download("queuing")], [])).toMatchObject({
      label: "Downloading 2 items",
      percent: 10,
    });
    expect(statusPresentation([download("downloading", 10), download("queuing")], []).detail).toBe(
      "10% complete",
    );
    // A queued first row must not hide progress reported by a later active transfer.
    expect(statusPresentation([download("queuing"), download("downloading", 25)], [])).toMatchObject({
      label: "Downloading 2 items",
      detail: "25% complete",
      percent: 25,
    });
  });

  it("clamps progress into 0..100 and ignores non-finite values", () => {
    expect(statusPresentation([download("downloading", 120)], []).percent).toBe(100);
    expect(statusPresentation([download("downloading", -4)], []).percent).toBe(0);
    expect(statusPresentation([download("downloading", Number.NaN)], []).percent).toBeUndefined();
  });

  it("turns notifications into tonal status copy after transfers finish", () => {
    expect(statusPresentation([], [notice("download_error", "HTTP 403")])).toEqual({
      tone: "error",
      label: "Download failed",
      detail: "HTTP 403",
    });
    expect(statusPresentation([], [notice("download_complete")])).toEqual({
      tone: "success",
      label: "Download complete",
    });
    expect(statusPresentation([], [notice("some_new_notice")])).toMatchObject({
      tone: "idle",
      label: "Some new notice",
    });
  });

  it("prefers the active transfer over a stale notification", () => {
    expect(
      statusPresentation([download("downloading", 7)], [notice("download_complete")]),
    ).toMatchObject({ label: "Downloading", percent: 7 });
  });
});
