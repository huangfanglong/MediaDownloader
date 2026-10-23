import { describe, expect, it } from "vitest";
import { dashPlaylistHash, directMediaHash, hlsPlaylistHash } from "../src/discovery/engine.js";
import { cyrb53 } from "../src/protocol/channels.js";
import {
  FIXTURE_HASHES,
  createGate,
  createHostGate,
  fixedNow,
  headerList,
  makeResponseStartedEvent,
  makeSendHeadersEvent,
} from "./fixtures/detection.js";
import { makeEngine } from "./helpers/discovery-harness.js";

describe("engine: response acceptance truth table", () => {
  it("rejects non-2xx responses (D9 step 1)", () => {
    const engine = makeEngine();
    expect(engine.onResponseStarted(makeResponseStartedEvent({ statusCode: 300 }))).toBeNull();
    expect(engine.onResponseStarted(makeResponseStartedEvent({ statusCode: 199 }))).toBeNull();
    expect(engine.onResponseStarted(makeResponseStartedEvent({ statusCode: 404 }))).toBeNull();
  });

  it("rejects an initiator blocked by the BLOCK_MEDIA_DETECTION flag (D9 step 2)", () => {
    const engine = makeEngine(createHostGate({ BLOCK_MEDIA_DETECTION: ["site.example"] }));
    expect(engine.onResponseStarted(makeResponseStartedEvent())).toBeNull();
  });

  it("rejects extension-page and non-http initiators (D9 step 2)", () => {
    const engine = makeEngine();
    expect(engine.onResponseStarted(makeResponseStartedEvent({ initiator: "chrome-extension://abcdef/page.html" }))).toBeNull();
    expect(engine.onResponseStarted(makeResponseStartedEvent({ initiator: "moz-extension://abcdef/page.html" }))).toBeNull();
    expect(engine.onResponseStarted(makeResponseStartedEvent({ initiator: "file:///tmp/page.html" }))).toBeNull();
  });

  it("rejects segment responses before classification (D9 step 3)", () => {
    const engine = makeEngine();
    for (const segment of ["1.ts", "1.m4s", "1.m2ts"]) {
      expect(engine.onResponseStarted(makeResponseStartedEvent({ url: `https://cdn.example.com/segments/${segment}` }))).toBeNull();
    }
  });

  it("rejects initiators on the site-adapter block list (D9 step 5 / D25)", () => {
    const engine = makeEngine();
    for (const hostname of ["www.youtube.com", "player.vimeo.com", "intl-api.iq.com"]) {
      expect(engine.onResponseStarted(makeResponseStartedEvent({ initiator: `https://${hostname}/watch` }))).toBeNull();
    }
  });

  it("rejects tab-less anonymous requests (D9 step 6)", () => {
    const engine = makeEngine();
    expect(engine.onResponseStarted(makeResponseStartedEvent({ tabId: 0, initiator: undefined }))).toBeNull();
    expect(engine.onResponseStarted(makeResponseStartedEvent({ tabId: -1, initiator: undefined }))).toBeNull();
  });

  it("produces but does not register items for tab-less requests with an http initiator (D29)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(makeResponseStartedEvent({ tabId: 0 }));
    expect(item).not.toBeNull();
    expect(engine.tabIds()).toEqual([]);
  });
});

