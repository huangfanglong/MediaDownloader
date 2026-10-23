// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  applyFocusToHints,
  collectHintsForPage,
  collectMediaHints,
  hintsFromYouTubePlayerResponse,
  instagramMediaId,
  instagramShortcode,
} from "../src/extension/page-hook.js";
import { installContentBridge, itemFromHint } from "../src/extension/content-script.js";
import { classifyHintUrl } from "../src/extension/media-hint.js";
import {
  buildPanelSnapshot,
  formatLabel,
  mediaLabel,
  panelMediaSignature,
  PREVIEW_WINDOW_SECONDS,
  previewStartSeconds,
} from "../src/extension/panel-snapshot.js";
import { Channel } from "../src/protocol/channels.js";
import { MSG } from "../src/protocol/messages.js";
import { decode } from "../src/protocol/serde.js";
import type { MediaItem, TabMeta } from "../src/core/types.js";
import type { Envelope } from "../src/extension/gateways.js";

/** Minimal BroadcastChannel double: jsdom and Node disagree about Event classes. */
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

const meta: TabMeta = {
  incognito: false,
  tab_id: 3,
  title: "Page title",
  default_action: "download",
  smartnaming_rule: {
    template: "%title",
    selector: null,
    max_length: 64,
    replace: [],
    subdir: "",
    force_doc_title: false,
  },
};

const item = (overrides: Partial<MediaItem> = {}): MediaItem => ({
  type: "http_playlist",
  hash: "media_hash_42",
  is_youtube: false,
  sent_headers: new Headers(),
  playlist: [{ demuxer: "mp4", quality: {}, av: { video: new URL("https://cdn.test/a.mp4"), audio: false } }],
  extension: "mp4",
  duration: 95,
  discovery_timestamp_ms: 1,
  cache: "default",
  ...overrides,
});

