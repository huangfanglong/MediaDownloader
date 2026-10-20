/**
 * HTTP primitives and request-header/DNR modelling for the transfer layer.
 *
 * Evidence: `analysis/evidence/04-download-transfer.md`
 *  - E12 — fetch wrapper `ne` + body/read timeouts (`vr = 3e4`): status 400..599 →
 *    `{e4XX_5XX_failure, status}`; other non-ok → `Unkown failure - status <n>`; missing body →
 *    `No body`. download_worker pretty lines 3930-3968.
 *  - E11/E19 — retry classification lives in `retry.ts`; this module only performs one attempt.
 *  - E28/§3.7 — DNR header model: `Bm` = safe headers kept for the native request
 *    (`Sec-*` / `Cookie` / `Date` / `Origin` / `Referer`); `Hm` = headers stripped before building
 *    jsfetch rules; rule shape `{id, priority:1,
 *    action:{type:"modifyHeaders",requestHeaders:[…]},
 *    condition:{urlFilter:<dir>* resourceTypes:["xmlhttprequest"]}}`;
 *    `Tv = 750` max rules for one download; service pretty lines 8709-8882.
 *  - E14 — default segment concurrency 4.
 */
import { err, ok, type Result } from "../core/option.js";
import {
  BODY_READ_TIMEOUT_MS,
  DEFAULT_SEGMENT_CONCURRENCY,
  httpError,
  abortedError,
  otherError,
  readError,
  timeoutError,
  type RetryError,
} from "./retry.js";

// ---------------------------------------------------------------------------
// Header sets (original `Bm` and `Hm`)
// ---------------------------------------------------------------------------

/** Headers kept for the worker's own (native) request. Original `Bm` (E28, lines 8710). */
export const SAFE_HEADERS: readonly RegExp[] = [
  /^Sec-/i,
  /^Cookie$/i,
  /^Date$/i,
  /^Origin$/i,
  /^Referer$/i,
];

/** Headers stripped before jsfetch/DNR handling. Original `Hm` (E28, lines 8711-8731). */
export const FORBIDDEN_HEADERS: readonly RegExp[] = [
  /Range/i,
  /^Proxy-/i,
  /^User-Agent$/i,
  /^Accept-Charset$/i,
  /^Accept-Encoding$/i,
  /^Access-Control-Request-Headers$/i,
  /^Access-Control-Request-Method$/i,
  /^Connection$/i,
  /^Content-Length$/i,
  /^DNT$/i,
  /^Expect$/i,
  /^Keep-Alive$/i,
  /^Permissions-Policy$/i,
  /^TE$/i,
  /^Trailer$/i,
  /^Transfer-Encoding$/i,
  /^Upgrade$/i,
  /^Via$/i,
  /^Host/i,
];

const matchesAny = (name: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(name));

/** True when `name` is in the safe set kept for native requests (original `Bm`). */
export function isSafeHeader(name: string): boolean {
  return matchesAny(name, SAFE_HEADERS);
}

/** True when `name` must be stripped before the jsfetch path (original `Hm`). */
export function isForbiddenHeader(name: string): boolean {
  return matchesAny(name, FORBIDDEN_HEADERS);
}

/** RFC 7230 token characters only; anything else is not a header name. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/;

/**
 * Sanitise headers captured from the network before they are replayed through DNR.
 *
 * Review 1.2 (header injection) is only partially applicable because Chrome already strips
 * CRLF from captured header values, but replay crosses a trust boundary, so we re-validate:
 * token-only names, no control characters, bounded value length, and the proven safe allowlist
 * (Sec-*, Cookie, Date, Origin, Referer).
 */
export function sanitizeReplayHeaders(source: HeaderSource, maxValueLength = 4096): Headers {
  const sanitized = new Headers();
  for (const [name, value] of toHeaderEntries(source)) {
    if (!HEADER_NAME_PATTERN.test(name)) continue;
    if (value.length > maxValueLength) continue;
    if (HEADER_VALUE_FORBIDDEN.test(value)) continue;
    if (!isSafeHeader(name)) continue;
    sanitized.set(name, value);
  }
  return sanitized;
}

export type HeaderSource =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string>;

function toHeaderEntries(source: HeaderSource): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (typeof Headers !== "undefined" && source instanceof Headers) {
    source.forEach((value, name) => entries.push([name, value]));
    return entries;
  }
  if (Array.isArray(source))
    return source.map(([name, value]) => [name, value]);
  for (const [name, value] of Object.entries(source as Record<string, string>))
    entries.push([name, value]);
  return entries;
}

