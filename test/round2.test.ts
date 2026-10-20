// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  chooseThumbnail,
  collectHintsForPage,
  collectMediaHints,
  collectYouTubeInnerTubeHints,
  hintsFromYouTubePlayerResponse,
  youtubeVideoId,
} from "../src/extension/page-hook.js";
import { installContentBridge, itemFromHint } from "../src/extension/content-script.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { REBUILD_MESSAGES } from "../src/protocol/rebuild-messages.js";
import type { Envelope } from "../src/extension/gateways.js";

/** Minimal BroadcastChannel double (jsdom and Node disagree about Event classes). */
function createFakeChannel() {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  return {
    port: {
      postMessage: () => undefined,
      addEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => {
        listeners.push(listener);
      },
      removeEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
      close: () => undefined,
    } as unknown as BroadcastChannel,
    emit: (data: unknown) => {
      for (const listener of listeners) listener({ data });
    },
  };
}

describe("live player URLs beat stale player responses (YouTube regression)", () => {
  it("prefers the resource-timeline URL carrying a short-lived token", () => {
    (globalThis as Record<string, unknown>).ytInitialPlayerResponse = {
      streamingData: {
        formats: [{ url: "https://rr1.googlevideo.com/videoplayback?id=1&itag=18&mime=video%2Fmp4" }],
      },
    };
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const hints = collectMediaHints(document, "https://www.youtube.com/watch?v=x", [
      "https://rr2.googlevideo.com/videoplayback?id=1&itag=18&mime=video%2Fmp4&pot=live-token&expire=1&range=0-1000",
    ]);
    delete (globalThis as Record<string, unknown>).ytInitialPlayerResponse;
    expect(hints).toHaveLength(1);
    expect(hints[0]?.url).toContain("pot=live-token");
    expect(hints[0]?.url).not.toContain("range=0-1000");
  });
});

describe("page hints are validated input", () => {
  it("drops malformed hints and caps the array", () => {
    const sent: Envelope[] = [];
    const runtime = {
      sendMessage: async (message: Envelope) => {
        sent.push(message);
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    };
    const channel = createFakeChannel();
    const dispose = installContentBridge(runtime, "https://page.test/watch", channel.port);
    const good = Array.from({ length: 220 }, (_, index) => ({
      url: `https://cdn.test/v${index}.mp4`,
      source: "video",
      kind: "file",
    }));
    const hints = [...good, { url: 123 }, { url: "https://cdn.test/bad.mp4", extra: true }, null];
    channel.emit({
      channel: Channel.FromUntrustedInjectedToTrusted,
      msg: { name: "on_media_hints", data: { hints } },
    });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(200);
    dispose();
  });
});

describe("resource-timeline filtering (live 403 regression)", () => {
  it("ignores failed requests and prefers successful ones", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const hints = collectMediaHints(document, "https://www.youtube.com/watch?v=x", [
      { url: "https://rr1.googlevideo.com/videoplayback?id=1&itag=18&expire=1", status: 403, transferSize: 100 },
      { url: "https://rr2.googlevideo.com/videoplayback?id=1&itag=18&expire=1", status: 206, transferSize: 2000000 },
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.url).toContain("rr2.googlevideo.com");
  });
});

describe("YouTube InnerTube adapter (SABR-era fix)", () => {
  const playerResponse = (streaming: unknown) => ({
    playabilityStatus: { status: "OK" },
    streamingData: streaming,
  });

  it("extracts the video id from watch, shorts and youtu.be URLs", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=abc123")).toBe("abc123");
    expect(youtubeVideoId("https://youtu.be/xyz789")).toBe("xyz789");
    expect(youtubeVideoId("https://www.youtube.com/shorts/Sh0rt5")).toBe("Sh0rt5");
    expect(youtubeVideoId("https://example.com/watch?v=abc")).toBeUndefined();
  });

  it("requests VISIONOS with the full client context and returns the HLS master", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () =>
          playerResponse({
            hlsManifestUrl: "https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1/id/abc/index.m3u8",
            formats: [{ itag: 18, url: "https://rr1.googlevideo.com/videoplayback?id=1&itag=18" }],
          }),
      };
    }) as unknown as typeof fetch;
    (globalThis as Record<string, unknown>).ytcfg = {
      get: (key: string) =>
        ({ INNERTUBE_API_KEY: "api-key", VISITOR_DATA: "visitor-123", INNERTUBE_CLIENT_VERSION: "2.x" } as Record<string, string>)[key],
    };
    const hints = await collectYouTubeInnerTubeHints("https://www.youtube.com/watch?v=abc123", fetchMock);
    delete (globalThis as Record<string, unknown>).ytcfg;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(new Headers(calls[0]?.init?.headers).get("x-youtube-client-name")).toBe("101");
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      context: { client: Record<string, unknown> };
    };
    expect(body.context.client.clientName).toBe("VISIONOS");
    expect(body.context.client.deviceModel).toBe("RealityDevice17,1");
    expect(body.context.client.visitorData).toBe("visitor-123");
    expect(hints).toHaveLength(1);
    expect(hints[0]?.kind).toBe("hls");
    expect(hints[0]?.url).toContain("hls_variant");
  });

  it("returns no hints when only adaptive formats exist (no HLS, no muxer input)", async () => {
    const fetchMock = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        playabilityStatus: { status: "OK" },
        streamingData: {
          // No mimeType => not a usable avc1 video/audio pair, and no HLS manifest.
          adaptiveFormats: [{ itag: 137, url: "https://rr2.googlevideo.com/videoplayback?id=1&itag=137" }],
        },
      }),
    })) as unknown as typeof fetch;
    expect(await collectYouTubeInnerTubeHints("https://youtu.be/abc123", fetchMock)).toEqual([]);
  });

  it("collectHintsForPage on YouTube uses InnerTube only (no dead fallbacks)", async () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const withHls = (async () => ({
      ok: true,
      status: 200,
      json: async () =>
        playerResponse({
          hlsManifestUrl: "https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1/id/abc/index.m3u8",
        }),
    })) as unknown as typeof fetch;
    const hints = await collectHintsForPage("https://www.youtube.com/watch?v=abc123", document, [], withHls);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.kind).toBe("hls");
    const withoutMuxed = (async () => ({
      ok: true,
      status: 200,
      json: async () =>
        playerResponse({
          adaptiveFormats: [{ itag: 137, url: "https://rr2.googlevideo.com/videoplayback?id=1&itag=137" }],
        }),
    })) as unknown as typeof fetch;
    expect(await collectHintsForPage("https://www.youtube.com/watch?v=other999", document, [], withoutMuxed)).toEqual([]);
  });
});

