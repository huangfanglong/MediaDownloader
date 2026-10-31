import { afterEach, describe, expect, it, vi } from "vitest";
import { err, ok } from "../src/core/option.js";
import { userAbortReason, type EndingReason } from "../src/core/types.js";
import {
  MAX_FETCH_ATTEMPTS,
  MAX_READ_ATTEMPTS,
  MANIFEST_ATTEMPTS,
  MANIFEST_RETRY_POLICY,
  SEGMENT_ATTEMPTS,
  SEGMENT_RETRY_DELAYS_MS,
  SEGMENT_RETRY_POLICY,
  BODY_READ_TIMEOUT_MS,
  exponentialDelay,
  isTerminalRetryError,
  sleepWithAbort,
  withRetry,
  withSegmentRetry,
  abortedError,
  httpError,
  otherError,
  timeoutError,
  type RetryError,
} from "../src/transfer/retry.js";
import {
  FORBIDDEN_HEADERS,
  MAX_DNR_RULES,
  SAFE_HEADERS,
  buildDnrRule,
  escapeDnrRegex,
  chunkRules,
  fetchBytes,
  headersForJsFetch,
  headersForNativeRequest,
  headersForPlan,
  urlFilterFor,
  type FetchLike,
  type FetchResponseLike,
} from "../src/transfer/fetch.js";
import {
  MAX_FAILED_SEGMENT_RATIO,
  MIN_OUTPUT_BYTES,
  buildSegmentRequests,
  checkOutputCompleteness,
  classifySegmentFailure,
  computePercent,
  concatenate,
  defaultIv,
  isTooManyFailedSegments,
  percentageIncompleteReason,
  prependInit,
  totalBytes,
  unsupportedAes128Decrypter,
  type HlsSegment,
} from "../src/transfer/assemble.js";
import {
  DOWNLOAD_ERROR_MESSAGES,
  WORKER_ERROR_MESSAGES,
  buildDeterminingFilenameAnswer,
  buildDownloadRequest,
  composeFilename,
  downloadNotFoundReason,
  endingReasonToMessage,
  mapDownloadTerminalState,
  mapWorkerErrorToReason,
} from "../src/transfer/save.js";

afterEach(() => {
  vi.useRealTimers();
});

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

// ===========================================================================
// retry.ts — E11/E12/E13/E17
// ===========================================================================

describe("retry constants (proven numbers)", () => {
  it("exposes the recovered timeout and attempt budgets", () => {
    expect(BODY_READ_TIMEOUT_MS).toBe(30_000);
    expect(MANIFEST_ATTEMPTS).toBe(5);
    expect(SEGMENT_ATTEMPTS).toBe(5);
    expect(SEGMENT_RETRY_DELAYS_MS).toEqual([0, 500, 1000, 1500]);
    expect(MAX_FETCH_ATTEMPTS).toBe(6);
    expect(MAX_READ_ATTEMPTS).toBe(6);
  });

  it("segment policy delays are 0/500/1000/1500 and clamp on extra retries", () => {
    expect(
      [0, 1, 2, 3, 4].map((attempt) => SEGMENT_RETRY_POLICY.delayFor(attempt)),
    ).toEqual([0, 500, 1000, 1500, 1500]);
    expect(MANIFEST_RETRY_POLICY.delayFor(0)).toBe(0);
    expect(MANIFEST_RETRY_POLICY.maxAttempts).toBe(5);
  });

  it("classifies terminal errors: 404/416, timeout, abort", () => {
    expect(isTerminalRetryError(httpError(404))).toBe(true);
    expect(isTerminalRetryError(httpError(416))).toBe(true);
    expect(isTerminalRetryError(httpError(500))).toBe(false);
    expect(isTerminalRetryError(timeoutError())).toBe(true);
    expect(isTerminalRetryError(abortedError())).toBe(true);
    expect(isTerminalRetryError(otherError("boom"))).toBe(false);
  });

  it("exponential backoff formula is base * 2^attempt", () => {
    expect(exponentialDelay(500, 0)).toBe(500);
    expect(exponentialDelay(500, 3)).toBe(4000);
  });
});

