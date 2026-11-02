import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRanged, isRangeBoundCdn, RANGE_CHUNK_BYTES } from "../src/transfer/ranged.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { Channel } from "../src/protocol/channels.js";
import type { FetchLike } from "../src/transfer/fetch.js";
import type { DownloadPlan } from "../src/core/types.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import { createFakeOpfs, createRangedFetch } from "./helpers/transfer-fakes.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** One-chunk response body for fake range servers. */
function singleValueBody(value: Uint8Array) {
  let sent = false;
  return {
    getReader: () => ({
      read: async () => {
        if (sent) return { done: true };
        sent = true;
        return { done: false, value };
      },
      cancel: async () => undefined,
    }),
  };
}

describe("bounded-range download helper (googlevideo evidence)", () => {
  it("recognises range-bound CDN URLs", () => {
    expect(isRangeBoundCdn(new URL("https://rr1---sn-x.googlevideo.com/videoplayback?itag=18&clen=5"))).toBe(true);
    expect(isRangeBoundCdn(new URL("https://cdn.test/videoplayback?id=1&clen=5"))).toBe(true);
    expect(isRangeBoundCdn(new URL("https://cdn.test/movie.mp4"))).toBe(false);
  });

  it("fetches the file as bounded chunks and concatenates them", async () => {
    const size = 3 * 1024 * 1024 + 123;
    const payload = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) payload[index] = index % 251;
    const progress: number[] = [];
    const result = await fetchRanged(
      createRangedFetch(payload),
      new URL("https://rr1---sn-x.googlevideo.com/videoplayback?itag=18&clen=" + size),
      new Headers(),
      { chunkSize: 1024 * 1024, onBytes: (fetched) => progress.push(fetched) },
    );
    expect(result.tag).toBe("Ok");
    if (result.tag !== "Ok") return;
    expect(result.value.bytes.byteLength).toBe(size);
    expect(result.value.bytes).toEqual(payload);
    expect(result.value.total_bytes).toBe(size);
    expect(progress.length).toBe(4);
    expect(RANGE_CHUNK_BYTES).toBe(2 * 1024 * 1024);
  });

  it("streams bounded chunks to a sink without combining them", async () => {
    const payload = new Uint8Array(2 * 1024 * 1024 + 500).fill(9);
    const chunks: Uint8Array[] = [];
    const result = await fetchRanged(
      createRangedFetch(payload),
      new URL("https://rr1---sn-x.googlevideo.com/videoplayback?itag=18"),
      new Headers(),
      { chunkSize: 1024 * 1024, onChunk: (chunk) => { chunks.push(chunk); } },
    );
    expect(result.tag).toBe("Ok");
    if (result.tag !== "Ok") return;
    expect(result.value.bytes).toEqual(new Uint8Array());
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([1024 * 1024, 1024 * 1024, 500]);
  });

  it("stops on the short final chunk when the size is not declared", async () => {
    const size = 2 * 1024 * 1024 + 500;
    const payload = new Uint8Array(size).fill(9);
    const result = await fetchRanged(
      createRangedFetch(payload),
      new URL("https://rr1---sn-x.googlevideo.com/videoplayback?itag=18"),
      new Headers(),
      { chunkSize: 1024 * 1024 },
    );
    expect(result.tag).toBe("Ok");
    if (result.tag !== "Ok") return;
    expect(result.value.bytes.byteLength).toBe(size);
  });

  it("reports the HTTP failure when the CDN rejects the range", async () => {
    const fetchImpl = (async () => ({ status: 403, ok: false, body: null })) as unknown as FetchLike;
    const result = await fetchRanged(
      fetchImpl,
      new URL("https://rr1---sn-x.googlevideo.com/videoplayback?itag=18&clen=100"),
      new Headers(),
    );
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.status).toBe(403);
  });

  it("fails instead of returning a truncated object when the declared size is larger", async () => {
    const chunk = 512 * 1024;
    const payload = new Uint8Array(1.5 * chunk).fill(7);
    const result = await fetchRanged(
      createRangedFetch(payload),
      new URL(`https://rr1---sn-x.googlevideo.com/videoplayback?id=1&itag=18&clen=${3 * chunk}`),
      new Headers(),
      { chunkSize: chunk },
    );
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.message).toMatch(/ended early/);
  });

  it("retries a transient chunk failure instead of discarding the transfer", async () => {
    const chunk = 512 * 1024;
    const payload = new Uint8Array(3 * chunk + 100).fill(9);
    const serving = createRangedFetch(payload);
    const failingRange = `bytes=${chunk}-${2 * chunk - 1}`;
    const attempts = new Map<string, number>();
    let failedOnce = false;
    const fetchImpl: FetchLike = async (url, init) => {
      const range = new Headers(init?.headers).get("range") ?? "";
      attempts.set(range, (attempts.get(range) ?? 0) + 1);
      if (range === failingRange && !failedOnce) {
        failedOnce = true;
        throw new TypeError("fetch failed");
      }
      return serving(url, init);
    };
    const result = await fetchRanged(
      fetchImpl,
      new URL(`https://rr1---sn-x.googlevideo.com/videoplayback?id=1&itag=18&clen=${payload.byteLength}`),
      new Headers(),
      { chunkSize: chunk },
    );
    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(Buffer.from(result.value.bytes).equals(Buffer.from(payload))).toBe(true);
    }
    expect(attempts.get(failingRange)).toBe(2);
  });

  it("does not retry a terminal range rejection", async () => {
    const chunk = 512 * 1024;
    const payload = new Uint8Array(3 * chunk).fill(4);
    const failingRange = `bytes=${chunk}-${2 * chunk - 1}`;
    const attempts = new Map<string, number>();
    const fetchImpl: FetchLike = async (url, init) => {
      const range = new Headers(init?.headers).get("range") ?? "";
      attempts.set(range, (attempts.get(range) ?? 0) + 1);
      if (range === failingRange) return { status: 404, ok: false, body: null };
      return createRangedFetch(payload)(url, init);
    };
    const result = await fetchRanged(
      fetchImpl,
      new URL(`https://rr1---sn-x.googlevideo.com/videoplayback?id=1&itag=18&clen=${payload.byteLength}`),
      new Headers(),
      { chunkSize: chunk },
    );
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.status).toBe(404);
    expect(attempts.get(failingRange)).toBe(1);
  });

  it("rejects a server that ignores Range and repeats a short 200 body", async () => {
    // A proxy that ignores the range header answers every request with the same 1000-byte 200
    // body; trusting it concatenates that body until the advertised size and saves a corrupt file.
    const advertised = 10_000;
    const repeated = new Uint8Array(1_000).fill(3);
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      ok: true,
      body: singleValueBody(repeated),
    });
    const result = await fetchRanged(
      fetchImpl,
      new URL(`https://cdn.test/videoplayback?id=1&clen=${advertised}`),
      new Headers(),
      { chunkSize: 1_024 },
    );
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.message).toMatch(/range|advertis/i);
  });

  it("rejects a 206 whose Content-Range starts at the wrong offset", async () => {
    // The first range is genuine; every later response repeats it, so concatenation duplicates
    // the first kilobyte of the file until the advertised size is reached.
    const body = new Uint8Array(1_024).fill(1);
    const fetchImpl: FetchLike = async () => ({
      status: 206,
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-range" ? "bytes 0-1023/2048" : null),
      },
      body: singleValueBody(body),
    });
    const result = await fetchRanged(
      fetchImpl,
      new URL("https://cdn.test/videoplayback?id=1&clen=2048"),
      new Headers(),
      { chunkSize: 1_024 },
    );
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.message).toMatch(/range/i);
  });

  it("rejects a 200 response once the requested range is no longer at the start", async () => {
    const body = new Uint8Array(1_024).fill(2);
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return {
        status: calls === 1 ? 206 : 200,
        ok: true,
        headers: {
          get: (name: string) =>
            calls === 1 && name.toLowerCase() === "content-range" ? "bytes 0-1023/2048" : null,
        },
        body: singleValueBody(body),
      };
    };
    const result = await fetchRanged(
      fetchImpl,
      new URL("https://cdn.test/videoplayback?id=1&clen=2048"),
      new Headers(),
      { chunkSize: 1_024 },
    );
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.message).toMatch(/200|range/i);
  });
});