describe("page hook (MAIN world)", () => {
  it("collects video, source, og:video and JSON-LD URLs in order, de-duplicated", () => {
    document.head.innerHTML = `
      <meta property="og:video" content="https://cdn.test/og.mp4" />
      <script type="application/ld+json">{"contentUrl":"https:\\/\\/cdn.test\\/ld.mp4"}</script>
    `;
    document.body.innerHTML = `
      <video src="/relative.mp4"><source src="https://cdn.test/source.webm" /></video>
      <video src="/relative.mp4"></video>
    `;
    const hints = collectMediaHints(document, "https://page.test/watch");
    expect(hints.map((hint) => hint.url)).toEqual([
      "https://page.test/relative.mp4",
      "https://cdn.test/og.mp4",
      "https://cdn.test/ld.mp4",
    ]);
    expect(hints.map((hint) => hint.source)).toEqual(["video", "og:video", "json-ld"]);
    // The video and its source are one item with two selectable renditions, not two rows.
    expect(hints[0]?.variants?.map((variant) => variant.url)).toEqual([
      "https://page.test/relative.mp4",
      "https://cdn.test/source.webm",
    ]);
  });

  it("ignores non-http media URLs", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<video src="blob:https://page.test/123"></video>`;
    expect(collectMediaHints(document, "https://page.test/watch")).toEqual([]);
  });
});

describe("content-script adapter (ISOLATED world)", () => {
  it("turns a page hint into the proven media item shape", () => {
    const produced = itemFromHint({ url: "https://cdn.test/movie.mp4", source: "video", kind: "file" }, "https://page.test/watch");
    expect(produced).toMatchObject({
      type: "http_playlist",
      hash: expect.stringMatching(/^media_hash_\d+$/),
      is_youtube: false,
      extension: "mp4",
      libav_demuxer: "mp4",
      supports_byte_ranges: false,
      cache: "default",
    });
    expect(produced?.playlist?.[0]?.av).toEqual({ video: new URL("https://cdn.test/movie.mp4"), audio: false });
  });

  it("reports hints to the service worker as channel-0 on_media envelopes", () => {
    const sent: Envelope[] = [];
    const runtime = {
      sendMessage: async (message: Envelope) => {
        sent.push(message);
        return undefined;
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    };
    const channel = createFakeChannel();
    const dispose = installContentBridge(runtime, "https://page.test/watch", channel.port);
    channel.emit({
      channel: Channel.FromUntrustedInjectedToTrusted,
      msg: { name: "on_media_hints", data: { hints: [{ url: "https://cdn.test/one.mp4", source: "video" }] } },
    });
    expect(sent).toHaveLength(1);
    const envelope = sent[0];
    expect(envelope?.channel).toBe(Channel.FromInjectedToService);
    expect(envelope?.msg.name).toBe(MSG.injectedToService.OnMedia);
    const decoded = decode((envelope?.msg.data as { media: unknown }).media) as MediaItem;
    expect(decoded.playlist?.[0]?.av).toEqual({ video: new URL("https://cdn.test/one.mp4"), audio: false });
    dispose();
  });

  it("duplicates are reported once", () => {
    const sent: Envelope[] = [];
    const runtime = {
      sendMessage: async (message: Envelope) => {
        sent.push(message);
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    };
    const channel = createFakeChannel();
    const dispose = installContentBridge(runtime, "https://page.test/watch", channel.port);
    const hints = { hints: [{ url: "https://cdn.test/same.mp4", source: "video" as const }] };
    for (let index = 0; index < 3; index++) {
      channel.emit({
        channel: Channel.FromUntrustedInjectedToTrusted,
        msg: { name: "on_media_hints", data: hints },
      });
    }
    expect(sent).toHaveLength(1);
    dispose();
  });

  it("dedupes repeated multi-quality items and only bypasses for a richer rendition list", () => {
    const sent: Envelope[] = [];
    const runtime = {
      sendMessage: async (message: Envelope) => {
        sent.push(message);
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    };
    const channel = createFakeChannel();
    const dispose = installContentBridge(runtime, "https://page.test/watch", channel.port);
    const emit = (variants?: unknown[]) =>
      channel.emit({
        channel: Channel.FromUntrustedInjectedToTrusted,
        msg: {
          name: "on_media_hints",
          data: {
            hints: [{ url: "https://cdn.test/same.mp4", source: "video", ...(variants === undefined ? {} : { variants }) }],
          },
        },
      });
    emit();
    expect(sent).toHaveLength(1);
    emit([
      { url: "https://cdn.test/same-720.mp4", width: 1280, height: 720 },
      { url: "https://cdn.test/same-1080.mp4", width: 1920, height: 1080 },
    ]);
    expect(sent).toHaveLength(2);
    emit([
      { url: "https://cdn.test/same-720.mp4", width: 1280, height: 720 },
      { url: "https://cdn.test/same-1080.mp4", width: 1920, height: 1080 },
    ]);
    expect(sent).toHaveLength(2);
    dispose();
  });

  it("does not throw on a malformed page referer or non-object hint payload", () => {
    const sent: Envelope[] = [];
    const runtime = {
      sendMessage: async (message: Envelope) => {
        sent.push(message);
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    };
    const channel = createFakeChannel();
    const dispose = installContentBridge(runtime, "https://page.test/watch", channel.port);
    expect(() =>
      channel.emit({
        channel: Channel.FromUntrustedInjectedToTrusted,
        msg: { name: "on_media_hints", data: null },
      }),
    ).not.toThrow();
    expect(() =>
      channel.emit({
        channel: Channel.FromUntrustedInjectedToTrusted,
        msg: {
          name: "on_media_hints",
          data: { hints: [{ url: "https://cdn.test/one.mp4", source: "video", referer: "https://[bad" }] },
        },
      }),
    ).not.toThrow();
    expect(sent).toHaveLength(1);
    dispose();
  });
});

describe("panel snapshot (UI contract)", () => {
  it("projects media, downloads and notifications into plain JSON", () => {
    const snapshot = buildPanelSnapshot({
      tabId: 3,
      meta,
      media: new Map([[item().hash, item()]]),
      downloading: new Map([["download_1", { status: "downloading", percent: 42.5, bitrate: 1200 }]]),
      notifications: new Map([["n1", { type: "download_error", details: "boom" }]]),
    });
    expect(snapshot).toEqual({
      tab_id: 3,
      page_url: undefined,
      page_title: "Page title",
      default_action: "download",
      media: [
        {
          hash: "media_hash_42",
          type: "http_playlist",
          label: "Page title.mp4",
          extension: "mp4",
          duration: 95,
          variants: [{ index: 0, label: "MP4" }],
          preview: "https://cdn.test/a.mp4",
          source: "FMT",
          sources: [{ value: "fmt", label: "FMT" }],
          has_drm: false,
        },
      ],
      downloading: [{ download_id: "download_1", status: "downloading", percent: 42.5, bitrate: 1200 }],
      notifications: [{ type: "download_error", message: "boom" }],
    });
    // Must survive the message bus unchanged (no Map/URL/Headers values).
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("offers FMT and HLS sources when the player exposes both", () => {
    const media = item({
      type: "http_playlist",
      hls_url: new URL("https://cdn.test/master.m3u8"),
    });
    const snapshot = buildPanelSnapshot({ media: [media], downloading: new Map(), notifications: new Map() });
    expect(snapshot.media[0]?.source).toBe("FMT");
    expect(snapshot.media[0]?.sources).toEqual([
      { value: "fmt", label: "FMT" },
      { value: "hls", label: "HLS" },
    ]);
  });

  it("marks DASH rows unavailable instead of offering a failing download", () => {
    const snapshot = buildPanelSnapshot({
      media: [item({ type: "mpd_playlist", master_url: new URL("https://cdn.test/manifest.mpd") })],
      downloading: new Map(),
      notifications: new Map(),
    });

    expect(snapshot.media[0]?.download_disabled_reason).toBe("DASH downloads are not supported yet");
  });

  it("falls back to the media type when no title is available", () => {
    expect(mediaLabel(item({ hash: "media_hash_abcdef" }), undefined)).toBe("http_playlist abcdef.mp4");
  });

  it("exposes a thumbnail URL for the panel", () => {
    const snapshot = buildPanelSnapshot({
      media: [item({ thumbnail_url: new URL("https://cdn.test/thumb.jpg") })],
      downloading: new Map(),
      notifications: new Map(),
    });
    expect(snapshot.media[0]?.thumbnail).toBe("https://cdn.test/thumb.jpg");
  });

  it("does not show the MKV note for YouTube adaptive WebM renditions", () => {
    const media = item({
      is_youtube: true,
      type: "http_playlist",
      extension: "webm",
      playlist: [
        {
          demuxer: "webm",
          quality: { size: { width: 1920, height: 1080 }, bitrate: 2_000_000 },
          av: {
            video: new URL("https://rr1---sn.test.googlevideo.com/videoplayback?itag=248"),
            audio: new URL("https://rr1---sn.test.googlevideo.com/videoplayback?itag=251"),
          },
        },
      ],
    });
    const snapshot = buildPanelSnapshot({ media: [media], downloading: new Map(), notifications: new Map() });
    expect(snapshot.media[0]?.variants?.[0]?.container).toBeUndefined();
    expect(snapshot.media[0]?.muxNote).toBeUndefined();
  });

  it("explains the MKV container Auto uses for WEBM video with AAC audio", () => {
    const media = item({
      type: "http_playlist",
      extension: "webm",
      playlist: [
        {
          demuxer: "webm",
          quality: { size: { width: 1920, height: 1076 }, bitrate: 155_000 },
          av: {
            video: new URL("https://cdn.test/instagram-video.webm"),
            audio: new URL("https://cdn.test/instagram-audio.m4a"),
          },
        },
      ],
    });
    const snapshot = buildPanelSnapshot({ media: [media], downloading: new Map(), notifications: new Map() });
    expect(snapshot.media[0]?.variants?.[0]?.label).toContain("WEBM video");
    expect(snapshot.media[0]?.variants?.[0]?.container).toBe("mkv");
    expect(snapshot.media[0]?.muxNote).toContain("saves as MKV");
  });

  it("uses rendered size and estimated bitrate when a manifest has no quality metadata", () => {
    const media = item({
      type: "m3u8",
      extension: undefined,
      playlist: undefined,
      rendered_width: 1920,
      rendered_height: 1080,
      estimated_bitrate: 1_000_000,
      thumbnail_url: new URL("https://cdn.test/thumb.jpg"),
    });
    const snapshot = buildPanelSnapshot({ media: [media], downloading: new Map(), notifications: new Map() });
    expect(snapshot.media[0]?.variants?.[0]?.label).toBe("MP4 · 1920x1080 · 125KB/s");
  });

  it("shows a human-readable format instead of the internal media type", () => {
    expect(formatLabel({ type: "http_playlist", extension: "mp4" })).toBe("MP4");
    expect(formatLabel({ type: "m3u8_playlist" })).toBe("HLS");
    expect(formatLabel({ type: "mpd_playlist" })).toBe("DASH");
    expect(formatLabel({ type: "http_playlist" })).toBeUndefined();
  });

  it("exposes quality variants and the hover preview track", () => {
    const media = item({
      thumbnail_url: new URL("https://cdn.test/thumb.jpg"),
      playlist: [
        {
          demuxer: "mp4",
          quality: { size: { height: 1080, width: 1920 }, bitrate: 4_000_000 },
          av: { video: new URL("https://cdn.test/v1080.mp4"), audio: new URL("https://cdn.test/a.m4a") },
        },
        {
          demuxer: "mp4",
          quality: { size: { height: 720, width: 1280 }, bitrate: 2_000_000 },
          av: { video: new URL("https://cdn.test/v720.mp4"), audio: new URL("https://cdn.test/a.m4a") },
        },
      ],
    });
    const snapshot = buildPanelSnapshot({ media: [media], downloading: new Map(), notifications: new Map() });
    expect(snapshot.media[0]?.variants?.map((variant) => variant.label)).toEqual([
      "MP4 · 1920x1080 · 500KB/s",
      "MP4 · 1280x720 · 250KB/s",
    ]);
    expect(snapshot.media[0]?.preview).toBe("https://cdn.test/v1080.mp4");
  });

  it("keeps live/unknown durations intact", () => {
    const snapshot = buildPanelSnapshot({
      media: [item({ duration: "live" })],
      downloading: new Map(),
      notifications: new Map(),
    });
    expect(snapshot.media[0]?.duration).toBe("live");
  });
});

describe("site-shaped hint extraction (player JSON / inline JSON / resources)", () => {
  it("reads a YouTube-style player response (hlsManifestUrl + adaptive formats)", () => {
    (globalThis as Record<string, unknown>).ytInitialPlayerResponse = {
      streamingData: {
        hlsManifestUrl: "https://manifest.googlevideo.com/api/manifest/hls_variant/abc/index.m3u8",
        adaptiveFormats: [
          { itag: 137, url: "https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137&mime=video%2Fmp4", mimeType: "video/mp4; codecs=avc1.640028", width: 1920, height: 1080, bitrate: 4000000 },
        ],
      },
    };
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const hints = collectMediaHints(document, "https://www.youtube.com/watch?v=abc");
    delete (globalThis as Record<string, unknown>).ytInitialPlayerResponse;
    expect(hints.some((hint) => hint.kind === "hls" && hint.url.includes("hls_variant"))).toBe(true);
    const directHints = hintsFromYouTubePlayerResponse({
      streamingData: {
        hlsManifestUrl: "https://manifest.googlevideo.com/api/manifest/hls_variant/abc/index.m3u8",
        adaptiveFormats: [
          { itag: 137, url: "https://rr1---sn-abc.googlevideo.com/videoplayback?itag=137", mimeType: "video/mp4; codecs=avc1.640028", width: 1920, height: 1080, bitrate: 4000000 },
        ],
      },
    } as never);
    expect(directHints[0]?.hls_url).toContain("hls_variant");
  });

  it("reads Instagram-style video_versions JSON from an inline script", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<script>window.__d={"video_versions":[{"url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/t50.123\\/clip.mp4"}]};</script>`;
    const hints = collectMediaHints(document, "https://www.instagram.com/p/abc/");
    expect(hints.some((hint) => hint.kind === "file" && hint.url.includes("cdninstagram.com"))).toBe(true);
  });

  it("probes an HLS manifest and its first segment in the page context", async () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const manifest = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nhttps://site.test/seg0.ts\n#EXT-X-ENDLIST\n";
    const segment = readFileSync("test/fixtures/h264-720p.ts.bin");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (href.endsWith("media.m3u8")) return new Response(manifest, { status: 200 });
      return new Response(segment, { status: 206 });
    }) as unknown as typeof fetch;
    const hints = await collectHintsForPage(
      "https://site.test/watch",
      document,
      ["https://site.test/media.m3u8"],
      fetchImpl,
    );
    const hls = hints.find((hint) => hint.kind === "hls");
    expect(hls).toMatchObject({ rendered_width: 1280, rendered_height: 720 });
  });

  it("uses the resource timeline to catch manifests fetched by JS", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const hints = collectMediaHints(document, "https://site.test/watch", [
      "https://cdn.test/stream/master.m3u8?token=x",
      "https://cdn.test/seg/1.m4s",
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ kind: "hls", source: "resource-entry" });
  });
});

