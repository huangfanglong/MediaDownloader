/**
 * Discovery parity tests.
 *
 * Every expectation cites the evidence claim (D-number) and value provenance from
 * `analysis/evidence/02-detection-pipeline.md`. Fixtures in `test/fixtures/detection.ts` are the
 * recovered tables; this file asserts the rebuilt modules against those facts and walks the
 * decision truth table from D9/D10/D17/D30/D31.
 */

import { describe, expect, it } from "vitest";
import {
  DiscoveryEngine,
  SEND_HEADERS_TTL_MS,
  dashPlaylistHash,
  directMediaHash,
  hlsPlaylistHash,
} from "../src/discovery/engine.js";
import {
  createGate,
  createHostGate,
  fixedNow,
  headerList,
  makeResponseStartedEvent,
  makeSendHeadersEvent,
} from "./fixtures/detection.js";
import { makeEngine } from "./helpers/discovery-harness.js";

// ---------------------------------------------------------------------------
// Registry: dedupe, caps, supersede, eviction (D29-D32)
// ---------------------------------------------------------------------------

describe("engine: per-tab registry", () => {
  const detectDirect = (
    engine: DiscoveryEngine,
    index: number,
    overrides: Parameters<typeof makeResponseStartedEvent>[0] = {},
  ) =>
    engine.onResponseStarted(
      makeResponseStartedEvent({
        url: `https://cdn.example.com/media/${index}.mp4`,
        requestId: `req-${index}`,
        responseHeaders: headerList({
          "content-type": "video/mp4",
          "content-length": "2000000",
        }),
        ...overrides,
      }),
    );

  it("dedupes by hash without merging fields (D31)", () => {
    const engine = makeEngine();
    const first = detectDirect(engine, 1);
    const second = detectDirect(engine, 1);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(engine.mediaForTab(1).size).toBe(1);
    expect(engine.mediaForTab(1).get(first!.hash)).toBe(first);
  });

  it("rejects the 12th item of the same type once 11 are stored (D30)", () => {
    const engine = makeEngine();
    for (let index = 0; index < 12; index += 1) detectDirect(engine, index);
    expect(engine.mediaForTab(1).size).toBe(11);
    expect(
      engine
        .mediaForTab(1)
        .has(directMediaHash(new URL("https://cdn.example.com/media/11.mp4"))),
    ).toBe(false);
  });

  it("bounds FIFO_DISCOVERED_WEBSITES registries to 30 items, evicting the oldest (D29)", () => {
    const engine = makeEngine(
      createHostGate({ FIFO_DISCOVERED_WEBSITES: ["fifo.example"] }),
    );
    for (let index = 0; index < 35; index += 1) {
      detectDirect(engine, index, { initiator: "https://fifo.example/watch" });
    }
    const media = engine.mediaForTab(1);
    expect(media.size).toBe(30);
    expect(
      media.has(
        directMediaHash(new URL("https://cdn.example.com/media/0.mp4")),
      ),
    ).toBe(false);
    expect(
      media.has(
        directMediaHash(new URL("https://cdn.example.com/media/34.mp4")),
      ),
    ).toBe(true);
  });

  it("lets a parsed HLS master playlist supersede its media-playlist children (D31)", () => {
    const engine = makeEngine();
    const childUrl = new URL("https://cdn.example.com/720.m3u8");
    const masterUrl = new URL("https://cdn.example.com/master.m3u8");

    // The child is detected first, as a plain media playlist.
    const child = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: childUrl.href,
        type: "xmlhttprequest",
        responseHeaders: headerList({
          "content-type": "application/x-mpegurl",
        }),
      }),
    );
    expect(child?.type).toBe("m3u8");
    // Then the master shows up; attaching its renditions must remove the covered child.
    const master = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: masterUrl.href,
        type: "xmlhttprequest",
        responseHeaders: headerList({
          "content-type": "application/x-mpegurl",
        }),
      }),
    );
    engine.attachPlaylist(
      1,
      master!.hash,
      [{ demuxer: "mp4", quality: {}, av: { video: childUrl, audio: false } }],
      { type: "m3u8_playlist", manifestText: "#EXTM3U" },
    );

    const media = engine.mediaForTab(1);
    expect(media.size).toBe(1);
    expect(media.has(child!.hash)).toBe(false);
    expect(media.has(hlsPlaylistHash("#EXTM3U", masterUrl))).toBe(true);
  });

  it("rejects a media-playlist response already covered by an attached master (D30 #5)", () => {
    const engine = makeEngine();
    const childUrl = new URL("https://cdn.example.com/720.m3u8");
    const master = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/master.m3u8",
        type: "xmlhttprequest",
        responseHeaders: headerList({
          "content-type": "application/x-mpegurl",
        }),
      }),
    );
    engine.attachPlaylist(
      1,
      master!.hash,
      [{ demuxer: "mp4", quality: {}, av: { video: childUrl, audio: false } }],
      { type: "m3u8_playlist", manifestText: "#EXTM3U" },
    );

    const detected = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: childUrl.href,
        type: "xmlhttprequest",
        responseHeaders: headerList({
          "content-type": "application/x-mpegurl",
        }),
      }),
    );
    expect(detected).not.toBeNull();
    expect(engine.mediaForTab(1).has(detected!.hash)).toBe(false);
    expect(engine.mediaForTab(1).size).toBe(1);
  });

  it("lets a DASH playlist supersede same-initiator direct files up to 20 MB (D31)", () => {
    const engine = makeEngine();
    const initiator = "https://site.example/watch";
    const smallDirect = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/player/small.mp4",
        initiator,
        responseHeaders: headerList({
          "content-type": "video/mp4",
          "content-length": "1000000",
        }),
      }),
    );
    const largeDirect = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/player/large.mp4",
        initiator,
        responseHeaders: headerList({
          "content-type": "video/mp4",
          "content-length": "30000000",
        }),
      }),
    );
    const dash = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/manifest.mpd",
        initiator,
        type: "xmlhttprequest",
        responseHeaders: headerList({ "content-type": "application/dash+xml" }),
      }),
    );
    expect(dash?.type).toBe("mpd_playlist");

    let media = engine.mediaForTab(1);
    expect(media.has(smallDirect!.hash)).toBe(false);
    expect(media.has(largeDirect!.hash)).toBe(true);

    engine.attachPlaylist(1, dash!.hash, [], { manifestText: "<MPD/>" });
    media = engine.mediaForTab(1);
    expect(media.has(dashPlaylistHash("<MPD/>"))).toBe(true);
    expect(media.has(largeDirect!.hash)).toBe(true);
    expect(media.size).toBe(2);
  });

  it("rejects direct files from an initiator claimed by a parsed DASH manifest, unless >= 20 MB (D16)", () => {
    const engine = makeEngine();
    const initiator = "https://site.example/watch";
    const dash = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/manifest.mpd",
        initiator,
        type: "xmlhttprequest",
        responseHeaders: headerList({ "content-type": "application/dash+xml" }),
      }),
    );
    engine.attachPlaylist(1, dash!.hash, [], { manifestText: "<MPD/>" });

    const suppressed = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/player/chunk.mp4",
        initiator,
        responseHeaders: headerList({
          "content-type": "video/mp4",
          "content-length": "1000000",
        }),
      }),
    );
    expect(suppressed).toBeNull();

    const large = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/player/full.mp4",
        initiator,
        responseHeaders: headerList({
          "content-type": "video/mp4",
          "content-length": "25000000",
        }),
      }),
    );
    expect(large).not.toBeNull();
  });

  it("drops the DASH initiator claim after the 600 s TTL prune (D16/D6)", () => {
    const now = fixedNow(1_000_000);
    const engine = makeEngine(createGate(), now);
    const initiator = "https://site.example/watch";
    const dash = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/manifest.mpd",
        initiator,
        type: "xmlhttprequest",
        responseHeaders: headerList({ "content-type": "application/dash+xml" }),
      }),
    );
    engine.attachPlaylist(1, dash!.hash, [], { manifestText: "<MPD/>" });

    engine.onSendHeaders(
      makeSendHeadersEvent({
        requestId: "later",
        timeStamp: now() + SEND_HEADERS_TTL_MS + 1,
      }),
    );
    const direct = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/player/after.mp4",
        initiator,
        requestId: "later",
        responseHeaders: headerList({
          "content-type": "video/mp4",
          "content-length": "1000000",
        }),
      }),
    );
    expect(direct).not.toBeNull();
  });

  it("applies FILTER_HTTP_M3U8_MEDIA to direct files once a playlist exists (D30)", () => {
    const engine = makeEngine(
      createHostGate({ FILTER_HTTP_M3U8_MEDIA: ["site.example"] }),
    );
    const master = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/master.m3u8",
        type: "xmlhttprequest",
        responseHeaders: headerList({
          "content-type": "application/x-mpegurl",
        }),
      }),
    );
    engine.attachPlaylist(
      1,
      master!.hash,
      [
        {
          demuxer: "mp4",
          quality: {},
          av: {
            video: new URL("https://cdn.example.com/720.m3u8"),
            audio: false,
          },
        },
      ],
      { type: "m3u8_playlist", manifestText: "#EXTM3U" },
    );

    const direct = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/file.mp4",
        responseHeaders: headerList({
          "content-type": "video/mp4",
          "content-length": "2000000",
        }),
      }),
    );
    expect(direct).not.toBeNull();
    expect(engine.mediaForTab(1).has(direct!.hash)).toBe(false);
    expect(engine.mediaForTab(1).size).toBe(1);
  });

  it("evicts on navigation/close and removes single items (D32)", () => {
    const engine = makeEngine();
    const item = detectDirect(engine, 1);
    expect(engine.tabIds()).toEqual([1]);
    engine.removeMedia(1, item!.hash);
    expect(engine.mediaForTab(1).size).toBe(0);

    detectDirect(engine, 2);
    expect(engine.mediaForTab(1).size).toBe(1);
    engine.clearTab(1);
    expect(engine.mediaForTab(1).size).toBe(0);
    expect(engine.tabIds()).toEqual([]);
  });

  it("tracks independent registries per tab and returns an empty map for unknown tabs", () => {
    const engine = makeEngine();
    detectDirect(engine, 1, { tabId: 1 });
    detectDirect(engine, 2, { tabId: 2 });
    expect(engine.mediaForTab(1).size).toBe(1);
    expect(engine.mediaForTab(2).size).toBe(1);
    expect(engine.mediaForTab(99).size).toBe(0);
    expect(engine.tabIds().sort()).toEqual([1, 2]);
  });

  it("keeps an enriched playlist when an adapter refresh carries no playlist", () => {
    const engine = makeEngine();
    const master = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/master.m3u8",
        type: "xmlhttprequest",
        responseHeaders: headerList({ "content-type": "application/vnd.apple.mpegurl" }),
      }),
    );
    engine.attachPlaylist(
      1,
      master!.hash,
      [{ demuxer: "mp4", quality: {}, av: { video: new URL("https://cdn.example.com/720.m3u8"), audio: false } }],
      { type: "m3u8_playlist", manifestText: "#EXTM3U" },
    );
    const enriched = [...engine.mediaForTab(1).values()][0]!;
    const playlist = enriched.playlist;
    const refreshed = { ...enriched, url: new URL(enriched.url?.href ?? "https://cdn.example.com/master.m3u8"), playlist: undefined };
    expect(engine.refreshExternal(refreshed, 1)).toBe(true);
    const after = [...engine.mediaForTab(1).values()][0]!;
    expect(after.playlist).toBe(playlist);
  });

  it("returns null when attaching to a missing tab or hash", () => {
    const engine = makeEngine();
    expect(engine.attachPlaylist(1, "media_hash_missing", [])).toBeNull();
    detectDirect(engine, 1);
    expect(engine.attachPlaylist(99, "media_hash_missing", [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Send-headers bookkeeping (D6/D15)
// ---------------------------------------------------------------------------

describe("engine: request-header bookkeeping", () => {
  it("stores and replays per-request headers (D6/D15)", () => {
    const engine = makeEngine();
    engine.onSendHeaders(makeSendHeadersEvent({ requestId: "rq" }));
    expect(engine.replayHeaders("rq").get("cookie")).toBe("a=b");
    expect(engine.replayHeaders("unknown").get("cookie")).toBeNull();
  });

  it("ignores events without requestHeaders (D6)", () => {
    const engine = makeEngine();
    engine.onSendHeaders(
      makeSendHeadersEvent({ requestId: "rq", requestHeaders: undefined }),
    );
    expect(engine.replayHeaders("rq").get("cookie")).toBeNull();
  });

  it("prunes records older than 600 s, lazily, at the next cleanup (D6)", () => {
    const engine = makeEngine();
    engine.onSendHeaders(
      makeSendHeadersEvent({ requestId: "old", timeStamp: 10_000 }),
    );
    engine.onSendHeaders(
      makeSendHeadersEvent({
        requestId: "new",
        timeStamp: 10_000 + SEND_HEADERS_TTL_MS + 1,
      }),
    );
    expect(engine.replayHeaders("old").get("cookie")).toBeNull();
    expect(engine.replayHeaders("new").get("cookie")).toBe("a=b");
  });

  it("does not prune before the 600 s gap is reached (D6)", () => {
    const engine = makeEngine();
    engine.onSendHeaders(
      makeSendHeadersEvent({ requestId: "old", timeStamp: 10_000 }),
    );
    engine.onSendHeaders(
      makeSendHeadersEvent({
        requestId: "new",
        timeStamp: 10_000 + SEND_HEADERS_TTL_MS - 1,
      }),
    );
    expect(engine.replayHeaders("old").get("cookie")).toBe("a=b");
  });
});
