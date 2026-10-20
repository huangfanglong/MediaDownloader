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
  AUDIO_CODEC_DEMUXER_ROWS,
  AUDIO_EXTENSIONS,
  BLOCKED_INITIATOR_HOSTS,
  CODEC_DEMUXER_ROWS,
  KNOWN_MEDIA_FILE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  MIME_DEMUXER_ROWS,
  SEGMENT_PATH_PATTERN,
  VIDEO_EXTENSIONS,
  codecToDemuxer,
  containerToMuxer,
  extensionFromUrl,
  isAudioExtension,
  isBlockedInitiatorHost,
  isMediaExtension,
  isVideoExtension,
  mimeToDemuxer,
  resolveMediaDescriptor,
  tryUrl,
  videoCodecToDemuxer,
  audioCodecToDemuxer,
} from "../src/discovery/classify.js";
import {
  DASH_CONTENT_TYPE_PATTERN,
  DASH_URL_PATTERN,
  DiscoveryEngine,
  EXTENSION_INITIATOR_PATTERN,
  FIFO_DISCOVERED_ITEM_CAP,
  HLS_CONTENT_TYPE_PATTERN,
  HLS_MASTER_API_PATTERN,
  HLS_URL_PATTERN,
  INITIATOR_SUPPRESSION_THRESHOLD_BYTES,
  MPD_EXTENSION_PATTERN,
  SAME_TYPE_ITEM_CAP,
  SEND_HEADERS_TTL_MS,
  SMALL_FILE_THRESHOLD_BYTES,
  dashPlaylistHash,
  directMediaHash,
  hlsPlaylistHash,
  type BehaviourGate,
} from "../src/discovery/engine.js";
import { cyrb53 } from "../src/protocol/channels.js";
import {
  FIXTURE_AUDIO_CODEC_ROWS,
  FIXTURE_AUDIO_EXTENSIONS,
  FIXTURE_BLOCKED_INITIATOR_HOSTS,
  FIXTURE_DESCRIPTORS,
  FIXTURE_FIFO_DISCOVERED_ITEM_CAP,
  FIXTURE_HASHES,
  FIXTURE_INITIATOR_SUPPRESSION_THRESHOLD_BYTES,
  FIXTURE_KNOWN_MEDIA_FILE_EXTENSIONS,
  FIXTURE_MEDIA_EXTENSIONS,
  FIXTURE_MIME_DEMUXER_ROWS,
  FIXTURE_REGEXES,
  FIXTURE_SAME_TYPE_ITEM_CAP,
  FIXTURE_SEND_HEADERS_TTL_MS,
  FIXTURE_SMALL_FILE_THRESHOLD_BYTES,
  FIXTURE_VIDEO_CODEC_ROWS,
  FIXTURE_VIDEO_EXTENSIONS,
  createGate,
  createHostGate,
  fixedNow,
  headerList,
  makeResponseStartedEvent,
  makeSendHeadersEvent,
} from "./fixtures/detection.js";

function makeEngine(
  flags: BehaviourGate = createGate(),
  now: () => number = fixedNow(),
): DiscoveryEngine {
  return new DiscoveryEngine({ flags, now });
}

const flattenMimeRows = (): unknown =>
  MIME_DEMUXER_ROWS.map((row) => ({
    source: row.regex.source,
    flags: row.regex.flags,
    audio: row.audio,
    video: row.video,
  }));

const flattenCodecRows = (
  rows: readonly { mime_regex: RegExp; demuxer: string; codec: string }[],
) =>
  rows.map((row) => ({
    source: row.mime_regex.source,
    flags: row.mime_regex.flags,
    demuxer: row.demuxer,
    codec: row.codec,
  }));

// ---------------------------------------------------------------------------
// Tables (D18-D22, D25)
// ---------------------------------------------------------------------------

