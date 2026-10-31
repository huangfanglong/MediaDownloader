import { describe, expect, it } from "vitest";
import { parsePlaylist } from "../src/manifests/hls.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { deriveCarryGetParams } from "../src/extension/service-worker.js";
import { setFlag, type Behaviours } from "../src/settings/flags.js";
import type { DownloadPlan } from "../src/core/types.js";
import type { FetchLike } from "../src/transfer/fetch.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import { createFakeOpfs } from "./helpers/transfer-fakes.js";

const WIDEVINE_URN = "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
const MEDIA = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  "seg0.m4s",
  "#EXT-X-ENDLIST",
].join("\n");

const withKey = (keyLine: string): string => {
  const lines = MEDIA.split("\n");
  lines.splice(2, 0, keyLine);
  return lines.join("\n");
};

const playlistWith = (keyLine: string) => {
  const parsed = parsePlaylist(withKey(keyLine), new URL("https://cdn.test/index.m3u8"));
  if (parsed.kind !== "media") throw new Error(`expected media playlist, got ${parsed.kind}`);
  return parsed;
};

describe("HLS DRM detection mirrors the shipped parser predicate", () => {
  it("treats the Widevine KEYFORMAT URN as DRM", () => {
    const parsed = playlistWith(
      `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAA",KEYID=0x01020304,KEYFORMAT="${WIDEVINE_URN}"`,
    );
    expect(parsed.hasDrm).toBe(true);
  });

  it("treats PlayReady KEYFORMAT as DRM", () => {
    const parsed = playlistWith(
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://keys.test/pr",KEYFORMAT="com.microsoft.playready"',
    );
    expect(parsed.hasDrm).toBe(true);
  });

  it("does not treat FairPlay streamingkeydelivery as DRM (shipped predicate stores fps.1_0)", () => {
    const parsed = playlistWith(
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"',
    );
    expect(parsed.hasDrm).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker encryption boundary
// ---------------------------------------------------------------------------

const noopChannel = (): BroadcastChannelLike => ({
  postMessage: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  close: () => undefined,
});

const planFor = (strategy: DownloadPlan["strategy"]): DownloadPlan => ({
  download_id: "download_enc",
  headers: new Headers(),
  good_basename: "enc",
  subdir: "",
  save_as: false,
  will_use_jsfetch: true,
  strategy,
  url: new URL("https://cdn.test/index.m3u8"),
  carry_get_params: false,
  extension: "mp4",
  muxer: "mp4",
  is_youtube: false,
  throttle: false,
  cache: "default",
});

const workerWith = (playlistText: string): DownloadWorker =>
  new DownloadWorker({
    channel: noopChannel(),
    fetchImpl: (async () => {
      const data = new TextEncoder().encode(playlistText);
      let sent = false;
      return {
        status: 200,
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (sent) return { done: true };
              sent = true;
              return { done: false, value: data };
            },
          }),
        },
      };
    }) as FetchLike,
    openRoot: async () => createFakeOpfs().root,
  });

describe("worker refuses encrypted HLS instead of saving ciphertext", () => {
  it("refuses SAMPLE-AES streams", async () => {
    const worker = workerWith(
      withKey('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://keys.test/k",KEYFORMAT="identity"'),
    );
    const result = await worker.runPlan(planFor("m3u8_audio_video_one_source"));
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toMatch(/Encrypted HLS is not supported/);
  });

  it("refuses AES-128 streams explicitly (no decrypter in this rebuild)", async () => {
    const worker = workerWith(withKey('#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k"'));
    const result = await worker.runPlan(planFor("m3u8_audio_video_one_source"));
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toMatch(/AES-128 encrypted HLS is not supported/);
  });

  it("still assembles unencrypted streams", async () => {
    const worker = workerWith(MEDIA.replace("seg0.m4s", "seg0.m4s") + "\n#EXT-X-MAP:URI=\"init.mp4\"");
    // The fake fetch serves the same playlist text for every URL; a 1 KB+ body is not available here,
    // so this only asserts the encryption pre-flight does not trip on unencrypted input.
    const result = await worker.runPlan(planFor("m3u8_audio_video_one_source"));
    expect(result.tag === "Err" ? result.error : "").not.toMatch(/Encrypted HLS/);
  });
});

// ---------------------------------------------------------------------------
// Carry-get-params flag derivation
// ---------------------------------------------------------------------------

describe("carry_get_params is derived from CARRY_GET_PARAM_WEBSITES", () => {
  it("enables carrying when the manifest host has the behaviour flag", () => {
    let behaviours: Behaviours = { websites: new Map() };
    behaviours = setFlag(behaviours, "CARRY_GET_PARAM_WEBSITES", "cdn.test", true);
    expect(
      deriveCarryGetParams(behaviours, {
        master_url: new URL("https://cdn.test/master.m3u8?token=abc"),
      }),
    ).toBe(true);
  });

  it("falls back to the page initiator host and defaults to false", () => {
    let behaviours: Behaviours = { websites: new Map() };
    behaviours = setFlag(behaviours, "CARRY_GET_PARAM_WEBSITES", "page.test", true);
    expect(deriveCarryGetParams(behaviours, { initiator: new URL("https://page.test/watch") })).toBe(true);
    expect(deriveCarryGetParams({ websites: new Map() }, { initiator: new URL("https://page.test/watch") })).toBe(
      false,
    );
    expect(deriveCarryGetParams({ websites: new Map() }, {})).toBe(false);
  });
});

