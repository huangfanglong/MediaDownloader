import { describe, expect, it } from "vitest";
import { FOCUS_TTL_MS, filterFocusedMedia, focusKey, mediaMatchesFocus } from "../src/extension/focus.js";
import { applyFocusToHints } from "../src/extension/page-hook.js";
import type { MediaItem } from "../src/core/types.js";
import type { PageMediaHint } from "../src/extension/media-hint.js";

const httpItem = (url: string, overrides: Partial<MediaItem> = {}): MediaItem => ({
  type: "http_playlist",
  hash: `media_hash_${url.length}_${url.slice(-4)}`,
  is_youtube: false,
  sent_headers: new Headers(),
  url: new URL(url),
  libav_demuxer: "mp4",
  extension: "mp4",
  discovery_timestamp_ms: 1,
  cache: "default",
  ...overrides,
});

describe("focus identity", () => {
  it("ignores volatile query parameters", () => {
    expect(focusKey("https://cdn.test/v/clip.mp4?_nc_cat=1&efg=x")).toBe("https://cdn.test/v/clip.mp4");
    expect(focusKey("https://cdn.test/a") === focusKey("https://other.test/a")).toBe(false);
    expect(focusKey("blob:https://page.test/abc")).toBeUndefined();
  });

  it("matches http items by origin + path and keeps adapters/manifests", () => {
    const focus = { urls: ["https://cdn.test/v/clip.mp4?_nc_cat=2"] };
    expect(mediaMatchesFocus(httpItem("https://cdn.test/v/clip.mp4?range=0-1"), focus)).toBe(true);
    expect(mediaMatchesFocus(httpItem("https://cdn.test/v/other.mp4"), focus)).toBe(false);
    expect(mediaMatchesFocus(httpItem("https://cdn.test/v/other.mp4", { is_youtube: true }), focus)).toBe(true);
    expect(mediaMatchesFocus(httpItem("https://cdn.test/v/other.mp4", { type: "m3u8" }), focus)).toBe(true);
  });

  it("collapses a single-rendition sniffer row covered by the richer focused row", () => {
    const rich = httpItem("https://cdn.test/v/rich.mp4", {
      playlist: [
        { demuxer: "mp4", quality: {}, av: { video: new URL("https://cdn.test/v/rich.mp4"), audio: false } },
        { demuxer: "mp4", quality: {}, av: { video: new URL("https://cdn.test/v/rich-720.mp4"), audio: false } },
      ],
    });
    const sniffer = httpItem("https://cdn.test/v/rich-720.mp4");
    const focus = { urls: ["https://cdn.test/v/rich.mp4", "https://cdn.test/v/rich-720.mp4"], at: 1_000 };
    expect(filterFocusedMedia([rich, sniffer], focus, 1_001)).toEqual([rich]);
  });

  it("filters duplicates down to the focused item and falls back safely", () => {
    const first = httpItem("https://cdn.test/v/a.mp4");
    const second = httpItem("https://cdn.test/v/b.mp4");
    const focus = { urls: ["https://cdn.test/v/b.mp4"], at: 1_000 };
    expect(filterFocusedMedia([first, second], focus, 1_001)).toEqual([second]);
    expect(filterFocusedMedia([first, second], undefined, 1_001)).toEqual([first, second]);
    expect(filterFocusedMedia([first, second], focus, 1_000 + FOCUS_TTL_MS + 1)).toEqual([first, second]);
    expect(filterFocusedMedia([first, second], { urls: ["https://cdn.test/v/none.mp4"], at: 1_000 }, 1_001)).toEqual([first, second]);
    expect(filterFocusedMedia([first], focus, 1_001)).toEqual([first]);
  });
});

describe("page-hook focus marking", () => {
  it("marks hints that match the playing media", () => {
    const hints: PageMediaHint[] = [
      { url: "https://cdn.test/v/clip.mp4?_nc=1", kind: "file" as const, source: "resource-entry" as const },
      { url: "https://cdn.test/v/other.mp4", kind: "file" as const, source: "resource-entry" as const },
    ];
    const result = applyFocusToHints(hints, ["https://cdn.test/v/clip.mp4"]);
    expect(result.focusActive).toBe(true);
    expect(result.focusedUrls).toEqual(["https://cdn.test/v/clip.mp4?_nc=1"]);
    expect(hints[0]?.focused).toBe(true);
    expect(hints[1]?.focused).toBeUndefined();
  });

  it("does not activate focus when nothing matches", () => {
    const hints: PageMediaHint[] = [{ url: "https://cdn.test/v/clip.mp4", kind: "file" as const, source: "video" as const }];
    const result = applyFocusToHints(hints, ["https://cdn.test/v/none.mp4"]);
    expect(result.focusActive).toBe(false);
    expect(hints[0]?.focused).toBeUndefined();
  });
});
