/**
 * A streamed response body must not stay open after the transfer stops using it. The only
 * remaining writer in that loop is the chunk consumer (OPFS staging), so a consumer failure has
 * to release the underlying stream before the error leaves `fetchBytes`.
 */
import { describe, expect, it } from "vitest";
import type { DownloadPlan } from "../src/core/types.js";
import { TransferStrategy } from "../src/core/types.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import { DownloadWorker } from "../src/extension/download-worker.js";
import type { OpfsDirectory, OpfsRoot } from "../src/extension/staging.js";
import { abortedError, timeoutError } from "../src/transfer/retry.js";
import { fetchBytes, type FetchLike, type FetchResponseLike } from "../src/transfer/fetch.js";

interface StreamState {
  reads: number;
  cancels: number;
  live: boolean;
}

/** Response body that counts reads and records whether the consumer released the stream. */
function trackedBody(chunks: Uint8Array[]): { response: FetchResponseLike; state: StreamState } {
  const state: StreamState = { reads: 0, cancels: 0, live: true };
  let index = 0;
  return {
    state,
    response: {
      status: 200,
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            state.reads += 1;
            if (!state.live || index >= chunks.length) return { done: true };
            const value = chunks[index];
            index += 1;
            return { done: false, value };
          },
          cancel: async () => {
            state.cancels += 1;
            state.live = false;
          },
        }),
      },
    },
  };
}

const bytes = (n: number): Uint8Array => new Uint8Array([n]);

const noopChannel = (): BroadcastChannelLike => ({
  postMessage: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  close: () => undefined,
});

/** OPFS root whose writes succeed `successfulWrites` times, then fail (quota-style). */
function failingOpfs(successfulWrites: number): OpfsRoot {
  let writes = 0;
  const handle = {
    write: async (data: Uint8Array) => {
      writes += 1;
      if (writes > successfulWrites) throw new Error("OPFS quota exceeded");
      return { written: data.byteLength };
    },
    close: async () => undefined,
    truncate: async () => undefined,
  };
  const directory: OpfsDirectory = {
    getFileHandleWithSyncAccess: async () => ({ handle }),
    getFileHandle: async (name) => ({ name, getFile: async () => new Blob() as File }),
    removeEntry: async () => undefined,
  };
  return { getDirectoryHandle: async () => directory };
}

const directPlan = (): DownloadPlan => ({
  download_id: "download_direct_cleanup",
  headers: new Headers(),
  headers_origin: "https://cdn.example.com",
  good_basename: "direct-cleanup",
  subdir: "",
  save_as: false,
  will_use_jsfetch: false,
  strategy: TransferStrategy.HttpAudioVideoOneSource,
  url: new URL("https://cdn.example.com/media/file.mp4"),
  carry_get_params: false,
  extension: "mp4",
  muxer: "mp4",
  is_youtube: false,
  throttle: false,
  cache: "default",
});