describe("adapter item mapping", () => {
  it("keeps a direct HLS alternative on the mapped FMT item", () => {
    const item = itemFromHint(
      {
        url: "https://rr1---sn.test.googlevideo.com/videoplayback?itag=137",
        hls_url: "https://manifest.googlevideo.com/api/manifest/hls_variant/abc/index.m3u8",
        source: "player-response",
        kind: "file",
      },
      "https://www.youtube.com/watch?v=1",
    );
    expect(item?.type).toBe("http_playlist");
    expect(item?.hls_url?.href).toBe("https://manifest.googlevideo.com/api/manifest/hls_variant/abc/index.m3u8");
  });

  it("ignores HLS fragments and canonicalises low-latency playlist refreshes", () => {
    expect(classifyHintUrl("https://cdn.test/b-hls-08/73697527_693_x_1792462825_part0.mp4", "https://site.test/watch")).toBeUndefined();
    expect(classifyHintUrl("https://cdn.test/b-hls-08/73697527_init_jk9NeJb8Tz5Z882F.mp4", "https://site.test/watch")).toBeUndefined();
    const playlist = classifyHintUrl(
      "https://cdn.test/master.m3u8?_HLS_msn=5&_HLS_part=2&pkey=abc",
      "https://site.test/watch",
    );
    expect(playlist).toEqual({ url: "https://cdn.test/master.m3u8?pkey=abc", kind: "hls" });
  });

  it("maps an HLS hint to the m3u8 candidate type the sniffer emits", () => {
    const item = itemFromHint(
      { url: "https://cdn.test/master.m3u8", source: "player-response", kind: "hls", referer: "https://www.youtube.com/watch?v=1" },
      "https://www.youtube.com/watch?v=1",
    );
    expect(item).toMatchObject({ type: "m3u8", demuxer: "mp4", is_youtube: true });
    expect(item?.master_url?.href).toBe("https://cdn.test/master.m3u8");
    expect(item?.hls_url).toBeUndefined();
    expect(item?.sent_headers.get("referer")).toBe("https://www.youtube.com/watch?v=1");
  });

  it("maps a DASH hint to the mpd_playlist candidate type", () => {
    const item = itemFromHint(
      { url: "https://cdn.test/manifest.mpd", source: "inline-json", kind: "dash" },
      "https://site.test/watch",
    );
    expect(item).toMatchObject({ type: "mpd_playlist" });
  });
});

