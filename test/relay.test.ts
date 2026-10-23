import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64, handleMediaStreamRequest } from "../src/extension/content-script.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { RELAY_MESSAGES } from "../src/protocol/rebuild-messages.js";
import { Channel } from "../src/protocol/channels.js";
import { encode } from "../src/protocol/serde.js";
import type { DownloadPlan } from "../src/core/types.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import { createFakeOpfs } from "./helpers/transfer-fakes.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("page-context relay (content script)", () => {
  it("streams body chunks as base64 and finishes with the total", async () => {
    const body = new Uint8Array(1200).fill(7);
    const ranges: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { headers?: HeadersInit }) => {
        const range = new Headers(init?.headers).get("range") ?? "";
        ranges.push(range);
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        const start = match ? Number(match[1]) : 0;
        const end = match ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
        const slice = body.slice(start, end + 1);
        return {
          ok: true,
          status: 206,
          arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
        };
      }),
    );
    const sent: Array<{ msg: { name: string; data: unknown }; channel: number }> = [];
    const runtime = {
      sendMessage: async (message: { msg: { name: string; data: unknown }; channel: number }) => {
        sent.push(message);
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    };
    await handleMediaStreamRequest(runtime as never, { request_id: "r1", url: "https://cdn.test/v.mp4" });
    const chunks = sent.filter((message) => message.msg.name === RELAY_MESSAGES.MediaStreamChunk);
    expect(ranges[0]).toBe("bytes=0-2097151");
    expect(chunks).toHaveLength(1);
    const payload = chunks[0]?.msg.data as { data: string };
    expect(payload.data).toBe(bytesToBase64(body));
    expect(sent.at(-1)?.msg.name).toBe(RELAY_MESSAGES.MediaStreamEnd);
    expect((sent.at(-1)?.msg.data as { total: number }).total).toBe(1200);
  });

  it("reports HTTP failures back to the service worker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, body: null })));
    const sent: Array<{ msg: { name: string } }> = [];
    const runtime = {
      sendMessage: async (message: { msg: { name: string } }) => {
        sent.push(message);
      },
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    };
    await handleMediaStreamRequest(runtime as never, { request_id: "r2", url: "https://cdn.test/v.mp4" });
    expect(sent.at(-1)?.msg.name).toBe(RELAY_MESSAGES.MediaStreamError);
  });
});

const plan: DownloadPlan = {
  download_id: "download_relay",
  headers: new Headers(),
  good_basename: "relay",
  subdir: "",
  save_as: false,
  will_use_jsfetch: false,
  strategy: "http_audio_video_one_source",
  url: new URL("https://cdn.test/videoplayback?id=abc&itag=18"),
  carry_get_params: false,
  extension: "mp4",
  muxer: "mp4",
  is_youtube: true,
  throttle: false,
  cache: "default",
};

describe("page-context relay (worker staging)", () => {
  it("assembles relayed chunks into a staged file and reports the result", async () => {
    const { root, files } = createFakeOpfs();
    const posted: Array<{ msg: { name: string; data: unknown }; channel: number }> = [];
    const listeners: Array<(event: { data: unknown }) => void> = [];
    const workerChannel: BroadcastChannelLike = {
      postMessage: (message) => posted.push(message as never),
      addEventListener: (_type, listener) => listeners.push(listener as never),
      removeEventListener: () => undefined,
      close: () => undefined,
    };
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:relayed");
    const worker = new DownloadWorker({
      channel: workerChannel,
      fetchImpl: (async () => ({ status: 500, ok: false, body: null })) as never,
      openRoot: async () => root,
    });
    worker.start();
    const send = (name: string, data: unknown): void => {
      for (const listener of listeners) listener({ data: { msg: { name, data }, channel: Channel.FromServiceToWorker } });
    };
    send(RELAY_MESSAGES.WorkerRelayStart, { download_args: encode(plan) });
    await flush();
    const firstChunk = new Uint8Array(900).fill(1);
    send(RELAY_MESSAGES.WorkerRelayChunk, { download_id: plan.download_id, data: firstChunk });
    send(RELAY_MESSAGES.WorkerRelayChunk, { download_id: plan.download_id, data: new Uint8Array(200).fill(2) });
    await flush();
    send(RELAY_MESSAGES.WorkerRelayEnd, { download_id: plan.download_id });
    await flush();
    const result = posted.find((message) => message.msg.name === "download_result");
    expect(result).toBeDefined();
    const data = result?.msg.data as { internal_bloburl: string; download_id: string };
    expect(data.download_id).toBe(plan.download_id);
    expect(data.internal_bloburl).toBe("blob:relayed");
    const staged = [...files.get(`${plan.download_id}.mp4`) ?? []].flatMap((chunk) => [...chunk]);
    expect(staged.length).toBe(1100);
    expect(staged[0]).toBe(1);
    expect(staged[1099]).toBe(2);
  });
});