function pick(
  source: HeaderSource,
  predicate: (name: string) => boolean,
): Headers {
  const headers = new Headers();
  for (const [name, value] of toHeaderEntries(source))
    if (predicate(name)) headers.set(name, value);
  return headers;
}

/**
 * Native-request header set: only the safe headers survive (original `Wm`, E28 lines 8848-8856).
 * Used for the worker's own `fetch` where the browser forbids setting most headers.
 */
export function headersForNativeRequest(source: HeaderSource): Headers {
  return pick(source, isSafeHeader);
}

/**
 * jsfetch header set: forbidden headers are dropped (original `Km`, E28 lines 8857-8866).
 * The rest are re-attached by DNR session rules, because libav's fetch runs inside WASM.
 */
export function headersForJsFetch(source: HeaderSource): Headers {
  return pick(source, (name) => !isForbiddenHeader(name));
}

/**
 * Headers that may be shipped inside the plan to the download worker at all
 * (original `Zs`, E28 lines 8867-8882): both the forbidden and the safe-only header sets are
 * removed from the plan copy, since those are handled by DNR / the native request respectively.
 */
export function headersForPlan(source: HeaderSource): Headers {
  return pick(
    source,
    (name) => !isForbiddenHeader(name) && !isSafeHeader(name),
  );
}

// ---------------------------------------------------------------------------
// declarativeNetRequest session-rule model
// ---------------------------------------------------------------------------

/** Rule budget for one HLS download (`Tv = 750`, E28 lines 8732/8777). */
export const MAX_DNR_RULES = 750;

/** Resource type used by every recovered rule (`resourceTypes:["xmlhttprequest"]`). */
export const DNR_RESOURCE_TYPES = ["xmlhttprequest"] as const;

export interface DnrRequestHeader {
  operation: "set";
  header: string;
  value: string;
}

export interface DnrRule {
  id: number;
  priority: 1;
  action: { type: "modifyHeaders"; requestHeaders: DnrRequestHeader[] };
  condition:
    | { urlFilter: string; resourceTypes: ["xmlhttprequest"] }
    | { regexFilter: string; resourceTypes: ["xmlhttprequest"] };
}

export interface BuildDnrRuleInput {
  id: number;
  /** Request directory/prefix. A trailing `*` is appended unless already present. */
  dir?: string;
  /** Preferred: exact request URL, escaped into a DNR regexFilter (no wildcard injection). */
  exactUrl?: string;
  headers: HeaderSource;
}

/**
 * DNR urlFilter for a media URL: anchored at the start so a URL embedded in another query
 * cannot match, and (when `dir` ends with `?`) restricted to the exact path + query boundary.
 * The original used `dir + "*"`; we additionally anchor because the captured headers are
 * credentials (adversarial review round 2, "DNR scoping is not exact").
 */
export function urlFilterFor(dir: string): string {
  if (dir.endsWith("*")) return dir;
  return dir.startsWith("http") ? `|${dir}*` : `${dir}*`;
}

/** Escape an exact URL for use as a DNR regexFilter (RE2 syntax). */
export function escapeDnrRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

/**
 * Exact `updateSessionRules` rule shape (original `ao`, E28 lines 8811-8839).
 * Header order follows `Headers` iteration order, which the original also relied on.
 * Callers replaying credentials should pass `exactUrl` so the URL is matched literally instead of
 * interpolating page-controlled path/query characters into a DNR wildcard filter.
 */
export function buildDnrRule(input: BuildDnrRuleInput): DnrRule {
  const requestHeaders: DnrRequestHeader[] = [];
  for (const [header, value] of toHeaderEntries(input.headers)) {
    requestHeaders.push({ operation: "set", header, value });
  }
  const resourceTypes = ["xmlhttprequest"] as ["xmlhttprequest"];
  const condition: DnrRule["condition"] =
    input.exactUrl !== undefined
      ? { regexFilter: `^${escapeDnrRegex(input.exactUrl)}$`, resourceTypes }
      : { urlFilter: urlFilterFor(input.dir ?? ""), resourceTypes };
  return {
    id: input.id,
    priority: 1,
    action: { type: "modifyHeaders", requestHeaders },
    condition,
  };
}

/**
 * Split rules into `updateSessionRules` batches. The original caps an HLS download's header
 * rules at `Tv = 750`; batching large lists keeps each update under Chrome's per-call limits.
 */
export function chunkRules<T>(rules: readonly T[], max = MAX_DNR_RULES): T[][] {
  if (max <= 0) throw new Error("max must be a positive number");
  const chunks: T[][] = [];
  for (let index = 0; index < rules.length; index += max)
    chunks.push(rules.slice(index, index + max));
  return chunks;
}