describe("current-page preference (no feed noise)", () => {
  it("returns only the open post media when og:video is present (Instagram-like feed HTML)", () => {
    document.head.innerHTML = `<meta property="og:video" content="https://scontent.cdninstagram.com/v/current.mp4" />`;
    document.body.innerHTML = `<script>window.__feed={"items":[
      {"video_versions":[{"url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/other1.mp4"}]},
      {"video_versions":[{"url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/other2.mp4"}]}]};</script>`;
    const hints = collectMediaHints(document, "https://www.instagram.com/p/current/");
    expect(hints).toHaveLength(1);
    expect(hints[0]?.url).toContain("current.mp4");
  });

  it("caps fallback hints when only feed JSON is available", () => {
    document.head.innerHTML = "";
    const entries = Array.from({ length: 40 }, (_, index) =>
      `{"video_versions":[{"url":"https:\\/\\/cdninstagram.com\\/v\\/feed${index}.mp4"}]}`,
    ).join(",");
    document.body.innerHTML = `<script>window.__feed={items:[${entries}]};</script>`;
    const hints = collectMediaHints(document, "https://www.instagram.com/feed/");
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.length).toBeLessThanOrEqual(12);
  });
});

describe("byte-range chunks (live Instagram regression)", () => {
  it("canonicalises chunk URLs and prefers the progressive/muxed asset", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const hints = collectMediaHints(document, "https://www.instagram.com/reel/x/", [
      "https://scontent.cdninstagram.com/o1/v/t2/f2/m367/abc.mp4?_nc_cat=1&bytestart=0&byteend=817",
      "https://scontent.cdninstagram.com/o1/v/t2/f2/m367/abc.mp4?_nc_cat=1&bytestart=818&byteend=909",
      "https://scontent.cdninstagram.com/o1/v/t2/f2/m86/prog.mp4?_nc_cat=1",
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.url).toContain("/m86/prog.mp4");
    expect(hints[0]?.url).not.toContain("bytestart");
  });

  it("falls back to the canonical full asset when only chunks were requested", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const hints = collectMediaHints(document, "https://www.instagram.com/reel/y/", [
      "https://scontent.cdninstagram.com/v/clip.mp4?bytestart=0&byteend=817",
      "https://scontent.cdninstagram.com/v/clip.mp4?bytestart=818&byteend=177135",
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.url).toBe("https://scontent.cdninstagram.com/v/clip.mp4");
  });
});