describe("withRetry", () => {
  it("returns the first successful attempt", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        return ok("value");
      },
      { maxAttempts: 3, baseDelayMs: 10 },
    );
    expect(result).toEqual(ok("value"));
    expect(attempts).toBe(1);
  });

  it("retries retryable failures up to maxAttempts and returns the last error", async () => {
    let attempts = 0;
    const result = await withRetry(
      async (attempt) => {
        attempts += 1;
        return err(httpError(500 + attempt));
      },
      { maxAttempts: 3, baseDelayMs: 0 },
    );
    expect(result).toEqual(err(httpError(502)));
    expect(attempts).toBe(3);
  });

  it("does not retry 404/416", async () => {
    for (const status of [404, 416]) {
      let attempts = 0;
      const result = await withRetry(
        async () => {
          attempts += 1;
          return err(httpError(status));
        },
        { maxAttempts: 5, baseDelayMs: 0 },
      );
      expect(result).toEqual(err(httpError(status)));
      expect(attempts).toBe(1);
    }
  });

  it("does not retry timeouts or aborts", async () => {
    let timeoutAttempts = 0;
    await withRetry(
      async () => {
        timeoutAttempts += 1;
        return err(timeoutError());
      },
      { maxAttempts: 5, baseDelayMs: 0 },
    );
    expect(timeoutAttempts).toBe(1);

    let abortAttempts = 0;
    await withRetry(
      async () => {
        abortAttempts += 1;
        return err(abortedError());
      },
      { maxAttempts: 5, baseDelayMs: 0 },
    );
    expect(abortAttempts).toBe(1);
  });

  it("waits base * 2^attempt between retryable attempts (fake timers)", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const pending = withRetry(
      async () => {
        attempts += 1;
        return attempts < 3 ? err(otherError("boom")) : ok("done");
      },
      { maxAttempts: 3, baseDelayMs: 100 },
    );

    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    await expect(pending).resolves.toEqual(ok("done"));
  });

  it("clamps maxAttempts to at least one", async () => {
    let attempts = 0;
    await withRetry(
      async () => {
        attempts += 1;
        return err(otherError("boom"));
      },
      { maxAttempts: 0 },
    );
    expect(attempts).toBe(1);
  });

  it("stops before the first attempt when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        return ok("never");
      },
      { maxAttempts: 3, signal: controller.signal },
    );
    expect(attempts).toBe(0);
    expect(result).toEqual(err(abortedError()));
  });

  it("withSegmentRetry uses the segment policy attempt budget and 0/500/1000/1500 delays", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const pending = withSegmentRetry(async (attempt) => {
      attempts += 1;
      return err(httpError(500 + attempt));
    });

    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(4);
    await vi.advanceTimersByTimeAsync(1500);
    expect(attempts).toBe(5);
    await expect(pending).resolves.toEqual(err(httpError(504)));
  });

  it("sleepWithAbort resolves immediately for zero/aborted sleeps", async () => {
    await expect(sleepWithAbort(0)).resolves.toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    await expect(
      sleepWithAbort(60_000, controller.signal),
    ).resolves.toBeUndefined();
  });
});

// ===========================================================================
// fetch.ts — E12/E28 header + DNR model
// ===========================================================================