describe("adaptive audio+video pair (YouTube visionOS formats)", () => {
  it("returns one hint carrying the paired audio track", async () => {
    const fetchMock = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        playabilityStatus: { status: "OK" },
        streamingData: {
          adaptiveFormats: [
            { itag: 137, mimeType: "video/mp4; codecs=\"avc1.640028\"", url: "https://rr1.googlevideo.com/videoplayback?itag=137&clen=1000" },
            { itag: 140, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"", url: "https://rr1.googlevideo.com/videoplayback?itag=140&clen=100" },
          ],
        },
      }),
    })) as unknown as typeof fetch;
    const hints = await collectYouTubeInnerTubeHints("https://youtu.be/abc123", fetchMock);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.kind).toBe("file");
    expect(hints[0]?.url).toContain("itag=137");
    expect(hints[0]?.audio_url).toContain("itag=140");
  });

  it("maps the pair to a two-source media item and plan", async () => {
    const item = itemFromHint(
      {
        url: "https://rr1.googlevideo.com/videoplayback?itag=137&clen=1000",
        audio_url: "https://rr1.googlevideo.com/videoplayback?itag=140&clen=100",
        source: "player-response",
        kind: "file",
      },
      "https://www.youtube.com/watch?v=abc",
    );
    expect(item).toBeDefined();
    expect(item?.playlist?.[0]?.av?.video).toBeInstanceOf(URL);
    expect(item?.playlist?.[0]?.av?.audio).toBeInstanceOf(URL);
    expect(item?.libav_demuxer).toBe("mp4");
    expect(item?.extension).toBe("mp4");
    expect(item?.supports_byte_ranges).toBe(true);
  });
});