describe("panel stability + hover preview timing", () => {
  it("keeps the row signature stable when only the signed preview URL rotates", () => {
    const make = (videoUrl: string) =>
      buildPanelSnapshot({
        media: [
          item({
            thumbnail_url: new URL("https://cdn.test/thumb.jpg"),
            playlist: [{ demuxer: "mp4", quality: { size: { height: 720 } }, av: { video: new URL(videoUrl), audio: new URL("https://cdn.test/a.m4a") } }],
          }),
        ],
        downloading: new Map(),
        notifications: new Map(),
      }).media;
    const first = make("https://cdn.test/v.mp4?sig=old");
    const second = make("https://cdn.test/v.mp4?sig=new");
    expect(panelMediaSignature(first)).toBe(panelMediaSignature(second));
  });

  it("changes the row signature when a display field changes", () => {
    const make = (label: string) =>
      buildPanelSnapshot({
        media: [item({ title: label, thumbnail_url: new URL("https://cdn.test/thumb.jpg") })],
        downloading: new Map(),
        notifications: new Map(),
      }).media;
    expect(panelMediaSignature(make("one"))).not.toBe(panelMediaSignature(make("two")));
  });

  it("starts the hover preview later than the first seconds and loops a short window", () => {
    expect(previewStartSeconds(2133)).toBeGreaterThan(600);
    expect(previewStartSeconds(10)).toBe(0);
    expect(previewStartSeconds(0)).toBe(0);
    expect(PREVIEW_WINDOW_SECONDS).toBe(12);
  });
});

describe("Instagram-style quality variants", () => {
  it("turns video_versions metadata into one item with a quality dropdown", () => {
    const pageUrl = "https://www.instagram.com/reel/quality-demo/";
    const versions = [
      { type: 101, width: 720, height: 1280, url: "https://scontent.cdninstagram.com/v/720.mp4" },
      { type: 102, width: 1080, height: 1920, url: "https://scontent.cdninstagram.com/v/1080.mp4" },
      { type: 103, width: 1080, height: 1920, url: "https://scontent.cdninstagram.com/v/1920.mp4" },
    ];
    document.head.innerHTML = "<title>Instagram reel</title>";
    document.body.innerHTML = `<video src="${versions[0]?.url}"></video><script>window.__data={"video_versions":${JSON.stringify(versions)}};</script>`;
    const hints = collectMediaHints(document, pageUrl);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.variants).toHaveLength(3);
    expect(hints[0]?.url).toBe("https://scontent.cdninstagram.com/v/1080.mp4");
    const item = itemFromHint(hints[0]!, pageUrl);
    expect(item?.playlist).toHaveLength(3);
    const snapshot = buildPanelSnapshot({
      media: item === undefined ? [] : [item],
      downloading: new Map(),
      notifications: new Map(),
    });
    expect(snapshot.media[0]?.variants?.length).toBe(3);
    expect(snapshot.media[0]?.variants?.[0]?.label).toContain("1080x1920");
  });

  it("keeps a quality list per video when only feed JSON is available", () => {
    const groups = [1, 2].map((index) => `{"video_versions":[
      {"width":720,"height":1280,"url":"https:\\/\\/cdninstagram.com\\/v${index}-720.mp4"},
      {"width":1080,"height":1920,"url":"https:\\/\\/cdninstagram.com\\/v${index}-1080.mp4"}
    ]}`).join(",");
    document.head.innerHTML = "";
    document.body.innerHTML = `<script>window.__feed={items:[${groups}]};</script>`;
    const hints = collectMediaHints(document, "https://www.instagram.com/feed/");
    expect(hints).toHaveLength(2);
    expect(hints.every((hint) => hint.variants?.length === 2)).toBe(true);
  });

  it("marks a grouped hint as focused when any rendition was played", () => {
    const hint = {
      url: "https://cdn.test/best.mp4",
      kind: "file" as const,
      source: "inline-json" as const,
      variants: [
        { url: "https://cdn.test/best.mp4" },
        { url: "https://cdn.test/played.mp4" },
      ],
    };
    const focused = applyFocusToHints([hint], ["https://cdn.test/played.mp4"]);
    expect(focused.focusActive).toBe(true);
    expect(focused.hints[0]?.focused).toBe(true);
  });
});

