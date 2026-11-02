import { describe, expect, it } from "vitest";
import type { MediaItem } from "../src/core/types.js";
import { encode } from "../src/protocol/serde.js";
import { buildPanelSnapshot, decodePanelSnapshot } from "../src/extension/panel-snapshot.js";

const media = (overrides: Partial<MediaItem> = {}): MediaItem => ({
  type: "http_playlist",
  hash: "media_hash_1",
  is_youtube: false,
  sent_headers: new Headers(),
  playlist: [{ demuxer: "mp4", quality: {}, av: { video: new URL("https://cdn.test/a.mp4"), audio: false } }],
  extension: "mp4",
  title: "Clip",
  discovery_timestamp_ms: 1,
  cache: "default",
  ...overrides,
});

const validSnapshot = () =>
  buildPanelSnapshot({
    tabId: 7,
    meta: {
      incognito: false,
      tab_id: 7,
      title: "Watch page",
      url: new URL("https://site.test/watch"),
      default_action: "download",
      smartnaming_rule: {
        template: "%title",
        selector: null,
        max_length: 64,
        replace: [],
        subdir: "",
        force_doc_title: false,
      },
    },
    media: [media()],
    downloading: new Map([
      ["download_1", { status: "downloading", percent: 42, fetched_bytes_count: 1024, bitrate: 8_000 }],
    ]),
    notifications: new Map([["notification_1", { type: "download_error", details: "boom" }]]),
  });

describe("incoming panel snapshot validation", () => {
  it("accepts the snapshot the service worker builds", () => {
    const built = validSnapshot();
    expect(decodePanelSnapshot(encode(built))).toEqual(built);
  });

  it("rejects messages that are not a snapshot", () => {
    for (const wire of [
      undefined,
      null,
      "not-a-snapshot",
      encode({}),
      encode({ media: "oops" }),
      encode({ media: null }),
      { __serde_tag: "mystery" },
    ]) {
      expect(decodePanelSnapshot(wire)).toBeUndefined();
    }
  });

  it("keeps valid rows and drops malformed ones", () => {
    const decoded = decodePanelSnapshot(
      encode({
        tab_id: 7,
        page_url: "https://site.test/watch",
        page_title: 42,
        media: [
          {
            hash: "h1",
            type: "http_playlist",
            label: "a.mp4",
            has_drm: false,
            variants: [{ index: 0, label: "MP4" }, { index: "x" }, null],
            sources: [{ value: "fmt", label: "FMT" }, { value: "bogus", label: "FMT" }, { value: "hls", label: "HLS" }],
          },
          { hash: 42, label: "no usable hash" },
          { hash: "h2", label: 5 },
          "row",
          null,
        ],
        downloading: [
          null,
          { download_id: "download_1", status: "downloading", percent: 42 },
          { download_id: "", status: "queued" },
        ],
        notifications: [{ type: "download_error", message: "boom" }, { type: 5 }, null],
      }),
    );
    expect(decoded).toBeDefined();
    expect(decoded?.tab_id).toBe(7);
    expect(decoded?.page_url).toBe("https://site.test/watch");
    expect(decoded?.page_title).toBeUndefined();
    expect(decoded?.media).toEqual([
      {
        hash: "h1",
        type: "http_playlist",
        label: "a.mp4",
        has_drm: false,
        variants: [{ index: 0, label: "MP4" }],
        sources: [
          { value: "fmt", label: "FMT" },
          { value: "hls", label: "HLS" },
        ],
      },
    ]);
    expect(decoded?.downloading).toEqual([{ download_id: "download_1", status: "downloading", percent: 42 }]);
    expect(decoded?.notifications).toEqual([{ type: "download_error", message: "boom" }]);
  });

  it("caps the arrays so a bad message cannot force unbounded DOM work", () => {
    const many = (count: number, build: (index: number) => Record<string, unknown>): Array<Record<string, unknown>> =>
      Array.from({ length: count }, (_, index) => build(index));
    const decoded = decodePanelSnapshot(
      encode({
        media: many(250, (index) => ({ hash: `h${index}`, label: "x" })),
        downloading: many(150, (index) => ({ download_id: `d${index}`, status: "downloading" })),
        notifications: many(80, () => ({ type: "download_error" })),
      }),
    );
    expect(decoded?.media).toHaveLength(200);
    expect(decoded?.downloading).toHaveLength(100);
    expect(decoded?.notifications).toHaveLength(50);
  });

  it("drops optional fields of the wrong type instead of passing them to the DOM", () => {
    const decoded = decodePanelSnapshot(
      encode({
        tab_id: "7",
        media: [
          {
            hash: "h1",
            label: "a.mp4",
            type: 7,
            extension: 9,
            duration: Number.NaN,
            size: "big",
            thumbnail: 5,
            source: "BOGUS",
            has_drm: "yes",
          },
        ],
      }),
    );
    expect(decoded?.tab_id).toBeUndefined();
    expect(decoded?.media[0]).toEqual({ hash: "h1", type: "", label: "a.mp4", has_drm: false });
  });
});