describe("media thumbnails", () => {
  it("uses the YouTube thumbnail for watch pages", () => {
    expect(chooseThumbnail(document, "https://www.youtube.com/watch?v=abc123")).toBe(
      "https://i.ytimg.com/vi/abc123/maxresdefault.jpg",
    );
  });

  it("reads og:image, the video poster and link rel=image_src", () => {
    document.head.innerHTML = `<meta property="og:image" content="https://cdn.test/og.jpg">`;
    document.body.innerHTML = "";
    expect(chooseThumbnail(document, "https://page.test/watch")).toBe("https://cdn.test/og.jpg");

    document.head.innerHTML = "";
    document.body.innerHTML = `<video poster="/poster.jpg"></video>`;
    expect(chooseThumbnail(document, "https://page.test/watch")).toBe("https://page.test/poster.jpg");

    document.head.innerHTML = `<link rel="image_src" href="/thumb.png">`;
    document.body.innerHTML = "";
    expect(chooseThumbnail(document, "https://page.test/watch")).toBe("https://page.test/thumb.png");
  });

  it("maps a hint thumbnail onto the media item", () => {
    const item = itemFromHint(
      {
        url: "https://cdn.test/clip.mp4",
        thumbnail: "https://cdn.test/thumb.jpg",
        source: "video",
        kind: "file",
      },
      "https://page.test/watch",
    );
    expect(item?.thumbnail_url?.href).toBe("https://cdn.test/thumb.jpg");
  });
});