describe("header sets (Bm/Hm)", () => {
  it("keeps only the safe headers for native requests", () => {
    const source = new Headers([
      ["Sec-Fetch-Site", "same-origin"],
      ["Cookie", "a=1"],
      ["Date", "today"],
      ["Origin", "https://example.com"],
      ["Referer", "https://example.com/watch"],
      ["Authorization", "Bearer x"],
      ["User-Agent", "agent"],
      ["Range", "bytes=0-1"],
    ]);
    const safe = headersForNativeRequest(source);
    expect([...safe.keys()].sort()).toEqual([
      "cookie",
      "date",
      "origin",
      "referer",
      "sec-fetch-site",
    ]);
    expect(safe.get("referer")).toBe("https://example.com/watch");
  });

  it("strips forbidden headers for the jsfetch path and keeps the rest", () => {
    const source = new Headers([
      ["Authorization", "Bearer x"],
      ["x-custom", "value"],
      ["Range", "bytes=0-1"],
      ["User-Agent", "agent"],
      ["Accept-Encoding", "gzip"],
      ["Proxy-Authorization", "secret"],
      ["Host", "cdn.example"],
      ["Referer", "https://example.com/watch"],
    ]);
    const jsfetch = headersForJsFetch(source);
    expect([...jsfetch.keys()].sort()).toEqual([
      "authorization",
      "referer",
      "x-custom",
    ]);
  });

  it("headersForPlan drops both the forbidden and the safe sets", () => {
    const source = new Headers([
      ["Cookie", "a=1"],
      ["Referer", "https://example.com/watch"],
      ["Range", "bytes=0-1"],
      ["Authorization", "Bearer x"],
    ]);
    expect([...headersForPlan(source).keys()]).toEqual(["authorization"]);
  });

  it("accepts record and entry-array header sources", () => {
    expect(
      headersForNativeRequest({ Referer: "https://x/" }).get("referer"),
    ).toBe("https://x/");
    expect(
      headersForNativeRequest([["Origin", "https://y"]]).get("origin"),
    ).toBe("https://y");
  });

  it("header pattern tables are exported in order", () => {
    expect(SAFE_HEADERS).toHaveLength(5);
    expect(FORBIDDEN_HEADERS.length).toBeGreaterThanOrEqual(19);
    expect(SAFE_HEADERS[0]?.test("Sec-Fetch-Site")).toBe(true);
    expect(FORBIDDEN_HEADERS[0]?.test("Range")).toBe(true);
  });
});

describe("declarativeNetRequest rules (E28)", () => {
  it("builds the exact recovered updateSessionRules shape", () => {
    const headers = new Headers([
      ["Cookie", "a=1"],
      ["Referer", "https://example.com/watch"],
    ]);
    expect(
      buildDnrRule({ id: 7, dir: "https://cdn.example/media/", headers }),
    ).toEqual({
      id: 7,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { operation: "set", header: "cookie", value: "a=1" },
          {
            operation: "set",
            header: "referer",
            value: "https://example.com/watch",
          },
        ],
      },
      condition: {
        urlFilter: "|https://cdn.example/media/*",
        resourceTypes: ["xmlhttprequest"],
      },
    });
  });

  it("urlFilterFor anchors absolute filters and appends a single wildcard", () => {
    expect(urlFilterFor("https://cdn.example/")).toBe("|https://cdn.example/*");
    expect(urlFilterFor("https://cdn.example/*")).toBe("https://cdn.example/*");
    expect(urlFilterFor("media-segment")).toBe("media-segment*");
  });

  it("chunks rules at the proven 750-rule budget", () => {
    expect(MAX_DNR_RULES).toBe(750);
    const rules = Array.from({ length: 751 }, (_, index) => index);
    const chunks = chunkRules(rules);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(750);
    expect(chunks[1]).toEqual([750]);
    expect(chunkRules(rules.slice(0, 750))).toHaveLength(1);
    expect(chunkRules([])).toEqual([]);
    expect(() => chunkRules(rules, 0)).toThrow("max must be a positive number");
  });
});

function chunkedBody(chunks: Uint8Array[]): FetchResponseLike {
  let index = 0;
  return {
    status: 200,
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          const value = chunks[index];
          index += 1;
          return value === undefined ? { done: true } : { done: false, value };
        },
      }),
    },
  };
}

const fakeFetch =
  (response: FetchResponseLike | Error): FetchLike =>
  async () => {
    if (response instanceof Error) throw response;
    return response;
  };