describe("worker ranged transfer (YouTube itag=18 path)", () => {
  it("downloads a googlevideo URL as bounded chunks and stages the full file", async () => {
    const size = 2 * 1024 * 1024 + 2048;
    const payload = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) payload[index] = index % 253;
    const { root, files } = createFakeOpfs();
    const posted: Array<{ msg: { name: string }; channel: number }> = [];
    const workerChannel: BroadcastChannelLike = {
      postMessage: (message) => posted.push(message as never),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      close: () => undefined,
    };
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ranged");
    const plan: DownloadPlan = {
      download_id: "download_ranged",
      headers: new Headers(),
      good_basename: "ranged",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "http_audio_video_one_source",
      url: new URL(`https://rr2---sn-x.googlevideo.com/videoplayback?id=1&itag=18&clen=${size}`),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: true,
      throttle: false,
      cache: "default",
    };
    const worker = new DownloadWorker({
      channel: workerChannel,
      fetchImpl: createRangedFetch(payload),
      openRoot: async () => root,
    });
    const result = await worker.runPlan(plan);
    expect(result.tag).toBe("Ok");
    if (result.tag === "Ok") {
      expect(result.value.download_id).toBe(plan.download_id);
      expect(result.value.internal_bloburl).toBe("blob:ranged");
      expect(result.value.output_extension).toBe("mp4");
    }
    const staged = [...(files.get(`${plan.download_id}.mp4`) ?? [])];
    const total = staged.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    expect(staged.length).toBeGreaterThan(1);
    expect(total).toBe(size);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of staged) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(merged).toEqual(payload);
  });

  it("does not stage a transfer whose object is shorter than the declared size", async () => {
    const actual = 3 * 1024 * 1024;
    const declared = 4 * 1024 * 1024;
    const payload = new Uint8Array(actual).fill(2);
    const { root, files } = createFakeOpfs();
    const workerChannel: BroadcastChannelLike = {
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      close: () => undefined,
    };
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:truncated");
    const plan: DownloadPlan = {
      download_id: "download_truncated",
      headers: new Headers(),
      good_basename: "truncated",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "http_audio_video_one_source",
      url: new URL(`https://rr2---sn-x.googlevideo.com/videoplayback?id=1&itag=18&clen=${declared}`),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: true,
      throttle: false,
      cache: "default",
    };
    const worker = new DownloadWorker({
      channel: workerChannel,
      fetchImpl: createRangedFetch(payload),
      openRoot: async () => root,
    });
    const result = await worker.runPlan(plan);
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toMatch(/ended early/);
    // The partially staged file is removed instead of being reported as a finished download.
    expect(files.size).toBe(0);
  });
});