describe("classification tables are verbatim recoveries", () => {
  it("exposes Nm/Rm/Ms extension lists (D18)", () => {
    expect([...VIDEO_EXTENSIONS]).toEqual([...FIXTURE_VIDEO_EXTENSIONS]);
    expect([...AUDIO_EXTENSIONS]).toEqual([...FIXTURE_AUDIO_EXTENSIONS]);
    expect([...MEDIA_EXTENSIONS]).toEqual([...FIXTURE_MEDIA_EXTENSIONS]);
  });

  it("exposes the 53-entry known-media-extension set (D19)", () => {
    expect([...KNOWN_MEDIA_FILE_EXTENSIONS]).toEqual([
      ...FIXTURE_KNOWN_MEDIA_FILE_EXTENSIONS,
    ]);
    expect(KNOWN_MEDIA_FILE_EXTENSIONS).toHaveLength(53);
  });

  it("exposes the 17-row MIME → demuxer table (D20)", () => {
    expect(MIME_DEMUXER_ROWS).toHaveLength(17);
    expect(flattenMimeRows()).toEqual(FIXTURE_MIME_DEMUXER_ROWS);
  });

  it("exposes the gv/hv codec tables (D21)", () => {
    expect(flattenCodecRows(CODEC_DEMUXER_ROWS)).toEqual(
      FIXTURE_VIDEO_CODEC_ROWS,
    );
    expect(flattenCodecRows(AUDIO_CODEC_DEMUXER_ROWS)).toEqual(
      FIXTURE_AUDIO_CODEC_ROWS,
    );
    expect(CODEC_DEMUXER_ROWS).toHaveLength(6);
    expect(AUDIO_CODEC_DEMUXER_ROWS).toHaveLength(4);
  });

  it("exposes the 11-entry blocked-initiator set (D25)", () => {
    expect([...BLOCKED_INITIATOR_HOSTS]).toEqual([
      ...FIXTURE_BLOCKED_INITIATOR_HOSTS,
    ]);
  });

  it("exposes the exact dispatch regexes and thresholds (D6/D9/D10/D17/D30)", () => {
    expect([SEGMENT_PATH_PATTERN.source, SEGMENT_PATH_PATTERN.flags]).toEqual(
      FIXTURE_REGEXES.segmentPath,
    );
    expect([
      HLS_CONTENT_TYPE_PATTERN.source,
      HLS_CONTENT_TYPE_PATTERN.flags,
    ]).toEqual(FIXTURE_REGEXES.hlsContentType);
    expect([HLS_URL_PATTERN.source, HLS_URL_PATTERN.flags]).toEqual(
      FIXTURE_REGEXES.hlsUrl,
    );
    expect([
      HLS_MASTER_API_PATTERN.source,
      HLS_MASTER_API_PATTERN.flags,
    ]).toEqual(FIXTURE_REGEXES.hlsMasterApi);
    expect([
      DASH_CONTENT_TYPE_PATTERN.source,
      DASH_CONTENT_TYPE_PATTERN.flags,
    ]).toEqual(FIXTURE_REGEXES.dashContentType);
    expect([DASH_URL_PATTERN.source, DASH_URL_PATTERN.flags]).toEqual(
      FIXTURE_REGEXES.dashUrl,
    );
    expect([MPD_EXTENSION_PATTERN.source, MPD_EXTENSION_PATTERN.flags]).toEqual(
      FIXTURE_REGEXES.mpdConversion,
    );
    expect([
      EXTENSION_INITIATOR_PATTERN.source,
      EXTENSION_INITIATOR_PATTERN.flags,
    ]).toEqual(FIXTURE_REGEXES.extensionInitiator);
    expect(SEND_HEADERS_TTL_MS).toBe(FIXTURE_SEND_HEADERS_TTL_MS);
    expect(SMALL_FILE_THRESHOLD_BYTES).toBe(FIXTURE_SMALL_FILE_THRESHOLD_BYTES);
    expect(INITIATOR_SUPPRESSION_THRESHOLD_BYTES).toBe(
      FIXTURE_INITIATOR_SUPPRESSION_THRESHOLD_BYTES,
    );
    expect(SAME_TYPE_ITEM_CAP).toBe(FIXTURE_SAME_TYPE_ITEM_CAP);
    expect(FIFO_DISCOVERED_ITEM_CAP).toBe(FIXTURE_FIFO_DISCOVERED_ITEM_CAP);
  });

  it("classifies extensions into audio/video/muxable groups (D18)", () => {
    for (const extension of FIXTURE_VIDEO_EXTENSIONS) {
      expect(isVideoExtension(extension)).toBe(true);
      expect(isAudioExtension(extension)).toBe(false);
      expect(isMediaExtension(extension)).toBe(true);
    }
    for (const extension of FIXTURE_AUDIO_EXTENSIONS) {
      expect(isVideoExtension(extension)).toBe(false);
      expect(isAudioExtension(extension)).toBe(true);
      expect(isMediaExtension(extension)).toBe(true);
    }
    expect(isMediaExtension("flv")).toBe(false);
    expect(isMediaExtension("MP4")).toBe(false); // callers lowercase first (D22)
  });

  it("normalises containers exactly like Gn/it/fv (D18)", () => {
    expect(containerToMuxer("mp4", "mp4")).toBe("mp4");
    expect(containerToMuxer("webm", "mp4")).toBe("mkv");
    expect(containerToMuxer("mkv", "mp4")).toBe("mkv");
    expect(containerToMuxer("mp3", "mp4")).toBe("mp3");
    expect(containerToMuxer("m4a", "mp4")).toBe("mp3");
    expect(containerToMuxer("ogg", "mp4")).toBe("mp3");
  });
});

