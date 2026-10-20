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
import { fetchBytes, type FetchLike } from "./fetch.js";
import { abortedError, otherError, type RetryError } from "./retry.js";

/** Largest accepted range from the live probe; 2 MiB worked, 4 MiB was rejected. */
export const RANGE_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_RANGE_CHUNKS = 20000;

export interface RangedFetchResult {
  bytes: Uint8Array;
  /** Total size when known (from `clen`/`len` query, or the final short chunk). */
  total_bytes?: number;
}

export interface RangedFetchOptions {
  chunkSize?: number;
  signal?: AbortSignal;
  onBytes?: (fetched: number, total: number | undefined) => void;
}

/** True for googlevideo-style media URLs that only answer bounded byte ranges. */
export function isRangeBoundCdn(url: URL): boolean {
  if (/(^|\.)googlevideo\.com$/iu.test(url.hostname)) return true;
  return /videoplayback/iu.test(url.pathname) && url.searchParams.has("clen");
}

/** Size advertised by the query string (`clen=` or `len=`). */
export function declaredSize(url: URL): number | undefined {
  for (const name of ["clen", "len", "size"]) {
    const raw = url.searchParams.get(name);
    if (raw === null) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
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

  for (let attempt = 0; attempt < MAX_RANGE_CHUNKS; attempt += 1) {
    if (options.signal?.aborted) {
      return err(abortedError());
    }
    if (fetchedTotal !== undefined && offset >= fetchedTotal) break;
    const end = offset + chunkSize - 1;
    const result = await fetchBytes(
      fetchImpl,
      url.href,
      { headers, range: `bytes=${offset}-${end}` },
      { signal: options.signal },
    );
    if (result.tag === "Err") {
      // A 416 after at least one chunk means the caller's size was larger than the object.
      if (result.error.kind === "http" && result.error.status === 416 && parts.length > 0) break;
      return result;
    }
    const bytes = result.value.bytes;
    if (bytes.byteLength === 0) break;
    // Defensive: if the server ignored the range and returned the whole object, keep it once.
    if (bytes.byteLength > chunkSize && parts.length === 0) {
      parts.push(bytes);
      offset = bytes.byteLength;
      break;
    }
    parts.push(bytes);
    offset += bytes.byteLength;
    options.onBytes?.(offset, fetchedTotal);
    if (fetchedTotal === undefined && bytes.byteLength < chunkSize) {
      fetchedTotal = offset;
      break;
    }
  }

  if (parts.length === 0) {
    return err(otherError("range download returned no data"));
  }
  const totalBytes = Math.max(offset, ...parts.map((part) => part.byteLength));
  const bytes = concatenateParts(parts, parts.reduce((sum, part) => sum + part.byteLength, 0));
  return ok({ bytes, total_bytes: fetchedTotal ?? totalBytes });
}
