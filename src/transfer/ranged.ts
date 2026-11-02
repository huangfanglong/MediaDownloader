/**
 * Bounded-range downloads for CDNs that reject plain GETs.
 *
 * Evidence (live probe, 2026-10-18, sandboxed Brave + direct HTTP):
 *  - googlevideo answered plain GET with 403,
 *  - `Range: bytes=0-` (open ended) with 403,
 *  - `Range: bytes=0-1048575` / `bytes=0-2097151` with 206 + media bytes,
 *  - `Range: bytes=0-4194303` with 403 (2 MiB is the largest accepted probe).
 *
 * The player itself fetches bounded ranges, so the rebuild mirrors that: sequential bounded
 * chunks are concatenated into the final file.
 */
import { err, ok, type Result } from "../core/option.js";
import { declaredSize } from "./declared-size.js";
import { fetchBytes, type FetchLike } from "./fetch.js";
import { checkRangeResponse } from "./range-integrity.js";
import { abortedError, otherError, tooLargeError, withRetry, type RetryError } from "./retry.js";

/** Largest accepted range from the live probe; 2 MiB worked, 4 MiB was rejected. */
export const RANGE_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_RANGE_CHUNKS = 20000;
/**
 * A failed chunk is retried twice (no delay, then 500 ms) so one transient blip does not discard
 * a transfer that may already have downloaded gigabytes. Terminal failures (4xx, abort, timeout,
 * an over-ceiling body) are not retried; the retry policy classifies them.
 */
const CHUNK_ATTEMPTS = 3;
const CHUNK_RETRY_DELAYS_MS = [0, 500] as const;

export interface RangedFetchResult {
  bytes: Uint8Array;
  /** Total size when known (from `clen`/`len` query, or the final short chunk). */
  total_bytes?: number;
}

export interface RangedFetchOptions {
  chunkSize?: number;
  signal?: AbortSignal;
  onBytes?: (fetched: number, total: number | undefined) => void;
  onChunk?: (chunk: Uint8Array) => void | Promise<void>;
  /**
   * Aggregate byte ceiling for the URL. Without `onChunk` it bounds what is retained in memory;
   * with `onChunk` it is a total transfer cap (the consumer still receives every chunk).
   */
  maxBytes?: number;
}

/** True for googlevideo-style media URLs that only answer bounded byte ranges. */
export function isRangeBoundCdn(url: URL): boolean {
  if (/(^|\.)googlevideo\.com$/iu.test(url.hostname)) return true;
  return /videoplayback/iu.test(url.pathname) && url.searchParams.has("clen");
}

export { declaredSize } from "./declared-size.js";

/** The transfer stopped before the advertised size; saving the bytes would truncate the file. */
function truncatedError(retrieved: number, declared: number): RetryError {
  return otherError(`Range download ended early: ${retrieved} of ${declared} bytes`);
}

function concatenateParts(parts: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** Download `url` with sequential bounded `Range` requests and return the combined bytes. */
export async function fetchRanged(
  fetchImpl: FetchLike,
  url: URL,
  headers: Headers,
  options: RangedFetchOptions = {},
): Promise<Result<RangedFetchResult, RetryError>> {
  const chunkSize = Math.max(64 * 1024, Math.min(options.chunkSize ?? RANGE_CHUNK_BYTES, RANGE_CHUNK_BYTES));
  const total = declaredSize(url);
  const parts: Uint8Array[] = [];
  let offset = 0;
  let fetchedTotal: number | undefined = total;
  // Every accepted range grows `parts`; keep the aggregate inside the caller's ceiling as well as
  // the per-response one, so a server that keeps answering ranges cannot grow memory without
  // bound (one bounded range is 2 MiB; the loop allows 20 000 of them).
  const pastCeiling = (): boolean =>
    options.maxBytes !== undefined && offset > options.maxBytes;

  for (let attempt = 0; attempt < MAX_RANGE_CHUNKS; attempt += 1) {
    if (options.signal?.aborted) {
      return err(abortedError());
    }
    if (fetchedTotal !== undefined && offset >= fetchedTotal) break;
    const end = offset + chunkSize - 1;
    // A chunk fetch is idempotent (bytes are buffered before the consumer sees them), so a
    // transient failure is retried here instead of aborting the whole transfer.
    const result = await withRetry(
      () =>
        fetchBytes(
          fetchImpl,
          url.href,
          { headers, range: `bytes=${offset}-${end}` },
          { signal: options.signal, ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) },
        ),
      {
        maxAttempts: CHUNK_ATTEMPTS,
        delayFor: (attempt) =>
          CHUNK_RETRY_DELAYS_MS[attempt] ??
          CHUNK_RETRY_DELAYS_MS[CHUNK_RETRY_DELAYS_MS.length - 1] ??
          0,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (result.tag === "Err") {
      // A 416 after at least one chunk means the object ends here. If the URL advertised more
      // bytes, the object is truncated and saving it would produce a silently short file.
      if (result.error.kind === "http" && result.error.status === 416 && offset > 0) {
        if (total !== undefined && offset < total) return err(truncatedError(offset, total));
        fetchedTotal = offset;
        break;
      }
      return result;
    }
    const bytes = result.value.bytes;
    if (bytes.byteLength === 0) {
      if (total !== undefined && offset < total) return err(truncatedError(offset, total));
      fetchedTotal = offset;
      break;
    }
    // Never append bytes that cannot be placed at the requested offset: an ignored or mismatched
    // range would otherwise concatenate the same body repeatedly and report a corrupt file as done.
    const verdict = checkRangeResponse({
      requestedOffset: offset,
      requestedLength: chunkSize,
      status: result.value.status,
      bodyLength: bytes.byteLength,
      contentRange: result.value.headers?.get("content-range") ?? null,
      ...(total === undefined ? {} : { declaredTotal: total }),
    });
    if (verdict.tag === "Err") return err(otherError(`range response rejected: ${verdict.reason}`));
    if (options.onChunk !== undefined) await options.onChunk(bytes);
    else parts.push(bytes);
    offset += bytes.byteLength;
    if (pastCeiling()) return err(tooLargeError(`Range download exceeds ${options.maxBytes} bytes`));
    // A 200 at offset 0 means the server ignored Range and sent the whole object: that is the file.
    if (verdict.kind === "whole-object") {
      fetchedTotal = offset;
      options.onBytes?.(offset, offset);
      break;
    }
    if (fetchedTotal === undefined && verdict.total !== undefined) fetchedTotal = verdict.total;
    options.onBytes?.(offset, fetchedTotal);
    if (fetchedTotal === undefined && bytes.byteLength < chunkSize) {
      fetchedTotal = offset;
      break;
    }
  }

  // The loop can also end at the chunk cap or after a whole-object response: never report success
  // for fewer bytes than the URL advertised (or the responses declared through Content-Range).
  const expected = total ?? fetchedTotal;
  if (expected !== undefined && offset < expected) {
    return err(truncatedError(offset, expected));
  }
  if (offset === 0) {
    return err(otherError("range download returned no data"));
  }
  const totalBytes = Math.max(offset, ...parts.map((part) => part.byteLength));
  const bytes = options.onChunk === undefined
    ? concatenateParts(parts, parts.reduce((sum, part) => sum + part.byteLength, 0))
    : new Uint8Array();
  return ok({ bytes, total_bytes: fetchedTotal ?? totalBytes });
}
