import { describe, expect, it } from "vitest";
import { applyDownloadProgress, type DownloadingEntry } from "../src/extension/service-worker.js";

const downloadingEntry = (): DownloadingEntry => ({ bitrate: 0, status: "queuing" }) as DownloadingEntry;

describe("download progress sampling", () => {
  it("computes live bitrate from consecutive byte counts", () => {
    const entry = downloadingEntry();
    applyDownloadProgress(entry, { status: "downloading", fetched_bytes_count: 1_000_000 }, 1000);
    applyDownloadProgress(entry, { status: "downloading", fetched_bytes_count: 3_000_000 }, 2000);
    expect(entry.bitrate).toBe(16_000_000);
    expect(entry.fetched_bytes_count).toBe(3_000_000);
  });

  it("does not produce a speed from duplicate timestamps or a restarted byte count", () => {
    const entry = downloadingEntry();
    applyDownloadProgress(entry, { status: "downloading", fetched_bytes_count: 3_000_000 }, 1000);
    applyDownloadProgress(entry, { status: "downloading", fetched_bytes_count: 4_000_000 }, 1000);
    expect(entry.bitrate).toBe(0);
    applyDownloadProgress(entry, { status: "downloading", fetched_bytes_count: 1_000_000 }, 2000);
    expect(entry.bitrate).toBe(0);
  });
});