describe("focused media selection (QOL parity)", () => {
  it("reports the focused hint and forwards the focused URLs to the service", () => {
    const sent: Envelope[] = [];
    const runtime = {
      sendMessage: async (message: Envelope) => {
        sent.push(message);
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    };
    const channel = createFakeChannel();
    const dispose = installContentBridge(runtime, "https://www.instagram.com/p/abc", channel.port);
    channel.emit({
      channel: Channel.FromUntrustedInjectedToTrusted,
      msg: {
        name: "on_media_hints",
        data: {
          hints: [
            { url: "https://cdn.test/v/a.mp4", source: "resource-entry", kind: "file" },
            { url: "https://cdn.test/v/b.mp4", source: "resource-entry", kind: "file", focused: true },
          ],
          focus_active: true,
          focused_urls: ["https://cdn.test/v/b.mp4"],
        },
      },
    });
    const mediaMessages = sent.filter((message) => message.msg.name === MSG.injectedToService.OnMedia);
    expect(mediaMessages).toHaveLength(1);
    const focusMessages = sent.filter((message) => message.msg.name === REBUILD_MESSAGES.MediaFocus);
    expect(focusMessages).toHaveLength(1);
    expect((focusMessages[0]?.msg.data as { urls: string[] }).urls).toEqual(["https://cdn.test/v/b.mp4"]);
    dispose();
  });
});

describe("stable YouTube identity (duplicate row regression)", () => {
  it("hashes the same video/itags equally across rotated signed URLs", () => {
    const page = "https://www.youtube.com/watch?v=abc123";
    const first = itemFromHint(
      {
        url: "https://rr1---sn-x.googlevideo.com/videoplayback?id=o-A1&itag=136&sig=old",
        audio_url: "https://rr1---sn-x.googlevideo.com/videoplayback?id=o-A1&itag=140&sig=old",
        source: "player-response",
        kind: "file",
      },
      page,
    );
    const second = itemFromHint(
      {
        url: "https://rr1---sn-x.googlevideo.com/videoplayback?id=o-B2&itag=136&sig=new",
        audio_url: "https://rr1---sn-x.googlevideo.com/videoplayback?id=o-B2&itag=140&sig=new",
        source: "player-response",
        kind: "file",
      },
      page,
    );
    expect(first?.hash).toBe(second?.hash);
    const differentTrack = itemFromHint(
      {
        url: "https://rr1---sn-x.googlevideo.com/videoplayback?id=o-C3&itag=137&sig=x",
        audio_url: "https://rr1---sn-x.googlevideo.com/videoplayback?id=o-C3&itag=140&sig=x",
        source: "player-response",
        kind: "file",
      },
      page,
    );
    // Quality is a property of the item's playlist entries, not of its identity.
    expect(differentTrack?.hash).toBe(first?.hash);
  });

  it("maps the quality variants into ordered playlist entries", () => {
    const item = itemFromHint(
      {
        url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=137&clen=10",
        audio_url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=140&clen=2",
        variants: [
          { url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=137&clen=10", audio_url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=140&clen=2", height: 1080, width: 1920, bitrate: 4_000_000 },
          { url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=136&clen=8", audio_url: "https://rr1---sn-x.googlevideo.com/videoplayback?itag=140&clen=2", height: 720, width: 1280, bitrate: 2_000_000 },
        ],
        source: "player-response",
        kind: "file",
      },
      "https://www.youtube.com/watch?v=abc123",
    );
    expect(item?.playlist).toHaveLength(2);
    expect(item?.playlist?.[0]?.quality.size).toEqual({ height: 1080, width: 1920 });
    expect(item?.playlist?.[0]?.quality.bitrate).toBe(4_000_000);
    expect(item?.playlist?.[1]?.quality.size).toEqual({ height: 720, width: 1280 });
  });

  it("keeps URL-based identity for non-YouTube, non-Instagram pages", () => {
    const one = itemFromHint(
      { url: "https://cdn.test/a.mp4?sig=1", source: "video", kind: "file" },
      "https://site.test/watch",
    );
    const two = itemFromHint(
      { url: "https://cdn.test/a.mp4?sig=2", source: "video", kind: "file" },
      "https://www.instagram.com/p/abc",
    );
    expect(one?.hash).not.toBe(two?.hash);
  });

  it("collapses rotating signed queries for the same Instagram CDN path", () => {
    const page = "https://www.instagram.com/p/abc";
    const one = itemFromHint({ url: "https://cdn.test/v/a.mp4?sig=1", source: "video", kind: "file" }, page);
    const two = itemFromHint({ url: "https://cdn.test/v/a.mp4?sig=2", source: "video", kind: "file" }, page);
    expect(one?.hash).toBe(two?.hash);
  });
});

const youtubePlayerResponseSample = {
  playabilityStatus: { status: "OK" },
  streamingData: {
    adaptiveFormats: [
      { url: "https://rr1.googlevideo.com/videoplayback?itag=137&clen=1000000", mimeType: "video/mp4; codecs=\"avc1.640028\"", itag: 137, width: 1920, height: 1080, bitrate: 4_000_000 },
      { url: "https://rr1.googlevideo.com/videoplayback?itag=140&clen=200000", mimeType: "audio/mp4; codecs=\"mp4a.40.2\"", itag: 140, bitrate: 128_000 },
      { url: "https://rr1.googlevideo.com/videoplayback?itag=248&clen=900000", mimeType: "video/webm; codecs=\"vp9\"", itag: 248, width: 1920, height: 1080, bitrate: 3_000_000 },
      { url: "https://rr1.googlevideo.com/videoplayback?itag=251&clen=180000", mimeType: "audio/webm; codecs=\"opus\"", itag: 251, bitrate: 96_000 },
    ],
  },
};

describe("YouTube player-response parsing + page fallback", () => {
  it("builds MP4 and WEBM variants with matching audio", () => {
    const hints = hintsFromYouTubePlayerResponse(youtubePlayerResponseSample as never);
    expect(hints).toHaveLength(1);
    const hint = hints[0];
    expect(hint?.variants).toHaveLength(2);
    expect(hint?.variants?.[0]?.demuxer).toBe("mp4");
    expect(hint?.variants?.[0]?.audio_url).toContain("itag=140");
    expect(hint?.variants?.[1]?.demuxer).toBe("webm");
    expect(hint?.variants?.[1]?.audio_url).toContain("itag=251");
    expect(hint?.audio_url).toContain("itag=140");
  });

  it("uses the page player response when the InnerTube request is blocked", async () => {
    (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = youtubePlayerResponseSample;
    try {
      const blockedFetch = (async () => {
        throw new Error("network blocked");
      }) as unknown as typeof fetch;
      const hints = await collectYouTubeInnerTubeHints(
        "https://www.youtube.com/watch?v=abc123",
        blockedFetch,
      );
      expect(hints).toHaveLength(1);
      expect(hints[0]?.variants).toHaveLength(2);
    } finally {
      delete (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
    }
  });

  it("returns no hints and logs a reason when every response is LOGIN_REQUIRED", async () => {
    (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = {
      playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you?re not a bot" },
    };
    const fetchMock = (async () =>
      new Response(JSON.stringify({ playabilityStatus: { status: "LOGIN_REQUIRED" } }), { status: 200 })) as unknown as typeof fetch;
    try {
      expect(await collectYouTubeInnerTubeHints("https://www.youtube.com/watch?v=abc123", fetchMock)).toEqual([]);
    } finally {
      delete (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
    }
  });
});

describe("YouTube progressive-URL regression (0.9.2)", () => {
  it("never turns a progressive WEB page format into a broken single-quality item", () => {
    const hints = hintsFromYouTubePlayerResponse({
      playabilityStatus: { status: "OK" },
      streamingData: { formats: [{ itag: 18, url: "https://rr1.googlevideo.com/videoplayback?itag=18&c=WEB" }] },
    } as never);
    expect(hints).toEqual([]);
  });

  it("still uses InnerTube adaptive formats when the page response has only progressive URLs", async () => {
    (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = {
      playabilityStatus: { status: "OK" },
      streamingData: { formats: [{ itag: 18, url: "https://rr1.googlevideo.com/videoplayback?itag=18&c=WEB" }] },
    };
    const fetchMock = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        playabilityStatus: { status: "OK" },
        streamingData: {
          adaptiveFormats: [
            { itag: 137, mimeType: "video/mp4; codecs=\"avc1.640028\"", url: "https://rr1.googlevideo.com/videoplayback?itag=137&clen=1000" },
            { itag: 140, mimeType: "audio/mp4; codecs=\"mp4a.40.2\"", url: "https://rr1.googlevideo.com/videoplayback?itag=140&clen=100" },
          ],
        },
      }),
    })) as unknown as typeof fetch;
    try {
      const hints = await collectYouTubeInnerTubeHints("https://www.youtube.com/watch?v=abc123", fetchMock);
      expect(hints).toHaveLength(1);
      expect(hints[0]?.url).toContain("itag=137");
      expect(hints[0]?.variants).toHaveLength(1);
    } finally {
      delete (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
    }
  });

  it("returns nothing when every client fails and the page only has progressive URLs", async () => {
    (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse = {
      playabilityStatus: { status: "OK" },
      streamingData: { formats: [{ itag: 18, url: "https://rr1.googlevideo.com/videoplayback?itag=18&c=WEB" }] },
    };
    const blocked = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ playabilityStatus: { status: "LOGIN_REQUIRED" } }),
    })) as unknown as typeof fetch;
    try {
      expect(await collectYouTubeInnerTubeHints("https://www.youtube.com/watch?v=abc123", blocked)).toEqual([]);
    } finally {
      delete (globalThis as { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
    }
  });
});

describe("YouTube empty-result retry (0.9.3)", () => {
  it("retries after 5 seconds instead of caching an empty result for a minute", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchMock = (async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () =>
            calls <= 5
              ? { playabilityStatus: { status: "OK" } }
              : {
                  playabilityStatus: { status: "OK" },
                  streamingData: {
                    adaptiveFormats: [
                      { itag: 137, mimeType: 'video/mp4; codecs="avc1"', url: "https://rr1.googlevideo.com/videoplayback?itag=137&clen=1000" },
                      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a"', url: "https://rr1.googlevideo.com/videoplayback?itag=140&clen=100" },
                    ],
                  },
                },
        };
      }) as unknown as typeof fetch;
      const pageUrl = "https://www.youtube.com/watch?v=retry12345";
      expect(await collectHintsForPage(pageUrl, document, [], fetchMock)).toEqual([]);
      vi.advanceTimersByTime(5_100);
      const hints = await collectHintsForPage(pageUrl, document, [], fetchMock);
      expect(hints).toHaveLength(1);
      expect(calls).toBeGreaterThan(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AV1/HEVC adaptive fallback (0.9.4)", () => {
  it("accepts AV1 video with MP4 audio when no AVC1 rendition is offered", () => {
    const hints = hintsFromYouTubePlayerResponse({
      playabilityStatus: { status: "OK" },
      streamingData: {
        adaptiveFormats: [
          { itag: 399, mimeType: 'video/mp4; codecs="av01.0.08M.08"', url: "https://rr1.googlevideo.com/videoplayback?itag=399&clen=1000", width: 1920, height: 1080, bitrate: 2_000_000 },
          { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', url: "https://rr1.googlevideo.com/videoplayback?itag=140&clen=100" },
        ],
      },
    } as never);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.variants?.[0]?.demuxer).toBe("mp4");
    expect(hints[0]?.variants?.[0]?.url).toContain("itag=399");
    expect(hints[0]?.audio_url).toContain("itag=140");
  });
});

describe("cookie-backed WEB/MWEB fallback", () => {
  it("uses the WEB client when all pseudo-device clients are LOGIN_REQUIRED", async () => {
    let call = 0;
    const fetchMock = (async () => {
      call += 1;
      if (call <= 4) {
        return { ok: true, status: 200, json: async () => ({ playabilityStatus: { status: "LOGIN_REQUIRED" } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          playabilityStatus: { status: "OK" },
          streamingData: {
            adaptiveFormats: [
              { itag: 137, mimeType: 'video/mp4; codecs="avc1"', url: "https://rr1.googlevideo.com/videoplayback?itag=137&clen=1000" },
              { itag: 140, mimeType: 'audio/mp4; codecs="mp4a"', url: "https://rr1.googlevideo.com/videoplayback?itag=140&clen=100" },
            ],
          },
        }),
      };
    }) as unknown as typeof fetch;
    const hints = await collectYouTubeInnerTubeHints("https://www.youtube.com/watch?v=webclients", fetchMock);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.url).toContain("itag=137");
    expect(call).toBe(5);
  });
});
