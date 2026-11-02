/**
 * The worker fetches two sorts of URLs because a playlist pointed at them: the playlist a master
 * selects (a variant, or the audio rendition of a two-source plan) and the media segments it lists.
 * Both obey one policy — http(s) only, no userinfo, and a private-network host only when it is the
 * origin whose captured credentials are being replayed. Without that gate a hostile playlist could
 * steer a download at loopback, the LAN, a local file or an embedded `data:` document.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import type { DownloadPlan, TransferOutcome } from "../src/core/types.js";
import type { Result } from "../src/core/option.js";
import type { FetchLike } from "../src/transfer/fetch.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";

const MASTER = "https://cdn.example.com/stream/master.m3u8";
const MEDIA = "https://cdn.example.com/stream/media.m3u8";
const LAN_MASTER = "http://192.168.1.10:8096/videos/master.m3u8";
const SEGMENT_BYTES = new Uint8Array(2048).fill(7);

const noopChannel = (): BroadcastChannelLike => ({
  postMessage: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  close: () => undefined,
});

const playlist = (...body: string[]): string =>
  ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:2", ...body, "#EXT-X-ENDLIST"].join("\n");

const masterPlaylist = (variantUri: string): string =>
  playlist("#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720", variantUri);

const mediaPlaylist = (...segmentUris: string[]): string =>
  playlist(...segmentUris.flatMap((uri) => ["#EXTINF:2.0,", uri]));

const captured = (): Headers => new Headers({ Authorization: "Bearer page-secret" });

function planFor(overrides: Partial<DownloadPlan> = {}): DownloadPlan {
  return {
    download_id: "download_playlist_safety",
    headers: captured(),
    headers_origin: new URL(MASTER).origin,
    good_basename: "playlist-safety",
    subdir: "",
    save_as: false,
    will_use_jsfetch: false,
    strategy: "m3u8_audio_video_one_source",
    url: new URL(MEDIA),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    is_youtube: false,
    throttle: false,
    cache: "default",
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  headers: Headers;
}

async function runWorker(
  payloads: Map<string, string | Uint8Array>,
  plan: DownloadPlan,
): Promise<{ result: Result<TransferOutcome, string>; calls: RecordedCall[] }> {
  const calls: RecordedCall[] = [];
  const serving = createFetch(payloads);
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: new Headers(init?.headers) });
    return serving(url, init);
  };
  const worker = new DownloadWorker({
    channel: noopChannel(),
    fetchImpl,
    openRoot: async () => createFakeOpfs().root,
  });
  return { result: await worker.runPlan(plan), calls };
}

const refused = (result: Result<TransferOutcome, string>): string => {
  expect(result.tag).toBe("Err");
  return result.tag === "Err" ? result.error : "";
};

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValue("blob:playlist-safety");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("segment URLs resolved from a media playlist", () => {
  it("refuses a segment whose URL is not http(s) instead of attempting the fetch", async () => {
    const { result, calls } = await runWorker(
      new Map<string, string | Uint8Array>([
        [MEDIA, mediaPlaylist("seg-0.ts", "file:///etc/passwd")],
        ["https://cdn.example.com/stream/seg-0.ts", SEGMENT_BYTES],
      ]),
      planFor(),
    );

    expect(refused(result)).toMatch(/scheme file:.*refused by URL-safety gate/i);
    expect(calls.some((call) => call.url.startsWith("file:"))).toBe(false);
  });

  it("refuses an init section whose URL is not http(s)", async () => {
    const { result, calls } = await runWorker(
      new Map<string, string | Uint8Array>([
        [MEDIA, playlist('#EXT-X-MAP:URI="data:text/plain;base64,AAAA"', "#EXTINF:2.0,", "seg-0.ts")],
        ["https://cdn.example.com/stream/seg-0.ts", SEGMENT_BYTES],
      ]),
      planFor(),
    );

    expect(refused(result)).toMatch(/scheme data:.*refused by URL-safety gate/i);
    expect(calls.some((call) => call.url.startsWith("data:"))).toBe(false);
  });
});

describe("playlist URLs resolved from a master playlist", () => {
  it("refuses a private-network variant before making the request", async () => {
    const { result, calls } = await runWorker(
      new Map<string, string | Uint8Array>([[MASTER, masterPlaylist("http://127.0.0.1:9090/internal.m3u8")]]),
      planFor({ url: new URL(MASTER) }),
    );

    expect(refused(result)).toMatch(/127\.0\.0\.1.*refused by URL-safety gate/i);
    expect(calls.map((call) => call.url)).toEqual([MASTER]);
  });

  it("refuses a variant whose URL is not http(s)", async () => {
    const { result, calls } = await runWorker(
      new Map<string, string | Uint8Array>([[MASTER, masterPlaylist("file:///etc/passwd")]]),
      planFor({ url: new URL(MASTER) }),
    );

    expect(refused(result)).toMatch(/scheme file:.*refused by URL-safety gate/i);
    expect(calls.map((call) => call.url)).toEqual([MASTER]);
  });

  it("refuses a plan URL that a public manifest resolved to loopback", async () => {
    const { result, calls } = await runWorker(
      new Map<string, string | Uint8Array>(),
      planFor({ url: new URL("http://127.0.0.1:9090/variant.m3u8") }),
    );

    expect(refused(result)).toMatch(/127\.0\.0\.1.*refused by URL-safety gate/i);
    expect(calls).toHaveLength(0);
  });

  it("keeps a same-origin LAN master and its variant working", async () => {
    const { result, calls } = await runWorker(
      new Map<string, string | Uint8Array>([
        [LAN_MASTER, masterPlaylist("/videos/media.m3u8")],
        ["http://192.168.1.10:8096/videos/media.m3u8", mediaPlaylist("seg-0.ts")],
        ["http://192.168.1.10:8096/videos/seg-0.ts", SEGMENT_BYTES],
      ]),
      planFor({
        headers: new Headers(),
        headers_origin: new URL(LAN_MASTER).origin,
        url: new URL(LAN_MASTER),
      }),
    );

    expect(result.tag).toBe("Ok");
    expect(calls.map((call) => call.url)).toEqual([
      LAN_MASTER,
      "http://192.168.1.10:8096/videos/media.m3u8",
      "http://192.168.1.10:8096/videos/seg-0.ts",
    ]);
  });

  it("keeps captured credentials on same-origin playlist requests", async () => {
    const { result, calls } = await runWorker(
      new Map<string, string | Uint8Array>([
        [MASTER, masterPlaylist("/stream/media.m3u8")],
        [MEDIA, mediaPlaylist("seg-0.ts")],
        ["https://cdn.example.com/stream/seg-0.ts", SEGMENT_BYTES],
      ]),
      planFor({ url: new URL(MASTER) }),
    );

    expect(result.tag).toBe("Ok");
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer page-secret");
    }
  });

  it("drops captured credentials from a cross-origin public variant and its segments", async () => {
    const media = "https://media.example.net/stream/media.m3u8";
    const segment = "https://media.example.net/stream/seg-0.ts";
    const { result, calls } = await runWorker(
      new Map<string, string | Uint8Array>([
        [MASTER, masterPlaylist(media)],
        [media, mediaPlaylist("seg-0.ts")],
        [segment, SEGMENT_BYTES],
      ]),
      planFor({ url: new URL(MASTER) }),
    );

    expect(result.tag).toBe("Ok");
    const masterCall = calls.find((call) => call.url === MASTER);
    expect(masterCall?.headers.get("authorization")).toBe("Bearer page-secret");
    for (const call of calls.filter((candidate) => candidate.url.startsWith("https://media.example.net"))) {
      expect(call.headers.get("authorization")).toBeNull();
    }
  });
});

describe("the audio rendition of a two-source HLS plan", () => {
  it("refuses an audio playlist that points at a private host", async () => {
    const audioPlanUrl = "http://192.168.1.9/audio.m3u8";
    const { result, calls } = await runWorker(
      new Map<string, string | Uint8Array>([
        [MEDIA, mediaPlaylist("seg-0.ts")],
        ["https://cdn.example.com/stream/seg-0.ts", SEGMENT_BYTES],
      ]),
      planFor({
        strategy: "m3u8_audio_video_two_sources",
        url: new URL(MEDIA),
        url_audio: new URL(audioPlanUrl),
      }),
    );

    expect(refused(result)).toMatch(/192\.168\.1\.9.*refused by URL-safety gate/i);
    expect(calls.some((call) => call.url === audioPlanUrl)).toBe(false);
  });
});
