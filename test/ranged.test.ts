import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRanged, isRangeBoundCdn, RANGE_CHUNK_BYTES } from "../src/transfer/ranged.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import { Channel } from "../src/protocol/channels.js";
import type { FetchLike } from "../src/transfer/fetch.js";
import type { DownloadPlan } from "../src/core/types.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import type { OpfsDirectory, OpfsRoot } from "../src/extension/staging.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Serve bounded ranges; anything else is 403 like googlevideo (live probe evidence). */
function rangeFetch(payload: Uint8Array): FetchLike {
  return (async (_url: string, init?: { headers?: HeadersInit }) => {
    const range = new Headers(init?.headers).get("range");
    if (!range) return { status: 403, ok: false, body: null };
    const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
    if (!match) return { status: 403, ok: false, body: null };
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), payload.length - 1);
    if (start >= payload.length) return { status: 416, ok: false, body: null };
    const slice = payload.slice(start, end + 1);
    let sent = false;
    return {
      status: 206,
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: slice };
          },
          cancel: async () => undefined,
        }),
      },
    };
  }) as unknown as FetchLike;
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
      rangeFetch(payload),
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

  it("stops on the short final chunk when the size is not declared", async () => {
    const size = 2 * 1024 * 1024 + 500;
    const payload = new Uint8Array(size).fill(9);
    const result = await fetchRanged(
      rangeFetch(payload),
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
});

const fakeRoot = (files: Map<string, Uint8Array[]>): OpfsRoot => {
  const directory: OpfsDirectory = {
    getFileHandleWithSyncAccess: async (name) => ({
      handle: {
        write: async (data) => {
          const chunks = files.get(name) ?? [];
          chunks.push(new Uint8Array(data));
          files.set(name, chunks);
          return { written: data.byteLength };
        },
        close: async () => undefined,
        truncate: async () => undefined,
      },
    }),
    getFileHandle: async (name) => ({
      name,
      getFile: async () => new Blob((files.get(name) ?? []).map((chunk) => new Blob([chunk]))) as File,
    }),
    removeEntry: async (name) => {
      files.delete(name);
    },
  };
  return { getDirectoryHandle: async () => directory };
};

describe("worker ranged transfer (YouTube itag=18 path)", () => {
  it("downloads a googlevideo URL as bounded chunks and stages the full file", async () => {
    const size = 2 * 1024 * 1024 + 2048;
    const payload = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) payload[index] = index % 253;
    const files = new Map<string, Uint8Array[]>();
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
      fetchImpl: rangeFetch(payload),
      openRoot: async () => fakeRoot(files),
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
    expect(total).toBe(size);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of staged) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(merged).toEqual(payload);
  });
});