// ---------------------------------------------------------------------------
// Pure classifiers (D20/D21/D22/D25)
// ---------------------------------------------------------------------------

describe("mimeToDemuxer (original Pf, D20)", () => {
  it.each([
    ["video/mp4", "mp4"],
    ["video/mp4; codecs=avc1.42E01E", "mp4"],
    ["audio/mp4", "mp3"],
    ["audio/mpeg", "mp3"],
    ["audio/ogg", "oga"],
    ["video/webm", "webm"],
    ["video/x-matroska", "mkv"],
    ["video/mp2t", "mp2t"],
    ["video/x-flv", "flv"],
    ["audio/x-m4a", "m4a"],
    ["application/x-mpegurl", "mpeg"],
    ["application/vnd.apple.mpegurl", "mpeg"],
    ["APPLICATION/X-MPEGURL", "mpeg"],
    ["application/octet-stream", undefined],
    ["video/quicktime", undefined],
    ["text/html", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("maps %j to %j", (contentType, expected) => {
    expect(mimeToDemuxer(contentType)).toBe(expected);
  });
});

describe("codecToDemuxer (original Zn/Mm, D21)", () => {
  it.each([
    ["avc1.64001f", "mp4"],
    ["avc3.64001f", "mp4"],
    ["hev1.1.6", "mp4"],
    ["hvc1.1.6", "mp4"],
    ["h265", "mp4"],
    ["h.265", "mp4"],
    ["mp4v.20.3", "mp4"],
    ["av01.0.04M", "webm"],
    ["av1", "webm"],
    ["vp08.00", "webm"],
    ["vp8", "webm"],
    ["vp09.00", "webm"],
    ["vp9", "webm"],
    ["h264", undefined],
    ["something-else", undefined],
    ["", undefined],
  ])("maps video codec %j to %j", (codec, expected) => {
    expect(videoCodecToDemuxer(codec)).toBe(expected);
  });

  it.each([
    ["aac", "m4a"],
    ["mp4a.40.2", "m4a"],
    ["mp4a.40.5", "m4a"],
    ["mp3", "mp3"],
    ["mp4a.69", "mp3"],
    ["mp4a.6b", "mp3"],
    ["opus", "ogg"],
    ["mp4a.ad", "ogg"],
    ["vorbis", "ogg"],
    ["avc1", undefined],
    ["", undefined],
  ])("maps audio codec %j to %j", (codec, expected) => {
    expect(audioCodecToDemuxer(codec)).toBe(expected);
  });

  it("codecToDemuxer scans video rows before audio rows", () => {
    expect(codecToDemuxer("avc1")).toBe("mp4");
    expect(codecToDemuxer("aac")).toBe("m4a");
    expect(codecToDemuxer("vorbis")).toBe("ogg");
    expect(codecToDemuxer("nope")).toBeUndefined();
  });
});

describe("extensionFromUrl (original Tf over de, D22)", () => {
  it.each([
    ["https://cdn.example.com/a.MP4", "mp4"],
    ["https://cdn.example.com/path/movie.webm?token=1#frag", "webm"],
    ["https://cdn.example.com/a.tar.gz", "gz"],
    ["https://cdn.example.com/path/", undefined],
    ["https://cdn.example.com/noext", undefined],
    ["not a url", undefined],
  ])("extracts extension from %j as %j", (url, expected) => {
    expect(extensionFromUrl(url)).toBe(expected);
  });
});

describe("segment path rejection (D9 step 3)", () => {
  it.each([
    ["/segments/1.ts", true],
    ["/segments/1.m4s", true],
    ["/segments/1.m2ts", true],
    ["/segments/1.TS", true],
    ["/segments/1.tsx", false],
    ["/media/video.mp4", false],
    ["/b-hls-08/73697527_693_x_1792462825_part0.mp4", true],
    ["/b-hls-08/73697527_init_jk9NeJb8Tz5Z882F.mp4", true],
  ])("matches %j -> %j", (pathname, expected) => {
    expect(SEGMENT_PATH_PATTERN.test(pathname)).toBe(expected);
  });
});

describe("blocked initiator hosts (D25)", () => {
  it.each([
    ["www.youtube.com", true],
    ["youtube.com", true],
    ["player.vimeo.com", true],
    ["vimeo.com", true],
    ["sub.vkvideo.ru", true],
    ["intl-api.iq.com", true],
    ["notvimeo.com", false],
    ["vimeo.com.evil.example", false],
    ["example.com", false],
  ])("isBlockedInitiatorHost(%j) -> %j", (hostname, expected) => {
    expect(isBlockedInitiatorHost(hostname)).toBe(expected);
  });
});

describe("resolveMediaDescriptor (original $S, D22)", () => {
  it.each(FIXTURE_DESCRIPTORS)("$name", (fixture) => {
    const url = tryUrl(fixture.url);
    expect(url).toBeDefined();
    const descriptor = resolveMediaDescriptor(
      fixture.contentDisposition,
      fixture.contentType,
      url!,
    );
    expect(descriptor).toEqual(fixture.expected);
  });
});

// ---------------------------------------------------------------------------
// Event pipeline truth table (D9/D10/D17)
// ---------------------------------------------------------------------------

describe("engine: response acceptance truth table", () => {
  it("rejects non-2xx responses (D9 step 1)", () => {
    const engine = makeEngine();
    expect(
      engine.onResponseStarted(makeResponseStartedEvent({ statusCode: 300 })),
    ).toBeNull();
    expect(
      engine.onResponseStarted(makeResponseStartedEvent({ statusCode: 199 })),
    ).toBeNull();
    expect(
      engine.onResponseStarted(makeResponseStartedEvent({ statusCode: 404 })),
    ).toBeNull();
  });

  it("rejects an initiator blocked by the BLOCK_MEDIA_DETECTION flag (D9 step 2)", () => {
    const engine = makeEngine(
      createHostGate({ BLOCK_MEDIA_DETECTION: ["site.example"] }),
    );
    expect(engine.onResponseStarted(makeResponseStartedEvent())).toBeNull();
  });

  it("rejects extension-page and non-http initiators (D9 step 2)", () => {
    const engine = makeEngine();
    expect(
      engine.onResponseStarted(
        makeResponseStartedEvent({
          initiator: "chrome-extension://abcdef/page.html",
        }),
      ),
    ).toBeNull();
    expect(
      engine.onResponseStarted(
        makeResponseStartedEvent({
          initiator: "moz-extension://abcdef/page.html",
        }),
      ),
    ).toBeNull();
    expect(
      engine.onResponseStarted(
        makeResponseStartedEvent({ initiator: "file:///tmp/page.html" }),
      ),
    ).toBeNull();
  });

  it("rejects segment responses before classification (D9 step 3)", () => {
    const engine = makeEngine();
    for (const segment of ["1.ts", "1.m4s", "1.m2ts"]) {
      expect(
        engine.onResponseStarted(
          makeResponseStartedEvent({
            url: `https://cdn.example.com/segments/${segment}`,
          }),
        ),
      ).toBeNull();
    }
  });

  it("rejects initiators on the site-adapter block list (D9 step 5 / D25)", () => {
    const engine = makeEngine();
    for (const hostname of [
      "www.youtube.com",
      "player.vimeo.com",
      "intl-api.iq.com",
    ]) {
      expect(
        engine.onResponseStarted(
          makeResponseStartedEvent({ initiator: `https://${hostname}/watch` }),
        ),
      ).toBeNull();
    }
  });

  it("rejects tab-less anonymous requests (D9 step 6)", () => {
    const engine = makeEngine();
    expect(
      engine.onResponseStarted(
        makeResponseStartedEvent({ tabId: 0, initiator: undefined }),
      ),
    ).toBeNull();
    expect(
      engine.onResponseStarted(
        makeResponseStartedEvent({ tabId: -1, initiator: undefined }),
      ),
    ).toBeNull();
  });

  it("produces but does not register items for tab-less requests with an http initiator (D29)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(
      makeResponseStartedEvent({ tabId: 0 }),
    );
    expect(item).not.toBeNull();
    expect(engine.tabIds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HLS / DASH dispatch (D10/D12/D13)
// ---------------------------------------------------------------------------

describe("engine: playlist sniffing branches", () => {
  it("detects HLS from the content-type (D10)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/blob?id=7",
        type: "xmlhttprequest",
        responseHeaders: headerList({
          "content-type": "application/vnd.apple.mpegurl",
        }),
      }),
    );
    expect(item).not.toBeNull();
    expect(item?.type).toBe("m3u8");
    expect(item?.url?.href).toBe("https://cdn.example.com/blob?id=7");
    expect(item?.hash).toBe(
      directMediaHash(new URL("https://cdn.example.com/blob?id=7")),
    ); // provisional (D27)
    expect(item?.duration).toBe("unknown");
    expect(item?.has_drm).toBe(false);
    expect(engine.mediaForTab(1).size).toBe(1);
  });

  it("detects HLS only from .m3u8 URLs and the master-API path (D10)", () => {
    for (const url of [
      "https://cdn.example.com/master.m3u8",
      "https://cdn.example.com/api/playlist/master/abc",
    ]) {
      const engine = makeEngine();
      const item = engine.onResponseStarted(
        makeResponseStartedEvent({
          url,
          type: "xmlhttprequest",
          responseHeaders: headerList({
            "content-type": "application/octet-stream",
          }),
        }),
      );
      expect(item?.type).toBe("m3u8");
    }
  });

  it("marks HLS candidates audio-only on AUDIO_ONLY_WEBSITES hosts (D12)", () => {
    const engine = makeEngine(
      createHostGate({ AUDIO_ONLY_WEBSITES: ["radio.example"] }),
    );
    const item = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/live.m3u8",
        type: "xmlhttprequest",
        initiator: "https://radio.example/player",
        responseHeaders: headerList({
          "content-type": "application/x-mpegurl",
        }),
      }),
    );
    expect(item?.type).toBe("m3u8");
    expect(item?.demuxer).toBe("mp3");
  });

  it("rewrites .mpd to .m3u8 only with CONVERT_MPD_URL_TO_M3U8 on the initiator host (D10)", () => {
    const response = makeResponseStartedEvent({
      url: "https://cdn.example.com/manifest.mpd",
      type: "xmlhttprequest",
      responseHeaders: headerList({
        "content-type": "application/octet-stream",
      }),
    });

    // Without the conversion flag the same .mpd request is caught by the DASH branch instead.
    const off = makeEngine();
    expect(off.onResponseStarted(response)?.type).toBe("mpd_playlist");

    const on = makeEngine(
      createHostGate({ CONVERT_MPD_URL_TO_M3U8: ["site.example"] }),
    );
    const item = on.onResponseStarted(response);
    expect(item?.type).toBe("m3u8");
    expect(item?.url?.href).toBe(
      "https://cdn.example.com/manifest.m3u8".replace(".mpd", ".m3u8"),
    );
  });

  it("matches CONVERT_MPD_URL_TO_M3U8 on URL.host, i.e. including a non-default port (D26 quirk)", () => {
    const event = makeResponseStartedEvent({
      url: "https://cdn.example.com/manifest.mpd",
      type: "xmlhttprequest",
      initiator: "https://site.example:8443/watch",
      responseHeaders: headerList({
        "content-type": "application/octet-stream",
      }),
    });
    const withoutPort = makeEngine(
      createHostGate({ CONVERT_MPD_URL_TO_M3U8: ["site.example"] }),
    );
    expect(withoutPort.onResponseStarted(event)?.type).toBe("mpd_playlist"); // flag missed -> DASH branch

    const withPort = makeEngine(
      createHostGate({ CONVERT_MPD_URL_TO_M3U8: ["site.example:8443"] }),
    );
    expect(withPort.onResponseStarted(event)?.type).toBe("m3u8");
  });

  it("detects DASH manifests (D10/D13)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/manifest.mpd",
        type: "xmlhttprequest",
        responseHeaders: headerList({ "content-type": "application/dash+xml" }),
      }),
    );
    expect(item).not.toBeNull();
    expect(item?.type).toBe("mpd_playlist");
    expect(item?.master_url?.href).toBe("https://cdn.example.com/manifest.mpd");
    expect(item?.playlist).toEqual([]);
    expect(item?.hash).toBe(
      directMediaHash(new URL("https://cdn.example.com/manifest.mpd")),
    );
  });

  it("does not sniff playlists for resource types outside the sniff set (D2/D10)", () => {
    // In production the listener filter never delivers `script` events; if one is fed to the
    // engine it only reaches the direct-file tail (MIME gate), never the playlist parsers.
    const engine = makeEngine();
    const item = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/master.m3u8",
        type: "script",
        responseHeaders: headerList({
          "content-type": "application/x-mpegurl",
        }),
      }),
    );
    expect(item?.type).toBe("http_playlist");
  });
});