describe("fetchBytes (E12)", () => {
  it("reads the body chunks and concatenates them", async () => {
    const result = await fetchBytes(
      fakeFetch(chunkedBody([bytes(1, 2), bytes(3)])),
      "https://x/",
    );
    expect(result).toEqual(ok({ bytes: bytes(1, 2, 3), status: 200 }));
  });

  it("passes chunks to a sink without concatenating them", async () => {
    const chunks: Uint8Array[] = [];
    const result = await fetchBytes(
      fakeFetch(chunkedBody([bytes(1, 2), bytes(3)])),
      "https://x/",
      {},
      { onChunk: (chunk) => { chunks.push(chunk); } },
    );
    expect(result).toEqual(ok({ bytes: new Uint8Array(), status: 200 }));
    expect(chunks).toEqual([bytes(1, 2), bytes(3)]);
  });

  it("maps 4xx/5xx to an http error with its status", async () => {
    for (const status of [403, 404, 416, 500]) {
      const result = await fetchBytes(
        fakeFetch({ status, ok: false, body: null }),
        "https://x/",
      );
      expect(result).toEqual(err(httpError(status)));
    }
  });

  it("maps non-http-ok status to the verbatim unknown-failure string", async () => {
    const result = await fetchBytes(
      fakeFetch({ status: 304, ok: false, body: null }),
      "https://x/",
    );
    expect(result).toEqual(err(otherError("Unkown failure - status 304")));
  });

  it("maps a missing body to 'No body'", async () => {
    const result = await fetchBytes(
      fakeFetch({ status: 200, ok: true, body: null }),
      "https://x/",
    );
    expect(result).toEqual(err(otherError("No body")));
  });

  it("turns a Range init value into the Range request header", async () => {
    let seen: Headers | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = init?.headers;
      return chunkedBody([bytes(9)]);
    };
    await fetchBytes(fetchImpl, "https://x/seg", { range: "bytes=0-9" });
    expect(seen?.get("Range")).toBe("bytes=0-9");
  });

  it("times out a body read that never finishes", async () => {
    const hanging: FetchResponseLike = {
      status: 200,
      ok: true,
      body: { getReader: () => ({ read: () => new Promise(() => undefined) }) },
    };
    const result = await fetchBytes(
      fakeFetch(hanging),
      "https://x/",
      {},
      { timeoutMs: 5 },
    );
    expect(result).toEqual(err(timeoutError("Timeout")));
  });

  it("returns an aborted error when the signal aborts the fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return chunkedBody([]);
    };
    const fromInit = await fetchBytes(fetchImpl, "https://x/", {
      signal: controller.signal,
    });
    const fromOptions = await fetchBytes(
      fetchImpl,
      "https://x/",
      {},
      { signal: controller.signal },
    );
    expect(fromInit).toEqual(err(abortedError()));
    expect(fromOptions).toEqual(err(abortedError()));
    expect(called).toBe(false);
  });

  it("maps a thrown AbortError to an aborted error and other throws to other", async () => {
    const abortingFetch: FetchLike = async () => {
      throw new DOMException("aborted", "AbortError");
    };
    expect(await fetchBytes(abortingFetch, "https://x/")).toEqual(
      err(abortedError()),
    );

    const failingFetch: FetchLike = async () => {
      throw new Error("socket reset");
    };
    expect(await fetchBytes(failingFetch, "https://x/")).toEqual(
      err(otherError("socket reset")),
    );
  });
});

// ===========================================================================
// assemble.ts — E15/E16/E17/E19
// ===========================================================================