/** Deterministic-enough rule ids for tests; runtime callers inject their own generator. */
export function allocateRuleIds(
  count: number,
  next: () => number = () => Math.ceil(Math.random() * 1e8),
): number[] {
  return Array.from({ length: Math.max(0, count) }, () => next());
}

// ---------------------------------------------------------------------------
// One fetch attempt + timed body read
// ---------------------------------------------------------------------------

export interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(): Promise<void>;
}

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  body: { getReader(): ByteStreamReader } | null;
}

export interface FetchInitLike {
  headers?: Headers;
  signal?: AbortSignal;
  cache?: RequestCache;
  /** Value for the `Range` request header, e.g. `bytes=0-1023` (E16, `Ft`). */
  range?: string;
}

export type FetchLike = (
  url: string,
  init?: FetchInitLike,
) => Promise<FetchResponseLike>;

export interface FetchBytesResult {
  bytes: Uint8Array;
  status: number;
}

export interface FetchBytesOptions {
  /** Body-read deadline; defaults to `BODY_READ_TIMEOUT_MS` (30 s, E12). */
  timeoutMs?: number;
  /** Abort once the body exceeds this many bytes (defends against hostile manifests). */
  maxBytes?: number;
  /** Cancels the fetch and the body read. Combined with `init.signal` when both are present. */
  signal?: AbortSignal;
}

/** Combine two optional abort signals without relying on `AbortSignal.any` (Node/browser parity). */
function combineSignals(
  first?: AbortSignal,
  second?: AbortSignal,
): AbortSignal | undefined {
  if (first === undefined) return second;
  if (second === undefined || second === first) return first;
  if (first.aborted) return first;
  if (second.aborted) return second;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

const TIMED_OUT = Symbol("timed-out");

/** Resolve with the promise's value, or `TIMED_OUT` when the deadline hits first. */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";

/**
 * One HTTP attempt: fetch + read the whole body into memory with a deadline.
 *
 * This is the rebuilt `ne`+`pe` pair (E12) without a retry loop; wrap it with `withRetry`.
 * Error mapping keeps the original taxonomy so `save.mapWorkerErrorToReason` can round-trip the
 * proven user-visible strings.
 */
export async function fetchBytes(
  fetchImpl: FetchLike,
  url: string,
  init: FetchInitLike = {},
  options: FetchBytesOptions = {},
): Promise<Result<FetchBytesResult, RetryError>> {
  const signal = combineSignals(init.signal, options.signal);
  if (signal?.aborted) return err(abortedError());

  let headers = init.headers;
  if (init.range !== undefined) {
    headers = new Headers(init.headers);
    headers.set("Range", init.range);
  }
  const requestInit: FetchInitLike = {};
  if (headers !== undefined) requestInit.headers = headers;
  if (signal !== undefined) requestInit.signal = signal;
  if (init.cache !== undefined) requestInit.cache = init.cache;

  let response: FetchResponseLike;
  try {
    response = await fetchImpl(url, requestInit);
  } catch (error) {
    if (isAbortError(error)) return err(abortedError());
    return err(
      otherError(error instanceof Error ? error.message : String(error)),
    );
  }

  if (response.status >= 400 && response.status <= 599)
    return err(httpError(response.status));
  if (!response.ok)
    return err(otherError(`Unkown failure - status ${response.status}`));
  if (response.body === null) return err(otherError("No body"));

  const timeoutMs = options.timeoutMs ?? BODY_READ_TIMEOUT_MS;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    if (signal?.aborted) {
      await reader.cancel?.().catch(() => undefined);
      return err(abortedError());
    }
    const read = await withDeadline(reader.read(), timeoutMs);
    if (read === TIMED_OUT) {
      await reader.cancel?.().catch(() => undefined);
      return err(timeoutError("Timeout"));
    }
    if (read.done) break;
    const value = read.value;
    if (value !== undefined) {
      chunks.push(value);
      total += value.length;
      if (options.maxBytes !== undefined && total > options.maxBytes) {
        await reader.cancel?.().catch(() => undefined);
        return err(otherError(`Response exceeds ${options.maxBytes} bytes`));
      }
    }
  }

  return ok({
    bytes: concatenateBytes(chunks, total),
    status: response.status,
  });
}

/** Copy chunks into one buffer. Duplicated locally to keep `fetch.ts` independent of `assemble.ts`. */
function concatenateBytes(
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
