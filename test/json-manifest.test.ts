/**
 * JSON media manifests (the `master.json` DASH-in-JSON class) and fragment-stream noise.
 *
 * Players that describe their streams in a JSON document (Vimeo-style `master.json`) expose no
 * `.m3u8`/`.mpd` URL for the network layer to classify: the manifest arrives as an XHR with a
 * `application/json` content type. The classifier must recognize such responses by URL + content
 * type, resolve them by parsing the body, and drop candidates that prove not to be manifests —
 * while the burst gate stops MSE fragment responses from registering as bogus standalone files.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ManifestEnrichment,
} from "../src/extension/manifest-enrichment.js";
import { MediaDownloaderService } from "../src/extension/service-worker.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { WorkerClient } from "../src/extension/worker-client.js";
import { parseJsonMediaManifest, selectBestVideoTrack } from "../src/manifests/json-manifest.js";
import type { MediaItem, TabMeta } from "../src/core/types.js";
import { makeResponseStartedEvent, headerList, fixedNow } from "./fixtures/detection.js";
import { makeEngine } from "./helpers/discovery-harness.js";
import { createFetch, createFakeOpfs } from "./helpers/transfer-fakes.js";
import {
  createFakeGateway,
  FakeChannelHub,
  sniffDetails,
  doDownloadEnvelope,
  flush,
} from "./helpers/service-harness.js";

const MASTER_JSON = {
  clip_metadata: { title: "My Video" },
  sequences: [
    {
      audio: [
        {
          id: "aac",
          mime_type: "audio/mp4",
          bitrate: 128_000,
          init_segment_url: "https://cdn.example.com/json/audio/init.mp4",
          segments: [
            { approx_duration: 6.0, url: "https://cdn.example.com/json/audio/seg-1.mp4" },
            { approx_duration: 6.0, url: "https://cdn.example.com/json/audio/seg-2.mp4" },
          ],
        },
      ],
      video: [
        {
          id: "avc",
          mime_type: "video/mp4",
          bitrate: 2_000_000,
          width: 1280,
          height: 720,
          init_segment_url: "https://cdn.example.com/json/video/init.mp4",
          segments: [
            { approx_duration: 4.0, url: "https://cdn.example.com/json/video/seg-1.mp4" },
            { approx_duration: 4.0, url: "https://cdn.example.com/json/video/seg-2.mp4" },
          ],
        },
        {
          id: "hevc",
          mime_type: "video/mp4",
          bitrate: 5_000_000,
          width: 1920,
          height: 1080,
          init_segment_url: "https://cdn.example.com/json/video/hd-init.mp4",
          segments: [
            { approx_duration: 4.0, url: "https://cdn.example.com/json/video/hd-seg-1.mp4" },
            { approx_duration: 4.0, url: "https://cdn.example.com/json/video/hd-seg-2.mp4" },
          ],
        },
      ],
    },
  ],
};

const DRM_JSON = {
  ...MASTER_JSON,
  drm: [{ system: "widevine" }],
};

const CONFIG_JSON = { config: { feature_flags: ["a", "b"], endpoint: "https://api.example.com/v1" } };

const JSON_MANIFEST_URL = "https://cdn.example.com/master.json?base64=1";
const JSON_MANIFEST_BASE_URL = new URL(JSON_MANIFEST_URL);

function mutableClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("parseJsonMediaManifest", () => {
  it("parses the best video track into an HLS-shaped media playlist", () => {
    const parsed = parseJsonMediaManifest(JSON.stringify(MASTER_JSON), JSON_MANIFEST_BASE_URL);
    expect(parsed.tag).toBe("Ok");
    if (parsed.tag !== "Ok") return;
    const { playlist, track } = parsed.value;
    expect(track.bitrate).toBe(5_000_000);
    expect(track.width).toBe(1920);
    expect(track.height).toBe(1080);
    expect(playlist.segments).toHaveLength(2);
    expect(playlist.segments[0]?.uri.href).toBe("https://cdn.example.com/json/video/hd-seg-1.mp4");
    expect(playlist.segments[0]?.duration).toBe(4.0);
    expect(playlist.segments[0]?.map?.uri.href).toBe("https://cdn.example.com/json/video/hd-init.mp4");
    expect(playlist.segments[1]?.map?.uri.href).toBe("https://cdn.example.com/json/video/hd-init.mp4");
    expect(playlist.duration).toBe(8);
    expect(playlist.hasDrm).toBe(false);
  });

  it("prefers video tracks over audio tracks", () => {
    const audioOnly = {
      sequences: [{ audio: MASTER_JSON.sequences[0]?.audio }],
    };
    const parsed = parseJsonMediaManifest(JSON.stringify(audioOnly), JSON_MANIFEST_BASE_URL);
    expect(parsed.tag).toBe("Ok");
    if (parsed.tag !== "Ok") return;
    expect(parsed.value.playlist.segments[0]?.uri.href).toBe("https://cdn.example.com/json/audio/seg-1.mp4");
    expect(parsed.value.track.bitrate).toBe(128_000);
  });

  it("marks manifests that carry DRM markers", () => {
    const parsed = parseJsonMediaManifest(JSON.stringify(DRM_JSON), JSON_MANIFEST_BASE_URL);
    expect(parsed.tag).toBe("Ok");
    if (parsed.tag !== "Ok") return;
    expect(parsed.value.playlist.hasDrm).toBe(true);
  });

  it("rejects JSON that does not describe a media manifest", () => {
    const parsed = parseJsonMediaManifest(JSON.stringify(CONFIG_JSON), JSON_MANIFEST_BASE_URL);
    expect(parsed.tag).toBe("Err");
    if (parsed.tag !== "Err") return;
    expect(parsed.error.kind).toBe("not_a_manifest");
  });

  it("rejects malformed JSON", () => {
    const parsed = parseJsonMediaManifest("{not json", JSON_MANIFEST_BASE_URL);
    expect(parsed.tag).toBe("Err");
    if (parsed.tag !== "Err") return;
    expect(parsed.error.kind).toBe("invalid_json");
  });

  it("selectBestVideoTrack prefers the highest-bitrate video track and falls back to any track", () => {
    const video720 = { segments: [], bitrate: 2_000_000, width: 1280, height: 720 };
    const video1080 = { segments: [], bitrate: 5_000_000, width: 1920, height: 1080 };
    const audio = { segments: [], mimeType: "audio/mp4", bitrate: 128_000 };
    expect(selectBestVideoTrack([video720, video1080, audio])?.bitrate).toBe(5_000_000);
    expect(selectBestVideoTrack([audio])?.bitrate).toBe(128_000);
    expect(selectBestVideoTrack([])).toBeUndefined();
  });
});

describe("engine: JSON manifest candidates", () => {
  it("creates a manifest candidate for a .json XHR with a json content type", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(makeResponseStartedEvent({
      type: "xmlhttprequest",
      url: JSON_MANIFEST_URL,
      responseHeaders: headerList({ "content-type": "application/json" }),
    }));
    expect(item?.type).toBe("m3u8");
    expect(item?.url?.href).toBe(JSON_MANIFEST_URL);
    expect(item?.demuxer).toBe("mp4");
  });

  it("does not create candidates without a json content type", () => {
    const engine = makeEngine();
    expect(engine.onResponseStarted(makeResponseStartedEvent({
      type: "xmlhttprequest",
      url: JSON_MANIFEST_URL,
      responseHeaders: headerList({ "content-type": "application/octet-stream" }),
    }))).toBeNull();
  });

  it("does not create candidates for JSON responses outside .json URLs", () => {
    const engine = makeEngine();
    expect(engine.onResponseStarted(makeResponseStartedEvent({
      type: "xmlhttprequest",
      url: "https://cdn.example.com/api/config",
      responseHeaders: headerList({ "content-type": "application/json" }),
    }))).toBeNull();
  });

  it("does not create manifest candidates for non-XHR resource types", () => {
    const engine = makeEngine();
    const item = engine.onResponseStarted(makeResponseStartedEvent({
      type: "media",
      url: JSON_MANIFEST_URL,
      responseHeaders: headerList({ "content-type": "application/json" }),
    }));
    expect(item?.type).not.toBe("m3u8");
  });

  it("skips URLs noted as not-a-manifest", () => {
    const engine = makeEngine();
    engine.noteNotAManifest(new URL(JSON_MANIFEST_URL));
    expect(engine.onResponseStarted(makeResponseStartedEvent({
      type: "xmlhttprequest",
      url: JSON_MANIFEST_URL,
      responseHeaders: headerList({ "content-type": "application/json" }),
    }))).toBeNull();
  });
});

describe("enrichment: JSON manifests", () => {
  function candidateFor(engine: ReturnType<typeof makeEngine>): NonNullable<ReturnType<typeof engine.onResponseStarted>> {
    const item = engine.onResponseStarted(makeResponseStartedEvent({
      type: "xmlhttprequest",
      url: JSON_MANIFEST_URL,
      responseHeaders: headerList({ "content-type": "application/json" }),
    }));
    if (item === null) throw new Error("candidate not created");
    return item;
  }

  it("attaches the parsed rendition with quality, duration and container", async () => {
    const engine = makeEngine();
    const item = candidateFor(engine);
    const enrichment = new ManifestEnrichment(
      createFetch(new Map([[JSON_MANIFEST_URL, JSON.stringify(MASTER_JSON)]])),
      engine,
      fixedNow(),
    );
    await enrichment.enrichHls(item, 1);
    const enriched = [...engine.mediaForTab(1).values()][0];
    expect(enriched?.playlist).toHaveLength(1);
    expect(enriched?.playlist?.[0]?.quality).toMatchObject({
      size: { width: 1920, height: 1080 },
      bitrate: 5_000_000,
    });
    expect(enriched?.duration).toBe(8);
    expect(enriched?.extension).toBe("mp4");
  });

  it("marks DRM-carrying manifests so the plan layer refuses them", async () => {
    const engine = makeEngine();
    const item = candidateFor(engine);
    const enrichment = new ManifestEnrichment(
      createFetch(new Map([[JSON_MANIFEST_URL, JSON.stringify(DRM_JSON)]])),
      engine,
      fixedNow(),
    );
    await enrichment.enrichHls(item, 1);
    const enriched = [...engine.mediaForTab(1).values()][0];
    expect(enriched?.has_drm).toBe(true);
  });

  it("removes a speculative candidate whose JSON is not a media manifest", async () => {
    const engine = makeEngine();
    const item = candidateFor(engine);
    expect(engine.mediaForTab(1).size).toBe(1);
    const enrichment = new ManifestEnrichment(
      createFetch(new Map([[JSON_MANIFEST_URL, JSON.stringify(CONFIG_JSON)]])),
      engine,
      fixedNow(),
    );
    await enrichment.enrichHls(item, 1);
    expect(engine.mediaForTab(1).size).toBe(0);
    expect(engine.onResponseStarted(makeResponseStartedEvent({
      type: "xmlhttprequest",
      url: JSON_MANIFEST_URL,
      responseHeaders: headerList({ "content-type": "application/json" }),
    }))).toBeNull();
  });

  it("keeps the candidate when the manifest fetch fails", async () => {
    const engine = makeEngine();
    const item = candidateFor(engine);
    const enrichment = new ManifestEnrichment(createFetch(new Map()), engine, fixedNow());
    await enrichment.enrichHls(item, 1);
    expect(engine.mediaForTab(1).size).toBe(1);
  });
});

describe("engine: fragment-stream burst suppression", () => {
  function directXhr(engine: ReturnType<typeof makeEngine>, url: string): ReturnType<typeof engine.onResponseStarted> {
    return engine.onResponseStarted(makeResponseStartedEvent({
      type: "xmlhttprequest",
      url,
      responseHeaders: headerList({ "content-type": "video/mp4", "content-length": "2000000" }),
    }));
  }

  it("removes the burst once an initiator streams several rapid fragment-like XHRs", () => {
    const engine = makeEngine();
    expect(directXhr(engine, "https://cdn.example.com/seg-1.mp4")).not.toBeNull();
    expect(directXhr(engine, "https://cdn.example.com/seg-2.mp4")).not.toBeNull();
    expect(directXhr(engine, "https://cdn.example.com/seg-3.mp4")).toBeNull();
    expect(engine.mediaForTab(1).size).toBe(0);
    expect(directXhr(engine, "https://cdn.example.com/seg-4.mp4")).toBeNull();
  });

  it("keeps two fragment-like XHRs below the burst threshold", () => {
    const engine = makeEngine();
    expect(directXhr(engine, "https://cdn.example.com/a.mp4")).not.toBeNull();
    expect(directXhr(engine, "https://cdn.example.com/b.mp4")).not.toBeNull();
    expect(engine.mediaForTab(1).size).toBe(2);
  });

  it("does not suppress whole-file media-element loads", () => {
    const engine = makeEngine();
    for (const url of ["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.mp4", "https://cdn.example.com/c.mp4"]) {
      expect(engine.onResponseStarted(makeResponseStartedEvent({
        url,
        responseHeaders: headerList({ "content-type": "video/mp4", "content-length": "2000000" }),
      }))).not.toBeNull();
    }
    expect(engine.mediaForTab(1).size).toBe(3);
  });

  it("recovers after the burst window expires", () => {
    const clock = mutableClock(1_000_000);
    const engine = makeEngine(undefined, clock.now);
    expect(directXhr(engine, "https://cdn.example.com/seg-1.mp4")).not.toBeNull();
    expect(directXhr(engine, "https://cdn.example.com/seg-2.mp4")).not.toBeNull();
    expect(directXhr(engine, "https://cdn.example.com/seg-3.mp4")).toBeNull();
    clock.advance(10_001);
    expect(directXhr(engine, "https://cdn.example.com/movie.mp4")).not.toBeNull();
  });
});

describe("service end to end", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("discovers, enriches and downloads a JSON-manifest stream", async () => {
    const entries = new Map<string, string | Uint8Array>(Object.entries({
      "https://cdn.test/master.json": JSON.stringify(MASTER_JSON),
      "https://cdn.example.com/json/video/hd-init.mp4": "INIT",
      "https://cdn.example.com/json/video/hd-seg-1.mp4": `seg1:${"x".repeat(2000)}`,
      "https://cdn.example.com/json/video/hd-seg-2.mp4": `seg2:${"x".repeat(2000)}`,
    }));
    const gateway = createFakeGateway("https://site.test/watch", entries);
    const hub = new FakeChannelHub();
    const opfs = createFakeOpfs();
    const worker = new DownloadWorker({
      channel: hub.endpoint("worker"),
      fetchImpl: createFetch(entries),
      openRoot: async () => opfs.root,
    });
    worker.start();
    const service = new MediaDownloaderService({
      gateway,
      fetchImpl: createFetch(entries),
      opfsRoot: async () => opfs.root,
      downloadIdFactory: () => "download_json",
      now: () => 1_700_000_000_000,
      workerClient: new WorkerClient({
        channel: hub.endpoint("service"),
        offscreen: gateway.offscreen,
        offscreenUrl: "chrome-extension://fake/factory/factory.html",
        readyTimeoutMs: 200,
      }),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-json");
    await service.start();
    gateway.triggerSendHeaders({
      requestId: "req-json",
      url: "https://cdn.test/master.json",
      tabId: 7,
      frameId: 0,
      type: "xmlhttprequest",
      timeStamp: 1_700_000_000_000,
      requestHeaders: [],
    });
    await gateway.triggerResponseStarted(sniffDetails("https://cdn.test/master.json", "application/json"));
    let item: MediaItem | undefined;
    for (let index = 0; index < 20; index++) {
      item = [...(service.getSession().discovered.get(7)?.media.values() ?? [])][0];
      if (item?.playlist !== undefined) break;
      await flush();
    }
    expect(item?.type).toBe("m3u8");
    expect(item?.extension).toBe("mp4");
    expect(item?.duration).toBe(8);
    const meta = service.getSession().discovered.get(7)?.meta as TabMeta;
    await gateway.deliverToService(doDownloadEnvelope(item as MediaItem, meta));
    expect(gateway.downloadRequestsLog[0]?.filename).toBe("Test Page.mp4");
    service.stop();
  });
});