describe("buildSegmentRequests (E15/E16)", () => {
  const master = "https://cdn.example/path/master.m3u8?token=abc";

  it("resolves relative URLs and carries the master query string", () => {
    const segments: HlsSegment[] = [
      { url: "seg-0.ts" },
      { url: "https://other.example/seg-1.ts" },
    ];
    const descriptors = buildSegmentRequests(segments, {
      masterUrl: master,
      carryGetParams: true,
    });
    expect(descriptors.map((descriptor) => descriptor.url)).toEqual([
      "https://cdn.example/path/seg-0.ts?token=abc",
      "https://other.example/seg-1.ts?token=abc",
    ]);
  });

  it("does not copy the query when carryGetParams is false", () => {
    const descriptors = buildSegmentRequests([{ url: "seg-0.ts" }], {
      masterUrl: master,
      carryGetParams: false,
    });
    expect(descriptors[0]?.url).toBe("https://cdn.example/path/seg-0.ts");
  });

  it("turns BYTERANGE into a Range value", () => {
    const descriptors = buildSegmentRequests(
      [{ url: "seg-0.ts", byte_range: { offset: 100, length: 50 } }],
      { masterUrl: "https://cdn.example/master.m3u8", carryGetParams: false },
    );
    expect(descriptors[0]?.range).toBe("bytes=100-149");
  });

  it("resolves AES-128 key URLs and derives the default IV from the sequence number", () => {
    const explicitIv = new Uint8Array(16).fill(9);
    const descriptors = buildSegmentRequests(
      [
        { url: "a.ts", sequence_number: 1, encryption: { url: "key.bin" } },
        {
          url: "b.ts",
          sequence_number: 2,
          encryption: { url: "key.bin", iv: explicitIv },
        },
      ],
      {
        masterUrl: "https://cdn.example/hls/master.m3u8",
        carryGetParams: false,
      },
    );
    expect(descriptors[0]?.aes128?.keyUrl).toBe(
      "https://cdn.example/hls/key.bin",
    );
    expect(descriptors[0]?.aes128?.iv).toEqual(defaultIv(1));
    expect(descriptors[1]?.aes128?.iv).toEqual(explicitIv);
    // Explicit IV must be copied, not aliased.
    expect(descriptors[1]?.aes128?.iv).not.toBe(explicitIv);
  });

  it("uses mediaSequence for segments without a sequence number", () => {
    const descriptors = buildSegmentRequests(
      [{ url: "a.ts" }, { url: "b.ts" }],
      {
        masterUrl: "https://cdn.example/master.m3u8",
        carryGetParams: false,
        mediaSequence: 5,
      },
    );
    expect(descriptors[0]?.aes128).toBeUndefined();
    const encrypted = buildSegmentRequests(
      [{ url: "a.ts", encryption: { url: "k.bin" } }],
      {
        masterUrl: "https://cdn.example/master.m3u8",
        carryGetParams: false,
        mediaSequence: 5,
      },
    );
    expect(encrypted[0]?.aes128?.iv).toEqual(defaultIv(5));
  });

  it("prepends the EXT-X-MAP init descriptor exactly once", () => {
    const init = { url: "init.mp4", byte_range: { offset: 0, length: 700 } };
    const segments: HlsSegment[] = [
      { url: "s1.m4s", init },
      { url: "s2.m4s", init },
    ];
    const descriptors = buildSegmentRequests(segments, {
      masterUrl: "https://cdn.example/master.m3u8",
      carryGetParams: false,
    });
    expect(descriptors).toHaveLength(3);
    expect(descriptors[0]).toMatchObject({
      url: "https://cdn.example/init.mp4",
      isInit: true,
      range: "bytes=0-699",
    });
  });

  it("supports repeatInit for per-segment init prepending", () => {
    const init = { url: "init.mp4" };
    const descriptors = buildSegmentRequests(
      [
        { url: "s1.m4s", init },
        { url: "s2.m4s", init },
      ],
      {
        masterUrl: "https://cdn.example/master.m3u8",
        carryGetParams: false,
        repeatInit: true,
      },
    );
    expect(descriptors.map((descriptor) => descriptor.isInit === true)).toEqual(
      [true, false, true, false],
    );
  });

  it("defaultIv is 16 bytes big-endian at offset 12", () => {
    expect([...defaultIv(0)]).toEqual(new Array(16).fill(0));
    expect([...defaultIv(1).subarray(12)]).toEqual([0, 0, 0, 1]);
    expect([...defaultIv(0x01020304).subarray(12)]).toEqual([1, 2, 3, 4]);
  });
});

describe("byte assembly (E15/E16)", () => {
  it("concatenates in order and reports total bytes", () => {
    const chunks = [bytes(1, 2), bytes(), bytes(3)];
    expect(totalBytes(chunks)).toBe(3);
    expect(concatenate(chunks)).toEqual(bytes(1, 2, 3));
    expect(concatenate([])).toEqual(new Uint8Array(0));
  });

  it("prepends init bytes", () => {
    expect(prependInit(bytes(9), bytes(1, 2))).toEqual(bytes(9, 1, 2));
  });

  it("documents the AES-128 boundary with an unsupported default", async () => {
    await expect(
      unsupportedAes128Decrypter.decrypt({
        key: bytes(1),
        iv: bytes(2),
        data: bytes(3),
      }),
    ).rejects.toThrow(
      "AES-128 decryption is not implemented (transfer boundary)",
    );
  });
});