describe("fetchBytes releases the response body when reading stops early", () => {
  it("cancels the reader when the chunk consumer throws", async () => {
    const { response, state } = trackedBody([bytes(1), bytes(2), bytes(3)]);
    const fetchImpl: FetchLike = async () => response;

    await expect(
      fetchBytes(fetchImpl, "https://x/", {}, {
        onChunk: () => {
          throw new Error("append failed");
        },
      }),
    ).rejects.toThrow("append failed");

    expect(state.cancels).toBe(1);
    expect(state.live).toBe(false);
  });

  it("cancels the reader when an async chunk consumer rejects", async () => {
    const { response, state } = trackedBody([bytes(1), bytes(2), bytes(3)]);
    const fetchImpl: FetchLike = async () => response;

    await expect(
      fetchBytes(fetchImpl, "https://x/", {}, {
        onChunk: async () => {
          throw new Error("quota exceeded");
        },
      }),
    ).rejects.toThrow("quota exceeded");

    expect(state.cancels).toBe(1);
    expect(state.live).toBe(false);
  });

  it("stops reading after the consumer fails", async () => {
    const { response, state } = trackedBody([bytes(1), bytes(2), bytes(3)]);
    const fetchImpl: FetchLike = async () => response;
    const seen: number[] = [];

    await expect(
      fetchBytes(fetchImpl, "https://x/", {}, {
        onChunk: (chunk) => {
          seen.push(chunk[0] ?? -1);
          throw new Error("stop");
        },
      }),
    ).rejects.toThrow("stop");

    expect(seen).toEqual([1]);
    expect(state.reads).toBe(1);
  });

  it("releases the reader when the total-size callback throws", async () => {
    const { response, state } = trackedBody([bytes(1)]);
    const withLength: FetchResponseLike = {
      ...response,
      headers: new Headers({ "content-length": "1" }),
    };
    const fetchImpl: FetchLike = async () => withLength;

    await expect(
      fetchBytes(fetchImpl, "https://x/", {}, {
        onTotalSize: () => {
          throw new Error("size callback failed");
        },
      }),
    ).rejects.toThrow("size callback failed");

    expect(state.cancels).toBe(1);
  });

  it("keeps cancelling on abort, timeout and the byte cap", async () => {
    let timeoutCancels = 0;
    const abortedBody = trackedBody([bytes(1), bytes(2)]);
    const controller = new AbortController();
    const aborted = await fetchBytes(
      async () => abortedBody.response,
      "https://x/",
      {},
      {
        signal: controller.signal,
        onChunk: () => {
          controller.abort();
        },
      },
    );
    expect(aborted).toEqual({ tag: "Err", error: abortedError() });
    expect(abortedBody.state.cancels).toBe(1);

    const slow: FetchResponseLike = {
      status: 200,
      ok: true,
      body: {
        getReader: () => ({
          read: () => new Promise(() => undefined),
          cancel: async () => {
            timeoutCancels += 1;
          },
        }),
      },
    };
    const timedOut = await fetchBytes(async () => slow, "https://x/", {}, { timeoutMs: 5 });
    expect(timedOut).toEqual({ tag: "Err", error: timeoutError("Timeout") });
    expect(timeoutCancels).toBe(1);

    const oversized = trackedBody([bytes(1), bytes(2)]);
    const capped = await fetchBytes(
      async () => oversized.response,
      "https://x/",
      {},
      { maxBytes: 1 },
    );
    expect(capped.tag).toBe("Err");
    expect(oversized.state.cancels).toBe(1);
  });

  it("does not cancel a body that was read to the end", async () => {
    const { response, state } = trackedBody([bytes(1), bytes(2)]);
    const result = await fetchBytes(async () => response, "https://x/");

    expect(result.tag).toBe("Ok");
    expect(state.cancels).toBe(0);
    expect(state.live).toBe(true);
  });
});

describe("fetchBytes releases combined-signal listeners", () => {
  /** Parent signals usually outlive one request, so listeners must not accumulate on them. */
  function countingSignal(counters: { added: number; removed: number }): AbortSignal {
    return {
      aborted: false,
      addEventListener: () => {
        counters.added += 1;
      },
      removeEventListener: () => {
        counters.removed += 1;
      },
    } as unknown as AbortSignal;
  }

  it("removes the parent abort listeners after the request settles", async () => {
    const counters = { added: 0, removed: 0 };
    const { response } = trackedBody([bytes(1)]);
    const result = await fetchBytes(
      async () => response,
      "https://x/",
      { signal: countingSignal(counters) },
      { signal: countingSignal(counters) },
    );
    expect(result.tag).toBe("Ok");
    expect(counters).toEqual({ added: 2, removed: 2 });
  });

  it("attaches no listener when only one signal is supplied", async () => {
    const counters = { added: 0, removed: 0 };
    const { response } = trackedBody([bytes(1)]);
    const result = await fetchBytes(async () => response, "https://x/", {}, { signal: countingSignal(counters) });
    expect(result.tag).toBe("Ok");
    expect(counters).toEqual({ added: 0, removed: 0 });
  });
});

describe("streamed direct transfers release the response body when staging fails", () => {
  it("fails the transfer and cancels the reader when an OPFS append rejects", async () => {
    const stream = trackedBody([bytes(1), bytes(2), bytes(3)]);
    const worker = new DownloadWorker({
      channel: noopChannel(),
      fetchImpl: async () => stream.response,
      openRoot: async () => failingOpfs(1),
    });

    const result = await worker.runPlan(directPlan());

    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toContain("OPFS quota exceeded");
    expect(stream.state.cancels).toBe(1);
    expect(stream.state.live).toBe(false);
  });
});