describe("generic media-element quality grouping", () => {
  it("turns labelled <source> renditions into one item with a quality list", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<video>
      <source src="https://cdn.test/clip-720.mp4" label="720p" type="video/mp4" />
      <source src="https://cdn.test/clip-1080.mp4" label="1080p" type="video/mp4" />
    </video>`;
    const hints = collectMediaHints(document, "https://video.test/watch/1");
    expect(hints).toHaveLength(1);
    expect(hints[0]?.variants).toHaveLength(2);
    expect(hints[0]?.url).toBe("https://cdn.test/clip-1080.mp4");
    const item = itemFromHint(hints[0]!, "https://video.test/watch/1");
    const snapshot = buildPanelSnapshot({
      media: item === undefined ? [] : [item],
      downloading: new Map(),
      notifications: new Map(),
    });
    expect(snapshot.media[0]?.variants?.map((variant) => variant.label)).toEqual([
      "MP4 \u00b7 1080p",
      "MP4 \u00b7 720p",
    ]);
  });

  it("uses the rendered video size when a blob player hides the source quality", async () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<video></video>`;
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "videoWidth", { value: 1920 });
    Object.defineProperty(video, "videoHeight", { value: 1080 });
    const hints = await collectHintsForPage(
      "https://video.test/watch/1",
      document,
      ["https://cdn.test/direct-file.mp4"],
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]?.variants?.[0]?.height).toBe(1080);
    const item = itemFromHint(hints[0]!, "https://video.test/watch/1");
    const snapshot = buildPanelSnapshot({ media: item === undefined ? [] : [item], downloading: new Map(), notifications: new Map() });
    expect(snapshot.media[0]?.variants?.[0]?.label).toContain("1920x1080");
  });

  it("keeps a single video source label with its actual resolution", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = `<video src="https://cdn.test/single-720.mp4" height="720"></video>`;
    const hints = collectMediaHints(document, "https://page.test/watch");
    expect(hints).toHaveLength(1);
    expect(hints[0]?.variants?.[0]?.height).toBe(720);
    const item = itemFromHint(hints[0]!, "https://page.test/watch");
    const snapshot = buildPanelSnapshot({
      media: item === undefined ? [] : [item],
      downloading: new Map(),
      notifications: new Map(),
    });
    expect(snapshot.media[0]?.variants?.[0]?.label).toBe("MP4 · 720p");
  });

  it("gives every media row a quality choice, even a single rendition", () => {
    const snapshot = buildPanelSnapshot({
      media: [item()],
      downloading: new Map(),
      notifications: new Map(),
    });
    expect(snapshot.media[0]?.variants).toEqual([{ index: 0, label: "MP4" }]);
  });
});