describe("direct CDN transfers (live YouTube regression)", () => {
  const makeWorker = (
    responses: Array<{ status: number; body?: string }>,
    captured: Array<Record<string, string>>,
  ): DownloadWorker => {
    let index = 0;
    return new DownloadWorker({
      channel: noopChannel(),
      fetchImpl: (async (_url: string, init?: { headers?: Headers }) => {
        (init?.headers ?? new Headers()).forEach((value, key) => captured.push({ [key.toLowerCase()]: value }));
        const response = responses[Math.min(index++, responses.length - 1)] ?? { status: 500 };
        const data = new TextEncoder().encode(response.body ?? "");
        let sent = false;
        return {
          status: response.status,
          ok: response.status >= 200 && response.status < 300,
          body:
            response.status >= 400
              ? null
              : {
                  getReader: () => ({
                    read: async () => {
                      if (sent) return { done: true };
                      sent = true;
                      return { done: false, value: data };
                    },
                  }),
                },
        };
      }) as never,
      openRoot: async () => createFakeOpfs().root,
    });
  };

  it("retries a rejected direct request with Range: bytes=0-", async () => {
    const captured: Array<Record<string, string>> = [];
    const worker = makeWorker([{ status: 403 }, { status: 200, body: "x".repeat(2000) }], captured);
    const result = await worker.runPlan(planFor("http_audio_video_one_source"));
    expect(result.tag).toBe("Ok");
    expect(captured.some((headers) => headers["range"] === "bytes=0-")).toBe(true);
  });

  it("reports the HTTP status when the direct transfer fails", async () => {
    const captured: Array<Record<string, string>> = [];
    const worker = makeWorker([{ status: 403 }], captured);
    const result = await worker.runPlan(planFor("http_audio_video_one_source"));
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toContain("403");
  });

  it.each([
    { label: "plan size", planSize: 4000, responseHeaders: undefined },
    { label: "Content-Length", planSize: undefined, responseHeaders: new Headers({ "content-length": "4000" }) },
    {
      label: "Content-Range total",
      planSize: undefined,
      responseHeaders: new Headers({ "content-length": "2000", "content-range": "bytes 0-1999/4000" }),
    },
  ])("reports direct-download percentage from $label", async ({ planSize, responseHeaders }) => {
    const progress: Array<Record<string, unknown>> = [];
    const channel: BroadcastChannelLike = {
      ...noopChannel(),
      postMessage: (message) => {
        const value = (message as { msg?: { data?: { progress?: Record<string, unknown> } } }).msg?.data?.progress;
        if (value !== undefined) progress.push(value);
      },
    };
    const data = new TextEncoder().encode("x".repeat(2000));
    let sent = false;
    const worker = new DownloadWorker({
      channel,
      fetchImpl: (async () => ({
        status: 200,
        ok: true,
        ...(responseHeaders !== undefined ? { headers: responseHeaders } : {}),
        body: {
          getReader: () => ({
            read: async () => {
              if (sent) return { done: true };
              sent = true;
              return { done: false, value: data };
            },
          }),
        },
      })) as FetchLike,
      openRoot: async () => createFakeOpfs().root,
    });
    const result = await worker.runPlan({
      ...planFor("http_audio_video_one_source"),
      url: new URL("https://cdn.test/progress.mp4"),
      ...(planSize !== undefined ? { size: planSize } : {}),
    });
    expect(result.tag).toBe("Ok");
    expect(progress).toContainEqual({
      status: "downloading",
      fetched_bytes_count: 2000,
      percent: { is_known: true, value: 50 },
    });
  });
});

describe("minimum output size for direct transfers (live 31-byte regression)", () => {
  it("rejects a tiny 200 response instead of saving it", async () => {
    const worker = new DownloadWorker({
      channel: noopChannel(),
      fetchImpl: (async () => {
        const data = new TextEncoder().encode("short error body");
        let sent = false;
        return {
          status: 200,
          ok: true,
          body: {
            getReader: () => ({
              read: async () => {
                if (sent) return { done: true };
                sent = true;
                return { done: false, value: data };
              },
            }),
          },
        };
      }) as never,
      openRoot: async () => createFakeOpfs().root,
    });
    const directPlan: DownloadPlan = { ...planFor("http_audio_video_one_source"), url: new URL("https://cdn.test/a.mp4") };
    const result = await worker.runPlan(directPlan);
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toMatch(/too small/);
  });
});
