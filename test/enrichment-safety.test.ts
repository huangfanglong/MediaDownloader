/**
 * Automatic manifest enrichment runs without a user gesture, so every URL it follows must stay
 * inside the trust boundary of the manifest that was already approved by the top-level gate:
 * nested variant URLs are gated and their captured credentials are origin-scoped, and a redirect
 * must not move the request somewhere the gate never approved.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MediaDownloaderService } from "../src/extension/service-worker.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { WorkerClient } from "../src/extension/worker-client.js";
import { Channel } from "../src/protocol/channels.js";
import type { Envelope } from "../src/extension/gateways.js";
import type { FetchInitLike, FetchLike, FetchResponseLike } from "../src/transfer/fetch.js";
import { createFakeOpfs } from "./helpers/transfer-fakes.js";
import {
  FakeChannelHub,
  createFakeGateway,
  flush,
  fmp4MediaPlaylist,
  sniffDetails,
} from "./helpers/service-harness.js";

const encoder = new TextEncoder();

afterEach(() => {
  // Each test builds its own harness; nothing global is stubbed here.
});

interface RecordedCall {
  url: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
}

function textBody(text: string, extra: Partial<FetchResponseLike> = {}): FetchResponseLike {
  let sent = false;
  return {
    status: 200,
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: encoder.encode(text) };
        },
        cancel: async () => undefined,
      }),
    },
    ...extra,
  };
}

function harness(
  serve: (url: string) => FetchResponseLike | undefined,
): { gateway: ReturnType<typeof createFakeGateway>; service: MediaDownloaderService; calls: RecordedCall[] } {
  const gateway = createFakeGateway("https://site.test/watch", new Map());
  const hub = new FakeChannelHub();
  const opfs = createFakeOpfs();
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url: string, init?: FetchInitLike) => {
    calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    return serve(url) ?? { status: 404, ok: false, body: null };
  };
  const worker = new DownloadWorker({
    channel: hub.endpoint("worker"),
    fetchImpl: async () => ({ status: 404, ok: false, body: null }),
    openRoot: async () => opfs.root,
  });
  worker.start();
  const service = new MediaDownloaderService({
    gateway,
    fetchImpl,
    opfsRoot: async () => opfs.root,
    downloadIdFactory: () => "download_enrichment",
    now: () => 1_700_000_000_000,
    workerClient: new WorkerClient({
      channel: hub.endpoint("service"),
      offscreen: gateway.offscreen,
      offscreenUrl: "chrome-extension://fake/factory/factory.html",
      readyTimeoutMs: 200,
    }),
  });
  return { gateway, service, calls };
}

const CAPTURED_HEADERS = [
  { name: "authorization", value: "Bearer page-secret" },
  { name: "x-api-key", value: "sk-page-key" },
  { name: "referer", value: "https://site.test/watch" },
];

async function sniffManifest(
  gateway: ReturnType<typeof createFakeGateway>,
  url: string,
): Promise<void> {
  gateway.triggerSendHeaders({
    requestId: `req-${url}`,
    url,
    tabId: 7,
    frameId: 0,
    type: "xmlhttprequest",
    timeStamp: 1_700_000_000_000,
    requestHeaders: CAPTURED_HEADERS,
  });
  await gateway.triggerResponseStarted(sniffDetails(url, "application/vnd.apple.mpegurl"));
  for (let tick = 0; tick < 5; tick += 1) await flush();
}

describe("nested HLS enrichment safety", () => {
  it("never probes a variant the manifest points at a private-network host", async () => {
    const masterUrl = "https://cdn.test/evil/master.m3u8";
    const master = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720",
      "http://127.0.0.1:9090/internal.m3u8",
    ].join("\n");
    const { gateway, service, calls } = harness((url) =>
      url === masterUrl ? textBody(master) : undefined,
    );
    await service.start();
    await sniffManifest(gateway, masterUrl);

    expect(calls.some((call) => call.url.includes("127.0.0.1"))).toBe(false);
    // The manifest itself is still displayed: only the automatic probe is refused.
    const media = [...service.getEngine().mediaForTab(7).values()];
    expect(media[0]?.type).toBe("m3u8_playlist");
    service.stop();
  });

  it("does not send captured credentials to a cross-origin variant probe", async () => {
    const masterUrl = "https://cdn.test/master.m3u8";
    const variantUrl = "https://media.example.net/720/index.m3u8";
    const master = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720",
      variantUrl,
    ].join("\n");
    const { gateway, service, calls } = harness((url) => {
      if (url === masterUrl) return textBody(master);
      if (url === variantUrl) return textBody(fmp4MediaPlaylist);
      return undefined;
    });
    await service.start();
    await sniffManifest(gateway, masterUrl);

    const probe = calls.find((call) => call.url === variantUrl);
    expect(probe).toBeDefined();
    expect(probe?.headers.get("authorization")).toBeNull();
    expect(probe?.headers.get("x-api-key")).toBeNull();
    service.stop();
  });

  it("keeps captured credentials on a same-origin variant probe and disables redirects", async () => {
    const masterUrl = "https://cdn.test/master.m3u8";
    const variantUrl = "https://cdn.test/720/index.m3u8";
    const { gateway, service, calls } = harness((url) => {
      if (url === masterUrl) return textBody(masterPlaylistFor(variantUrl));
      if (url === variantUrl) return textBody(fmp4MediaPlaylist);
      return undefined;
    });
    await service.start();
    await sniffManifest(gateway, masterUrl);

    const probe = calls.find((call) => call.url === variantUrl);
    expect(probe?.headers.get("authorization")).toBe("Bearer page-secret");
    // Every automatic enrichment fetch refuses to follow a redirect it cannot revalidate.
    expect(calls.every((call) => call.redirect === "error")).toBe(true);
    service.stop();
  });

  it("does not send captured credentials to a cross-origin quality probe of a media playlist", async () => {
    const mediaUrl = "https://cdn.test/media.m3u8";
    const segmentUrl = "https://attacker.example.net/seg0.ts";
    const media = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:2",
      "#EXTINF:2.0,",
      segmentUrl,
      "#EXT-X-ENDLIST",
    ].join("\n");
    const { gateway, service, calls } = harness((url) => {
      if (url === mediaUrl) return textBody(media);
      if (url === segmentUrl) return textBody("TS");
      return undefined;
    });
    await service.start();
    await sniffManifest(gateway, mediaUrl);

    const probe = calls.find((call) => call.url === segmentUrl);
    expect(probe).toBeDefined();
    expect(probe?.headers.get("authorization")).toBeNull();
    service.stop();
  });

  it("refuses enrichment when the manifest fetch ended at a private-network URL", async () => {
    const masterUrl = "https://cdn.test/master.m3u8";
    const master = masterPlaylistFor("https://cdn.test/720/index.m3u8");
    const { gateway, service } = harness((url) =>
      url === masterUrl
        ? textBody(master, { url: "http://127.0.0.1:9090/internal/master.m3u8" })
        : undefined,
    );
    await service.start();
    await sniffManifest(gateway, masterUrl);

    const media = [...service.getEngine().mediaForTab(7).values()];
    expect(media[0]?.playlist).toBeUndefined();
    service.stop();
  });
});

function masterPlaylistFor(variantUrl: string): string {
  return [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720",
    variantUrl,
  ].join("\n");
}