describe("engine: playlist sniffing branches", () => {
  it("detects HLS from the content-type (D10)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(makeResponseStartedEvent({
      url: "https://cdn.example.com/blob?id=7",
      type: "xmlhttprequest",
      responseHeaders: headerList({ "content-type": "application/vnd.apple.mpegurl" }),
    }));
    expect(item).not.toBeNull();
    expect(item?.type).toBe("m3u8");
    expect(item?.url?.href).toBe("https://cdn.example.com/blob?id=7");
    expect(item?.hash).toBe(directMediaHash(new URL("https://cdn.example.com/blob?id=7")));
    expect(item?.duration).toBe("unknown");
    expect(item?.has_drm).toBe(false);
    expect(engine.mediaForTab(1).size).toBe(1);
  });

  it("detects HLS only from .m3u8 URLs and the master-API path (D10)", () => {
    for (const url of ["https://cdn.example.com/master.m3u8", "https://cdn.example.com/api/playlist/master/abc"]) {
      const engine = makeEngine();
      const item = engine.onResponseStarted(makeResponseStartedEvent({
        url,
        type: "xmlhttprequest",
        responseHeaders: headerList({ "content-type": "application/octet-stream" }),
      }));
      expect(item?.type).toBe("m3u8");
    }
  });

  it("marks HLS candidates audio-only on AUDIO_ONLY_WEBSITES hosts (D12)", () => {
    const engine = makeEngine(createHostGate({ AUDIO_ONLY_WEBSITES: ["radio.example"] }));
    const item = engine.onResponseStarted(makeResponseStartedEvent({
      url: "https://cdn.example.com/live.m3u8",
      type: "xmlhttprequest",
      initiator: "https://radio.example/player",
      responseHeaders: headerList({ "content-type": "application/x-mpegurl" }),
    }));
    expect(item?.type).toBe("m3u8");
    expect(item?.demuxer).toBe("mp3");
  });

  it("rewrites .mpd to .m3u8 only with CONVERT_MPD_URL_TO_M3U8 on the initiator host (D10)", () => {
    const response = makeResponseStartedEvent({
      url: "https://cdn.example.com/manifest.mpd",
      type: "xmlhttprequest",
      responseHeaders: headerList({ "content-type": "application/octet-stream" }),
    });
    const off = makeEngine();
    expect(off.onResponseStarted(response)?.type).toBe("mpd_playlist");
    const on = makeEngine(createHostGate({ CONVERT_MPD_URL_TO_M3U8: ["site.example"] }));
    const item = on.onResponseStarted(response);
    expect(item?.type).toBe("m3u8");
    expect(item?.url?.href).toBe("https://cdn.example.com/manifest.m3u8".replace(".mpd", ".m3u8"));
  });

  it("matches CONVERT_MPD_URL_TO_M3U8 on URL.host, i.e. including a non-default port (D26 quirk)", () => {
    const event = makeResponseStartedEvent({
      url: "https://cdn.example.com/manifest.mpd",
      type: "xmlhttprequest",
      initiator: "https://site.example:8443/watch",
      responseHeaders: headerList({ "content-type": "application/octet-stream" }),
    });
    const withoutPort = makeEngine(createHostGate({ CONVERT_MPD_URL_TO_M3U8: ["site.example"] }));
    expect(withoutPort.onResponseStarted(event)?.type).toBe("mpd_playlist");
    const withPort = makeEngine(createHostGate({ CONVERT_MPD_URL_TO_M3U8: ["site.example:8443"] }));
    expect(withPort.onResponseStarted(event)?.type).toBe("m3u8");
  });

  it("detects DASH manifests (D10/D13)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(makeResponseStartedEvent({
      url: "https://cdn.example.com/manifest.mpd",
      type: "xmlhttprequest",
      responseHeaders: headerList({ "content-type": "application/dash+xml" }),
    }));
    expect(item).not.toBeNull();
    expect(item?.type).toBe("mpd_playlist");
    expect(item?.master_url?.href).toBe("https://cdn.example.com/manifest.mpd");
    expect(item?.playlist).toEqual([]);
    expect(item?.hash).toBe(directMediaHash(new URL("https://cdn.example.com/manifest.mpd")));
  });

  it("does not sniff playlists for resource types outside the sniff set (D2/D10)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(makeResponseStartedEvent({
      url: "https://cdn.example.com/master.m3u8",
      type: "script",
      responseHeaders: headerList({ "content-type": "application/x-mpegurl" }),
    }));
    expect(item?.type).toBe("http_playlist");
  });
});