describe("failure policy and completion gates (E17/E19)", () => {
  it("exposes the proven thresholds", () => {
    expect(MAX_FAILED_SEGMENT_RATIO).toBe(0.35);
    expect(MIN_OUTPUT_BYTES).toBe(1000);
  });

  it("aborts on a failed mandatory first segment", () => {
    const result = classifySegmentFailure({
      failedSegments: 1,
      totalSegments: 10,
      isFirst: true,
    });
    expect(result).toEqual(
      err({
        ...otherFailure("Required segment was invalid, aborting download."),
      }),
    );
  });

  it("aborts when the invalid ratio exceeds 0.35", () => {
    expect(isTooManyFailedSegments(4, 10)).toBe(true);
    expect(isTooManyFailedSegments(3, 10)).toBe(false);
    expect(isTooManyFailedSegments(7, 20)).toBe(false); // exactly 0.35 is tolerated
    expect(isTooManyFailedSegments(8, 20)).toBe(true);
    expect(isTooManyFailedSegments(1, 0)).toBe(false);
    expect(
      classifySegmentFailure({
        failedSegments: 4,
        totalSegments: 10,
        isFirst: false,
      }),
    ).toEqual(
      err(otherFailure("Too many invalid segments, aborting download.")),
    );
  });

  it("skips a tolerable invalid segment", () => {
    expect(
      classifySegmentFailure({
        failedSegments: 1,
        totalSegments: 10,
        isFirst: false,
      }),
    ).toEqual(ok("skip"));
  });

  it("computePercent prefers output duration, then output size, else unknown", () => {
    expect(computePercent({ duration: 100 }, 0, 50_000)).toEqual({
      is_known: true,
      value: 50,
    });
    expect(computePercent({ size: 2000 }, 500, undefined)).toEqual({
      is_known: true,
      value: 25,
    });
    expect(computePercent({}, 500, undefined)).toEqual({
      is_known: false,
      value: 0,
    });
    expect(computePercent({ duration: "live", size: 1000 }, 250)).toEqual({
      is_known: true,
      value: 25,
    });
    // The strip-audio strategy never trusts percentages in the original (E19).
    expect(
      computePercent(
        { duration: 10, strategy: "http_strip_audio_jsfetch" },
        0,
        5000,
      ),
    ).toEqual({
      is_known: false,
      value: 0,
    });
  });

  it("rejects output under 1000 bytes with the verbatim message", () => {
    expect(checkOutputCompleteness({ outputBytes: 999 })).toEqual(
      err(otherFailure("Expected larger size, but only got 999 bytes")),
    );
    expect(checkOutputCompleteness({ outputBytes: 1000 })).toEqual(
      ok({ outputBytes: 1000 }),
    );
  });

  it("flags duration < 95% (and >= 5%) as percentage_incomplete", () => {
    expect(
      checkOutputCompleteness({
        outputBytes: 10_000,
        durationS: 100,
        outputDurationMs: 90_000,
      }),
    ).toEqual(err(percentageIncompleteReason()));
    expect(
      checkOutputCompleteness({
        outputBytes: 10_000,
        durationS: 100,
        outputDurationMs: 95_000,
      }),
    ).toEqual(ok({ outputBytes: 10_000 }));
    // Below the 5% trust gate the percentage is ignored, mirroring `c && g >= 5`.
    expect(
      checkOutputCompleteness({
        outputBytes: 10_000,
        durationS: 100,
        outputDurationMs: 3_000,
      }),
    ).toEqual(ok({ outputBytes: 10_000 }));
  });

  it("flags size < 90% as percentage_incomplete", () => {
    expect(
      checkOutputCompleteness({ outputBytes: 1700, sizeBytes: 2000 }),
    ).toEqual(err(percentageIncompleteReason()));
    expect(
      checkOutputCompleteness({ outputBytes: 1800, sizeBytes: 2000 }),
    ).toEqual(ok({ outputBytes: 1800 }));
  });
});