describe("Instagram current-post API adapter", () => {
  it("falls back to a DASH manifest embedded in the page JSON", async () => {
    const pageUrl = "https://www.instagram.com/p/InlineDash1/";
    const mpd = `<MPD type="static" mediaPresentationDuration="PT9S"><Period>
      <AdaptationSet contentType="video" mimeType="video/webm"><Representation id="v" codecs="vp09.00.10.08" width="1280" height="718" bandwidth="448000"><BaseURL>https://scontent.cdninstagram.com/v/inline.webm?oe=1</BaseURL></Representation></AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/mp4"><Representation id="a" codecs="mp4a.40.2" bandwidth="72000"><BaseURL>https://scontent.cdninstagram.com/v/inline.m4a?oe=1</BaseURL></Representation></AdaptationSet>
    </Period></MPD>`;
    document.head.innerHTML = "";
    document.body.innerHTML = `<script>window.__data=${JSON.stringify({ video_dash_manifest: mpd })};</script>`;
    const fetchImpl = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    const hints = await collectHintsForPage(pageUrl, document, [], fetchImpl);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.variants).toHaveLength(1);
    expect(hints[0]?.variants?.[0]?.demuxer).toBe("webm");
    expect(hints[0]?.focused).toBe(true);
  });

  it("parses the post DASH manifest into webm quality variants with audio", async () => {
    const pageUrl = "https://www.instagram.com/p/DashQuality1/";
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const mpd = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT21S"><Period>
      <AdaptationSet contentType="video" mimeType="video/webm">
        <Representation id="v1080" codecs="vp09.00.10.08" width="1920" height="1076" bandwidth="8000000"><BaseURL>https://scontent.cdninstagram.com/v/1080.webm?oe=1&amp;efg=eyJ4cHZfYXNzZXRfaWQiOiJ2YXJpYW50LWFzc2V0In0</BaseURL></Representation>
        <Representation id="v720" codecs="vp09.00.10.08" width="1280" height="718" bandwidth="448000"><BaseURL>https://scontent.cdninstagram.com/v/720.webm?oe=1</BaseURL></Representation>
      </AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        <Representation id="a" codecs="mp4a.40.2" bandwidth="72000"><BaseURL>https://scontent.cdninstagram.com/v/audio.m4a?oe=1</BaseURL></Representation>
      </AdaptationSet>
    </Period></MPD>`;
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        items: [{ video_versions: [{ url: "https://scontent.cdninstagram.com/muxed.mp4?efg=eyJ4cHZfYXNzZXRfaWQiOiJ2ZXJzaW9uLWFzc2V0In0", width: 720, height: 1280 }], video_dash_manifest: mpd }],
      }),
    })) as unknown as typeof fetch;
    const hints = await collectHintsForPage(pageUrl, document, [], fetchImpl);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.variants).toHaveLength(2);
    expect(hints[0]?.identity).toBe("ig:asset:variant-asset");
    expect(hints[0]?.variants?.[0]?.url).toBe("https://scontent.cdninstagram.com/v/1080.webm?oe=1&efg=eyJ4cHZfYXNzZXRfaWQiOiJ2YXJpYW50LWFzc2V0In0");
    expect(hints[0]?.variants?.[0]?.demuxer).toBe("webm");
    expect(hints[0]?.variants?.[0]?.audio_url).toBe("https://scontent.cdninstagram.com/v/audio.m4a?oe=1");
    const item = itemFromHint(hints[0]!, pageUrl);
    expect(item?.playlist?.[0]?.av?.audio).toBeInstanceOf(URL);
  });
  it("uses only the current post renditions and exposes real quality options", async () => {
    const pageUrl = "https://www.instagram.com/p/DensBSLoHNE/";
    document.head.innerHTML = "<title>Foyege24 Instagram photos and videos</title>";
    document.body.innerHTML = `<script>window.__feed={"items":[{"video_versions":[{"url":"https:\/\/cdninstagram.com\/v\/stray.mp4","width":720,"height":1280}]}]};</script>`;
    let requestedUrl = "";
    const fetchImpl = (async (url: string) => {
      requestedUrl = String(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json; charset=utf-8" },
        json: async () => ({
          items: [
            {
              video_versions: [
                { url: "https://scontent.cdninstagram.com/v/cur-720.mp4", width: 720, height: 1280 },
                { url: "https://scontent.cdninstagram.com/v/cur-1080.mp4", width: 1080, height: 1920 },
              ],
              image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/thumb.jpg" }] },
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    expect(instagramShortcode(pageUrl)).toBe("DensBSLoHNE");
    expect(instagramMediaId("DensBSLoHNE")).toMatch(/^[0-9]+$/u);
    const hints = await collectHintsForPage(pageUrl, document, [], fetchImpl);
    expect(requestedUrl).toContain("/api/v1/media/");
    expect(hints).toHaveLength(1);
    expect(hints[0]?.focused).toBe(true);
    expect(hints[0]?.variants?.length).toBe(2);
    expect(hints[0]?.url).toBe("https://scontent.cdninstagram.com/v/cur-1080.mp4");
    expect(hints[0]?.thumbnail).toBe("https://scontent.cdninstagram.com/thumb.jpg");
    const item = itemFromHint(hints[0]!, pageUrl);
    expect(item?.playlist).toHaveLength(2);
  });
});

describe("Instagram signed-URL identity (regression)", () => {
  const efg = Buffer.from(JSON.stringify({ xpv_asset_id: 2623002168141771, bitrate: 1240380 })).toString("base64");
  const pageUrl = "https://www.instagram.com/p/StableRow1/";
  const signed = (path: string, oh: string): string =>
    `https://scontent.cdninstagram.com/o1/v/t2/f2/m86/${path}.mp4?efg=${encodeURIComponent(efg)}&oh=${oh}`;

  it("hashes rotating signed URLs of the same Instagram asset to one row", () => {
    const first = itemFromHint({ url: signed("same", "one"), source: "resource-entry", kind: "file" }, pageUrl);
    const second = itemFromHint({ url: signed("same", "two"), source: "resource-entry", kind: "file" }, pageUrl);
    expect(first?.hash).toBe(second?.hash);
  });

  it("collapses repeated signed URLs into one panel hint and keeps quality URLs", () => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const hints = collectMediaHints(document, pageUrl, [
      signed("same", "one"),
      signed("same", "two"),
      signed("other", "three"),
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.identity).toBe("ig:asset:2623002168141771");
    expect(hints[0]?.variants).toHaveLength(2);
  });
});

describe("page thumbnail fallback for network-detected media", () => {
  it("uses the page poster/og:image when an item has no per-media thumbnail", () => {
    const withPageThumb = { ...meta, thumbnail_url: new URL("https://cdn.test/tweet-poster.jpg") };
    const snapshot = buildPanelSnapshot({
      meta: withPageThumb,
      media: [item({ hash: "media_hash_twitter", type: "m3u8_playlist" })],
      downloading: new Map(),
      notifications: new Map(),
    });
    expect(snapshot.media[0]?.thumbnail).toBe("https://cdn.test/tweet-poster.jpg");
  });

  it("prefers a per-media thumbnail over the page fallback", () => {
    const withPageThumb = { ...meta, thumbnail_url: new URL("https://cdn.test/page.jpg") };
    const snapshot = buildPanelSnapshot({
      meta: withPageThumb,
      media: [item({ thumbnail_url: new URL("https://cdn.test/media.jpg") })],
      downloading: new Map(),
      notifications: new Map(),
    });
    expect(snapshot.media[0]?.thumbnail).toBe("https://cdn.test/media.jpg");
  });
});

describe("Twitter HLS hover preview", () => {
  it("uses the direct video MP4 of the same tweet as the manifest preview source", async () => {
    const tweetPage = "https://x.com/PaulGolding/status/2111588792050262257/video/1";
    const base = "https://video.twimg.com/amplify_video/2112224026076553216";
    const entries = [
      `${base}/pl/71FFpZO5ox3DX7Ff.m3u8?tag=16&variant_version=1`,
      `${base}/pl/avc1/576x1024/lyTwihFG8H5ZFqfH.m3u8`,
      `${base}/pl/mp4a/128000/2SndXnXZfygKUEV5.m3u8`,
      `${base}/vid/avc1/0/0/576x1024/Jtb05T0cejV2TnkD.mp4`,
      `${base}/aud/mp4a/0/0/128000/p1JNS6-JQntYc9KA.mp4`,
    ];
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const hints = await collectHintsForPage(tweetPage, document, entries);
    const master = hints.find((hint) => hint.kind === "hls");
    expect(master?.preview).toBe(`${base}/vid/avc1/0/0/576x1024/Jtb05T0cejV2TnkD.mp4`);
    const item = itemFromHint(master!, tweetPage);
    expect(item?.preview_url?.href).toBe(`${base}/vid/avc1/0/0/576x1024/Jtb05T0cejV2TnkD.mp4`);
    const snapshot = buildPanelSnapshot({ media: item === undefined ? [] : [item], downloading: new Map(), notifications: new Map() });
    expect(snapshot.media[0]?.preview).toBe(`${base}/vid/avc1/0/0/576x1024/Jtb05T0cejV2TnkD.mp4`);
  });
});


describe("generic HLS preview sibling", () => {
  it("attaches the direct MP4 when the page snapshot has exactly one HLS and one video file", async () => {
    const pageUrl = "https://video.test/watch/1";
    const hls = "https://cdn.test/pl/master.m3u8";
    const direct = "https://cdn.test/vid/avc1/1280x720/clip.mp4";
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const hints = await collectHintsForPage(pageUrl, document, [hls, direct]);
    expect(hints).toHaveLength(2);
    const manifest = hints.find((hint) => hint.kind === "hls");
    expect(manifest?.preview).toBe(direct);
  });
});

describe("Bilibili DASH adapter", () => {
  it("falls back to the playurl API when __playinfo__ is not exposed yet", async () => {
    const pageUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
    const globalScope = globalThis as { __playinfo__?: unknown; __INITIAL_STATE__?: unknown };
    delete globalScope.__playinfo__;
    globalScope.__INITIAL_STATE__ = { videoData: { cid: 12345 } };
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    const fetchImpl = (async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        data: {
          dash: {
            video: [{ baseUrl: "https://upos.example/v/1080.m4s", width: 1920, height: 1080, bandwidth: 2_000_000, mimeType: "video/mp4" }],
            audio: [{ baseUrl: "https://upos.example/a/audio.m4s", bandwidth: 128_000, mimeType: "audio/mp4" }],
          },
        },
      }),
    })) as unknown as typeof fetch;
    try {
      const hints = await collectHintsForPage(pageUrl, document, [], fetchImpl);
      expect(hints).toHaveLength(1);
      expect(hints[0]?.variants?.[0]?.height).toBe(1080);
      expect(hints[0]?.variants?.[0]?.audio_url).toBe("https://upos.example/a/audio.m4s");
    } finally {
      delete globalScope.__INITIAL_STATE__;
    }
  });

  it("extracts video qualities and the best audio from __playinfo__", async () => {
    const pageUrl = "https://www.bilibili.com/video/BV1xx411c7mD";
    const globalScope = globalThis as { __playinfo__?: unknown };
    globalScope.__playinfo__ = {
      data: {
        dash: {
          video: [
            { id: 80, baseUrl: "https://upos.example/v/1080.m4s?token=1", width: 1920, height: 1080, bandwidth: 2_000_000, mimeType: "video/mp4" },
            { id: 64, baseUrl: "https://upos.example/v/720.m4s?token=1", width: 1280, height: 720, bandwidth: 1_000_000, mimeType: "video/mp4" },
          ],
          audio: [{ baseUrl: "https://upos.example/a/audio.m4s?token=1", bandwidth: 128_000, mimeType: "audio/mp4" }],
        },
      },
    };
    document.head.innerHTML = `<meta property="og:image" content="https://i.example/bili.jpg">`;
    document.body.innerHTML = "";
    document.title = "Bilibili fixture";
    try {
      const hints = await collectHintsForPage(pageUrl, document, []);
      expect(hints).toHaveLength(1);
      expect(hints[0]?.identity).toBe("bili:BV1xx411c7mD");
      expect(hints[0]?.variants).toHaveLength(2);
      expect(hints[0]?.variants?.[0]?.width).toBe(1920);
      expect(hints[0]?.variants?.[0]?.audio_url).toBe("https://upos.example/a/audio.m4s?token=1");
      const item = itemFromHint(hints[0]!, pageUrl);
      expect(item?.playlist?.[0]?.av?.audio).toBeInstanceOf(URL);
      const snapshot = buildPanelSnapshot({ media: item === undefined ? [] : [item], downloading: new Map(), notifications: new Map() });
      expect(snapshot.media[0]?.variants?.[0]?.label).toContain("1920x1080");
    } finally {
      delete globalScope.__playinfo__;
    }
  });
});