describe("engine: direct-file acceptance (OS, D14/D17)", () => {
  it("builds the full `http_playlist` item model", () => {
    const now = fixedNow(1_700_000_000_000);
    const engine = makeEngine(createGate(), now);
    engine.onSendHeaders(makeSendHeadersEvent({ requestId: "rq", timeStamp: 1_000_000 }));
    const item = engine.onResponseStarted(makeResponseStartedEvent({
      requestId: "rq",
      url: "https://cdn.example.com/media/movie.webm?token=1",
      responseHeaders: headerList({
        "content-type": "video/webm",
        "content-length": "2000000",
        "accept-ranges": "bytes",
        "content-disposition": 'attachment; filename="movie.webm"',
      }),
    }));
    expect(item).not.toBeNull();
    expect(item?.type).toBe("http_playlist");
    expect(item?.hash).toBe(directMediaHash(new URL("https://cdn.example.com/media/movie.webm?token=1")));
    expect(item?.is_youtube).toBe(false);
    expect(item?.discovery_timestamp_ms).toBe(1_700_000_000_000);
    expect(item?.cache).toBe("default");
    expect(item?.duration).toBe("unknown");
    expect(item?.has_drm).toBe(false);
    expect(item?.extension).toBe("mkv");
    expect(item?.libav_demuxer).toBe("webm");
    expect(item?.filename).toBe("movie");
    expect(item?.supports_byte_ranges).toBe(true);
    expect(item?.initiator?.href).toBe("https://site.example/watch");
    expect(item?.sent_headers.get("cookie")).toBe("a=b");
    expect(item?.sent_headers.get("referer")).toBe("https://site.example/watch");
    expect(item?.playlist).toHaveLength(1);
    const entry = item?.playlist?.[0];
    expect(entry?.demuxer).toBe("webm");
    expect(entry?.size).toBe(2_000_000);
    expect(entry?.av?.video instanceof URL).toBe(true);
    expect(entry?.av?.audio).toBe(false);
  });

  it("rejects files under 500000 bytes unless ALLOW_SMALL_FILE_DETECTION is on for the media host (D17)", () => {
    const small = makeResponseStartedEvent({
      url: "https://cdn.example.com/tiny.mp4",
      responseHeaders: headerList({ "content-type": "video/mp4", "content-length": "1000" }),
    });
    expect(makeEngine().onResponseStarted(small)).toBeNull();
    const allowed = makeEngine(createHostGate({ ALLOW_SMALL_FILE_DETECTION: ["cdn.example.com"] }));
    const item = allowed.onResponseStarted(small);
    expect(item).not.toBeNull();
    expect(item?.playlist?.[0]?.size).toBe(1000);
  });

  it("uses the content-range total in place of content-length for the size filters (D17)", () => {
    const engine = makeEngine();
    const accepted = engine.onResponseStarted(makeResponseStartedEvent({
      responseHeaders: headerList({
        "content-type": "video/mp4",
        "content-length": "400000",
        "content-range": "bytes 0-1999999/2000000",
      }),
    }));
    expect(accepted).not.toBeNull();
    expect(accepted?.playlist?.[0]?.size).toBe(2_000_000);
    expect(accepted?.supports_byte_ranges).toBe(true);
    const rejected = makeEngine().onResponseStarted(makeResponseStartedEvent({
      responseHeaders: headerList({
        "content-type": "video/mp4",
        "content-length": "3000000",
        "content-range": "bytes 0-999/1000",
      }),
    }));
    expect(rejected).toBeNull();
  });

  it("keeps an unknown size and accepts when the content-range total is `*` (D17)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(makeResponseStartedEvent({
      responseHeaders: headerList({ "content-type": "video/mp4", "content-range": "bytes 0-99/*" }),
    }));
    expect(item).not.toBeNull();
    expect(item?.playlist?.[0]?.size).toBeUndefined();
    expect(item?.supports_byte_ranges).toBe(true);
  });

  it("accepts type=media responses even without a recognised MIME (D10 tail)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(makeResponseStartedEvent({
      type: "media",
      url: "https://cdn.example.com/opaque",
      responseHeaders: headerList({ "content-type": "application/octet-stream", "content-length": "900000" }),
    }));
    expect(item).not.toBeNull();
    expect(item?.extension).toBe("mp4");
    expect(item?.playlist?.[0]?.demuxer).toBe("mp4");
  });

  it("ignores xhr responses with an unknown MIME and no playlist signal (D10 tail)", () => {
    const engine = makeEngine();
    expect(engine.onResponseStarted(makeResponseStartedEvent({
      type: "xmlhttprequest",
      url: "https://cdn.example.com/data",
      responseHeaders: headerList({ "content-type": "application/json" }),
    }))).toBeNull();
  });
});