// ===========================================================================
// save.ts — E28/E29/E32
// ===========================================================================

const otherFailure = (message: string): EndingReason => ({
  user_abort: false,
  e4XX_5XX_failure: false,
  percentage_incomplete: false,
  other_failure: true,
  message,
});

describe("filename and download request (E28)", () => {
  it("composes subdir + basename + extension", () => {
    expect(
      composeFilename({
        subdir: "Videos/",
        good_basename: "My clip",
        extension: "mkv",
      }),
    ).toBe("Videos/My clip.mkv");
    expect(
      composeFilename({
        subdir: "",
        good_basename: "no-name",
        extension: "mp3",
      }),
    ).toBe("no-name.mp3");
  });

  it("strips a misleading .txt suffix and invalid extension from the final name", () => {
    expect(composeFilename({ subdir: "", good_basename: "video.txt", extension: "mp4" })).toBe("video.mp4");
    expect(composeFilename({ subdir: "", good_basename: "video.txt (1080p)", extension: "mp4" })).toBe("video (1080p).mp4");
    expect(composeFilename({ subdir: "", good_basename: "clip", extension: "txt" })).toBe("clip.mp4");
  });

  it("does not duplicate the planned media extension already present in the basename", () => {
    expect(composeFilename({ subdir: "", good_basename: "movie.mp4", extension: "mp4" })).toBe("movie.mp4");
  });

  it("builds the exact chrome.downloads.download options", () => {
    const request = buildDownloadRequest({
      blobUrl: "blob:chrome-extension://id/abc",
      plan: {
        subdir: "Videos/",
        good_basename: "clip",
        extension: "mp4",
        save_as: true,
      },
    });
    expect(request).toEqual({
      url: "blob:chrome-extension://id/abc",
      filename: "Videos/clip.mp4",
      conflictAction: "uniquify",
      saveAs: true,
    });
  });

  it("re-asserts the filename through onDeterminingFilename", () => {
    expect(buildDeterminingFilenameAnswer("Videos/clip.mp4")).toEqual({
      filename: "Videos/clip.mp4",
      conflictAction: "uniquify",
    });
  });
});

describe("terminal download state (E29)", () => {
  it("maps complete with a filename to its path", () => {
    expect(
      mapDownloadTerminalState({
        state: "complete",
        filename: "/Downloads/clip.mp4",
      }),
    ).toEqual(ok({ path: "/Downloads/clip.mp4" }));
  });

  it("maps complete without a filename to the proven message", () => {
    expect(mapDownloadTerminalState({ state: "complete" })).toEqual(
      err(otherFailure(DOWNLOAD_ERROR_MESSAGES.completedDetailsMissing)),
    );
  });

  it("maps a user cancel to the abort reason", () => {
    expect(
      mapDownloadTerminalState({
        state: "interrupted",
        interruptReason: "USER_CANCELED",
      }),
    ).toEqual(err(userAbortReason()));
  });

  it("maps interrupted errors to their browser string", () => {
    expect(
      mapDownloadTerminalState({
        state: "interrupted",
        error: "NETWORK_FAILED",
      }),
    ).toEqual(err(otherFailure("NETWORK_FAILED")));
    expect(mapDownloadTerminalState({ state: "interrupted" })).toEqual(
      err(otherFailure(DOWNLOAD_ERROR_MESSAGES.interruptedOnChange)),
    );
  });

  it("keeps the not-found and in-progress sentinels", () => {
    expect(mapDownloadTerminalState({ state: "in_progress" })).toEqual(
      err(otherFailure("Download still in progress")),
    );
    expect(downloadNotFoundReason()).toEqual(
      otherFailure(DOWNLOAD_ERROR_MESSAGES.notFound),
    );
  });
});

