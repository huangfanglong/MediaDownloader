import { describe, expect, it } from "vitest";
import { MAX_PENDING_DOWNLOAD_NAMES, PendingDownloadNames } from "../src/extension/download-names.js";

describe("pending download names", () => {
  it("matches a filename event by download id before anything else", () => {
    const pending = new PendingDownloadNames();
    pending.addUrl("blob:one", "First.mp4");
    pending.addUrl("blob:two", "Second.mp4");
    pending.addId(2, "Second.mp4");
    expect(pending.resolve({ id: 2, url: "blob:one", byExtensionId: true, filename: "x" })).toBe("Second.mp4");
    // The id match consumed its entry; the other download is still pending.
    expect(pending.resolve({ url: "blob:one", byExtensionId: true, filename: "x" })).toBe("First.mp4");
  });

  it("matches by blob URL when the event carries one", () => {
    const pending = new PendingDownloadNames();
    pending.addUrl("blob:first", "First.mp4");
    pending.addUrl("blob:second", "Second.mp4");
    expect(pending.resolve({ url: "blob:second", filename: "clip" })).toBe("Second.mp4");
    expect(pending.resolve({ url: "blob:first", filename: "clip" })).toBe("First.mp4");
  });

  it("pairs racing URL-less events with names in download order (FIFO, not newest)", () => {
    const pending = new PendingDownloadNames();
    pending.addUrl("blob:first", "First.mp4");
    pending.addUrl("blob:second", "Second.mp4");
    // Chrome raises one event per download in start order and may omit the blob URL.
    expect(pending.resolve({ byExtensionId: true, filename: "clip" })).toBe("First.mp4");
    expect(pending.resolve({ byExtensionId: true, filename: "clip" })).toBe("Second.mp4");
    expect(pending.resolve({ byExtensionId: true, filename: "clip" })).toBeUndefined();
  });

  it("ignores events that are not our own blob downloads", () => {
    const pending = new PendingDownloadNames();
    pending.addUrl("blob:ours", "Ours.mp4");
    expect(pending.resolve({ byExtensionId: false, filename: "page-file" })).toBeUndefined();
    expect(pending.resolve({ filename: "page-file" })).toBeUndefined();
    expect(pending.size).toBe(1);
  });

  it("drops pending names for downloads that never started and stays bounded", () => {
    const pending = new PendingDownloadNames();
    pending.addUrl("blob:failed", "Failed.mp4");
    pending.discardUrl("blob:failed");
    expect(pending.resolve({ url: "blob:failed", filename: "clip" })).toBeUndefined();

    for (let index = 0; index <= MAX_PENDING_DOWNLOAD_NAMES; index += 1) {
      pending.addUrl(`blob:${index}`, `file-${index}.mp4`);
    }
    expect(pending.size).toBe(MAX_PENDING_DOWNLOAD_NAMES);
    expect(pending.resolve({ url: "blob:0", filename: "clip" })).toBeUndefined();
    expect(pending.resolve({ url: `blob:${MAX_PENDING_DOWNLOAD_NAMES}`, filename: "clip" })).toBe(
      `file-${MAX_PENDING_DOWNLOAD_NAMES}.mp4`,
    );
  });
});