describe("hash identity (be = cyrb53, D27)", () => {
  it.each(FIXTURE_HASHES)("cyrb53(%j, seed=$seed) = $expected", ({ input, seed, expected }) => {
    expect(cyrb53(input, seed ?? 0)).toBe(expected);
  });

  it("prefixes direct and playlist hashes with media_hash_ (D27)", () => {
    const url = new URL("https://example.com/a.mp4");
    expect(directMediaHash(url)).toBe(`media_hash_${cyrb53(url.href)}`);
    expect(hlsPlaylistHash("#EXTM3U", url)).toBe(`media_hash_${cyrb53("#EXTM3U" + url.href)}`);
    expect(dashPlaylistHash("<MPD/>")).toBe(`media_hash_${cyrb53("<MPD/>")}`);
  });

  it("recomputes the body-seeded HLS hash when a manifest is attached (D27)", () => {
    const engine = makeEngine();
    const text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\n720.m3u8";
    const candidate = engine.onResponseStarted(makeResponseStartedEvent({
      url: "https://cdn.example.com/master.m3u8",
      type: "xmlhttprequest",
      responseHeaders: headerList({ "content-type": "application/x-mpegurl" }),
    }));
    const oldHash = candidate!.hash;
    const childUrl = new URL("https://cdn.example.com/720.m3u8");
    const masterUrl = new URL("https://cdn.example.com/master.m3u8");
    const attached = engine.attachPlaylist(1, oldHash, [{ demuxer: "mp4", quality: {}, av: { video: childUrl, audio: false } }], {
      type: "m3u8_playlist",
      manifestText: text,
    });
    const expectedHash = hlsPlaylistHash(text, masterUrl);
    expect(attached?.hash).toBe(expectedHash);
    expect(attached?.type).toBe("m3u8_playlist");
    expect(attached?.master_url?.href).toBe(masterUrl.href);
    expect(attached?.url).toBeUndefined();
    expect(engine.mediaForTab(1).has(oldHash)).toBe(false);
    expect(engine.mediaForTab(1).has(expectedHash)).toBe(true);
  });

  it("recomputes the DASH hash from manifest text only, so same-text MPDs collapse (D27/U4)", () => {
    const engine = makeEngine();
    const text = "<MPD>same</MPD>";
    const first = engine.onResponseStarted(makeResponseStartedEvent({
      url: "https://cdn.example.com/one/manifest.mpd",
      type: "xmlhttprequest",
      responseHeaders: headerList({ "content-type": "application/dash+xml" }),
    }));
    const second = engine.onResponseStarted(makeResponseStartedEvent({
      url: "https://cdn.example.com/two/manifest.mpd",
      type: "xmlhttprequest",
      responseHeaders: headerList({ "content-type": "application/dash+xml" }),
    }));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const attachedFirst = engine.attachPlaylist(1, first!.hash, [], { manifestText: text, duration: 90 });
    const canonical = dashPlaylistHash(text);
    expect(attachedFirst?.hash).toBe(canonical);
    const attachedSecond = engine.attachPlaylist(1, second!.hash, [], { manifestText: text });
    expect(attachedSecond?.hash).toBe(canonical);
    expect(engine.mediaForTab(1).size).toBe(1);
  });
});