describe("worker error mapping (E12/E17/E19/E32)", () => {
  it("keeps the recovered worker strings verbatim", () => {
    expect(WORKER_ERROR_MESSAGES.requiredSegmentInvalid).toBe(
      "Required segment was invalid, aborting download.",
    );
    expect(WORKER_ERROR_MESSAGES.tooManyInvalidSegments).toBe(
      "Too many invalid segments, aborting download.",
    );
    expect(WORKER_ERROR_MESSAGES.network).toBe("Network error");
    expect(WORKER_ERROR_MESSAGES.read).toBe("Read() error");
    expect(WORKER_ERROR_MESSAGES.fetchTimeout).toBe("Fetch timeout");
  });

  it("maps segment/media failures to other-failure reasons with the exact message", () => {
    for (const message of [
      WORKER_ERROR_MESSAGES.requiredSegmentInvalid,
      WORKER_ERROR_MESSAGES.tooManyInvalidSegments,
      WORKER_ERROR_MESSAGES.decryptionFailed,
      WORKER_ERROR_MESSAGES.firstSegmentSkipped,
    ]) {
      expect(mapWorkerErrorToReason(message)).toEqual(otherFailure(message));
    }
  });

  it("maps ending-reason text forms", () => {
    expect(mapWorkerErrorToReason("User abort")).toEqual(userAbortReason());
    expect(mapWorkerErrorToReason("Incomplete percentage.")).toEqual(
      percentageIncompleteReason(),
    );
    expect(mapWorkerErrorToReason("HTTP error. Status: 403.")).toEqual({
      user_abort: false,
      e4XX_5XX_failure: true,
      percentage_incomplete: false,
      other_failure: false,
      status: 403,
    });
    expect(mapWorkerErrorToReason("Error. boom.")).toEqual(
      otherFailure("boom"),
    );
  });

  it("keeps unknown and fetch-wrapper messages as other failures", () => {
    expect(mapWorkerErrorToReason("Unkown failure - status 304")).toEqual(
      otherFailure("Unkown failure - status 304"),
    );
    expect(mapWorkerErrorToReason(new Error("socket reset"))).toEqual(
      otherFailure("socket reset"),
    );
    expect(mapWorkerErrorToReason({ message: "custom" })).toEqual(
      otherFailure("custom"),
    );
    expect(mapWorkerErrorToReason("No body")).toEqual(otherFailure("No body"));
  });

  it("passes an already-shaped ending reason through", () => {
    const reason = userAbortReason();
    expect(mapWorkerErrorToReason(reason)).toBe(reason);
  });

  it("renders ending reasons with the recovered Ws text", () => {
    expect(endingReasonToMessage(userAbortReason())).toBe("User abort");
    expect(
      endingReasonToMessage({
        user_abort: false,
        e4XX_5XX_failure: true,
        percentage_incomplete: false,
        other_failure: false,
        status: 403,
      }),
    ).toBe("HTTP error. Status: 403.");
    expect(endingReasonToMessage(percentageIncompleteReason())).toBe(
      "Incomplete percentage.",
    );
    expect(endingReasonToMessage(otherFailure("boom"))).toBe("Error. boom.");
  });
});

describe("exact DNR replay filters (P1 hardening)", () => {
  it("matches the literal plan URL and escapes DNR regex metacharacters", () => {
    const rule = buildDnrRule({
      id: 9,
      exactUrl: "https://cdn.example/media?a=1&path=*^?()[]{}",
      headers: new Headers([["cookie", "a=1"]]),
    });
    expect(rule.condition).toEqual({
      regexFilter: "^https://cdn\\.example/media\\?a=1&path=\\*\\^\\?\\(\\)\\[\\]\\{\\}$",
      resourceTypes: ["xmlhttprequest"],
    });
    expect((rule.condition as { urlFilter?: string }).urlFilter).toBeUndefined();
  });

  it("escapes every RE2 metacharacter", () => {
    expect(escapeDnrRegex("a.b*c?d^e$f(g)h[i]j{k}|l\\m")).toBe(
      "a\\.b\\*c\\?d\\^e\\$f\\(g\\)h\\[i\\]j\\{k\\}\\|l\\\\m",
    );
  });
});