// ---------------------------------------------------------------------------
// Direct-file decision (D14/D17)
// ---------------------------------------------------------------------------

describe("engine: direct-file acceptance (OS, D14/D17)", () => {
  it("builds the full `http_playlist` item model", () => {
    const now = fixedNow(1_700_000_000_000);
    const engine = makeEngine(createGate(), now);
    engine.onSendHeaders(
      makeSendHeadersEvent({ requestId: "rq", timeStamp: 1_000_000 }),
    );
    const item = engine.onResponseStarted(
      makeResponseStartedEvent({
        requestId: "rq",
        url: "https://cdn.example.com/media/movie.webm?token=1",
        responseHeaders: headerList({
          "content-type": "video/webm",
          "content-length": "2000000",
          "accept-ranges": "bytes",
          "content-disposition": 'attachment; filename="movie.webm"',
        }),
      }),
    );

    expect(item).not.toBeNull();
    expect(item?.type).toBe("http_playlist");
    expect(item?.hash).toBe(
      directMediaHash(
        new URL("https://cdn.example.com/media/movie.webm?token=1"),
      ),
    );
    expect(item?.is_youtube).toBe(false);
    expect(item?.discovery_timestamp_ms).toBe(1_700_000_000_000);
    expect(item?.cache).toBe("default");
    expect(item?.duration).toBe("unknown");
    expect(item?.has_drm).toBe(false);
    expect(item?.extension).toBe("mkv");
    expect(item?.libav_demuxer).toBe("webm");
    expect(item?.filename).toBe("movie"); // basename without extension (D22)
    expect(item?.supports_byte_ranges).toBe(true);
    expect(item?.initiator?.href).toBe("https://site.example/watch");
    expect(item?.sent_headers.get("cookie")).toBe("a=b");
    expect(item?.sent_headers.get("referer")).toBe(
      "https://site.example/watch",
    );
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
      responseHeaders: headerList({
        "content-type": "video/mp4",
        "content-length": "1000",
      }),
    });
    expect(makeEngine().onResponseStarted(small)).toBeNull();

    const allowed = makeEngine(
      createHostGate({ ALLOW_SMALL_FILE_DETECTION: ["cdn.example.com"] }),
    );
    const item = allowed.onResponseStarted(small);
    expect(item).not.toBeNull();
    expect(item?.playlist?.[0]?.size).toBe(1000);
  });

  it("uses the content-range total in place of content-length for the size filters (D17)", () => {
    const engine = makeEngine();
    const accepted = engine.onResponseStarted(
      makeResponseStartedEvent({
        responseHeaders: headerList({
          "content-type": "video/mp4",
          "content-length": "400000",
          "content-range": "bytes 0-1999999/2000000",
        }),
      }),
    );
    expect(accepted).not.toBeNull();
    expect(accepted?.playlist?.[0]?.size).toBe(2_000_000);
    expect(accepted?.supports_byte_ranges).toBe(true);

    const rejected = makeEngine().onResponseStarted(
      makeResponseStartedEvent({
        responseHeaders: headerList({
          "content-type": "video/mp4",
          "content-length": "3000000",
          "content-range": "bytes 0-999/1000",
        }),
      }),
    );
    expect(rejected).toBeNull();
  });

  it("keeps an unknown size and accepts when the content-range total is `*` (D17)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(
      makeResponseStartedEvent({
        responseHeaders: headerList({
          "content-type": "video/mp4",
          "content-range": "bytes 0-99/*",
        }),
      }),
    );
    expect(item).not.toBeNull();
    expect(item?.playlist?.[0]?.size).toBeUndefined();
    expect(item?.supports_byte_ranges).toBe(true);
  });

  it("accepts type=media responses even without a recognised MIME (D10 tail)", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(
      makeResponseStartedEvent({
        type: "media",
        url: "https://cdn.example.com/opaque",
        responseHeaders: headerList({
          "content-type": "application/octet-stream",
          "content-length": "900000",
        }),
      }),
    );
    expect(item).not.toBeNull();
    expect(item?.extension).toBe("mp4"); // $S fallback (D22)
    expect(item?.playlist?.[0]?.demuxer).toBe("mp4"); // Pf fallback (D14)
  });

  it("ignores xhr responses with an unknown MIME and no playlist signal (D10 tail)", () => {
    const engine = makeEngine();
    expect(
      engine.onResponseStarted(
        makeResponseStartedEvent({
          type: "xmlhttprequest",
          url: "https://cdn.example.com/data",
          responseHeaders: headerList({ "content-type": "application/json" }),
        }),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hash identity (D27)
// ---------------------------------------------------------------------------

describe("hash identity (be = cyrb53, D27)", () => {
  it.each(FIXTURE_HASHES)(
    "cyrb53(%j, seed=$seed) = $expected",
    ({ input, seed, expected }) => {
      expect(cyrb53(input, seed ?? 0)).toBe(expected);
    },
  );

  it("prefixes direct and playlist hashes with media_hash_ (D27)", () => {
    const url = new URL("https://example.com/a.mp4");
    expect(directMediaHash(url)).toBe(`media_hash_${cyrb53(url.href)}`);
    expect(hlsPlaylistHash("#EXTM3U", url)).toBe(
      `media_hash_${cyrb53("#EXTM3U" + url.href)}`,
    );
    expect(dashPlaylistHash("<MPD/>")).toBe(`media_hash_${cyrb53("<MPD/>")}`);
  });

  it("recomputes the body-seeded HLS hash when a manifest is attached (D27)", () => {
    const engine = makeEngine();
    const text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\n720.m3u8";
    const candidate = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/master.m3u8",
        type: "xmlhttprequest",
        responseHeaders: headerList({
          "content-type": "application/x-mpegurl",
        }),
      }),
    );
    const oldHash = candidate!.hash;
    const childUrl = new URL("https://cdn.example.com/720.m3u8");
    const masterUrl = new URL("https://cdn.example.com/master.m3u8");

    const attached = engine.attachPlaylist(
      1,
      oldHash,
      [{ demuxer: "mp4", quality: {}, av: { video: childUrl, audio: false } }],
      { type: "m3u8_playlist", manifestText: text },
    );
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
    const first = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/one/manifest.mpd",
        type: "xmlhttprequest",
        responseHeaders: headerList({ "content-type": "application/dash+xml" }),
      }),
    );
    const second = engine.onResponseStarted(
      makeResponseStartedEvent({
        url: "https://cdn.example.com/two/manifest.mpd",
        type: "xmlhttprequest",
        responseHeaders: headerList({ "content-type": "application/dash+xml" }),
      }),
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const attachedFirst = engine.attachPlaylist(1, first!.hash, [], {
      manifestText: text,
      duration: 90,
    });
    const canonical = dashPlaylistHash(text);
    expect(attachedFirst?.hash).toBe(canonical);

    const attachedSecond = engine.attachPlaylist(1, second!.hash, [], {
      manifestText: text,
    });
    expect(attachedSecond?.hash).toBe(canonical);
    expect(engine.mediaForTab(1).size).toBe(1);
  });
});

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
