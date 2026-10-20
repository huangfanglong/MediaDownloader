/**
 * Retry, timeout and backoff policy for transfer requests.
 *
 * Evidence: `analysis/evidence/04-download-transfer.md`
 *  - E13 — `Ki` = FetchWithRetry: `r` attempts, per-attempt timeout, exponential backoff
 *    `Math.pow(2, attempt) * base`, abort distinct from timeout, 404/416 terminal.
 *    analysis/pretty/download_worker__main.js.pretty.js lines 1952-1976.
 *  - E12 — `vr = 3e4` body-read timeout (download_worker lines 3930, 3946-3968).
 *  - E17 — segment demux retry: one initial try + four retries, delays `500 * attempt`
 *    = 0/500/1000/1500 ms (download_worker lines 3983-3988, 4180-4202).
 *  - E11 — libav-injected `MAX_FETCH_ATTEMPTS = 6`, `MAX_READ_ATTEMPTS = 6`
 *    (download_worker lines 1997-2004; consumed by libav-*.wasm.mjs ~offset 41,663).
 *  - E14 — default segment concurrency 4 (`fn`).
 */
import { err, ok, type Result } from "../core/option.js";

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/** Classification of a failed attempt. Distinguishing abort from timeout is deliberate. */
export type RetryErrorKind =
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "read"
  | "other";

export interface RetryError {
  kind: RetryErrorKind;
  /** HTTP status when `kind === "http"`. */
  status?: number;
  message?: string;
}

export const httpError = (status: number, message?: string): RetryError => ({
  kind: "http",
  status,
  message,
});

export const networkError = (message?: string): RetryError => ({
  kind: "network",
  message,
});

export const timeoutError = (message = "Timeout"): RetryError => ({
  kind: "timeout",
  message,
});

export const abortedError = (message?: string): RetryError => ({
  kind: "aborted",
  message,
});

export const readError = (message?: string): RetryError => ({
  kind: "read",
  message,
});

export const otherError = (message: string): RetryError => ({
  kind: "other",
  message,
});

/**
 * Terminal failures are never retried.
 *
 * Evidence:
 *  - 404/416 return `{err_status}` immediately from `Ki` (E13) — e.g. a byte range the server
 *    rejects is not helped by asking again.
 *  - An aborted attempt is the user cancelling (`a.aborted`) and must stop the loop.
 *  - A timeout returns `{timeout: !0}` from `Ki` without another iteration (E13); libav maps its
 *    timeout to return code 1003 and stops too (E11).
 */
export function isTerminalRetryError(error: RetryError): boolean {
  if (error.kind === "aborted" || error.kind === "timeout") return true;
  return (
    error.kind === "http" && (error.status === 404 || error.status === 416)
  );
}

// ---------------------------------------------------------------------------
// Proven policy constants
// ---------------------------------------------------------------------------

/** Body-read timeout for one response (`vr`). Evidence E12. */
export const BODY_READ_TIMEOUT_MS = 30_000;
/** Manifest fetch attempts (`xr = 5`; loop refetches immediately). Evidence E17/E13. */
export const MANIFEST_ATTEMPTS = 5;
/** Segment demux attempts: 1 initial + 4 retries (`xr - 1`). Evidence E17. */
export const SEGMENT_ATTEMPTS = 5;
/** Delay before segment retry 0..3 (`dn * a`, dn = 500). Evidence E17. */
export const SEGMENT_RETRY_DELAYS_MS = [0, 500, 1000, 1500] as const;
/** libav jsfetch attempt budget injected as a global. Evidence E11. */
export const MAX_FETCH_ATTEMPTS = 6;
/** libav jsfetch read attempt budget injected as a global. Evidence E11. */
export const MAX_READ_ATTEMPTS = 6;
/** Default segment concurrency (`fn = 4`; 1 when throttled). Evidence E14. */
export const DEFAULT_SEGMENT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

/** Resolve after `ms`, or immediately when the signal aborts. Uses real timers (fake-timer safe). */
export function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export interface WithRetryOptions {
  /** Total attempts, including the first one. Values < 1 are clamped to 1. */
  maxAttempts: number;
  /** Backoff base in ms: default delay for attempt `n` is `baseDelayMs * 2^n`. */
  baseDelayMs?: number;
  /** Override the backoff entirely. Receives the 0-based index of the attempt that just failed. */
  delayFor?: (attempt: number) => number;
  /** Override terminal classification (defaults to {@link isTerminalRetryError}). */
  isTerminal?: (error: RetryError) => boolean;
  /** Cancels the loop before an attempt or during a backoff sleep. */
  signal?: AbortSignal;
}

/**
 * Run `run(attempt)` until it returns `Ok`, a terminal error occurs, attempts run out, or the
 * signal aborts. `attempt` is 0-based. Delays happen only between retryable failures.
 */
export async function withRetry<T>(
  run: (attempt: number) => Promise<Result<T, RetryError>>,
  options: WithRetryOptions,
): Promise<Result<T, RetryError>> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  const baseDelayMs = options.baseDelayMs ?? 0;
  const delayFor =
    options.delayFor ?? ((attempt: number) => baseDelayMs * 2 ** attempt);
  const isTerminal = options.isTerminal ?? isTerminalRetryError;

  let lastError: RetryError = otherError("no attempt was made");
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) return err(abortedError());
    const result = await run(attempt);
    if (result.tag === "Ok") return result;
    lastError = result.error;
    if (isTerminal(lastError)) return err(lastError);
    if (attempt + 1 >= maxAttempts) return err(lastError);
    await sleepWithAbort(delayFor(attempt), options.signal);
    if (options.signal?.aborted) return err(abortedError());
  }
  return err(lastError);
}

// ---------------------------------------------------------------------------
// Named policies matching the recovered numbers
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  maxAttempts: number;
  delayFor: (attempt: number) => number;
}

/** Manifest fetches: five tries, no sleep between them (E17). */
export const MANIFEST_RETRY_POLICY: RetryPolicy = {
  maxAttempts: MANIFEST_ATTEMPTS,
  delayFor: () => 0,
};

/** Segment attempts: five tries with linear 0/500/1000/1500 ms delays (E17). */
export const SEGMENT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: SEGMENT_ATTEMPTS,
  delayFor: (attempt: number) => {
    const delay = SEGMENT_RETRY_DELAYS_MS[attempt];
    return (
      delay ?? SEGMENT_RETRY_DELAYS_MS[SEGMENT_RETRY_DELAYS_MS.length - 1] ?? 0
    );
  },
};

/**
 * Convenience wrapper used by call sites: `withRetry(run, SEGMENT_RETRY_POLICY)`.
 * Kept as a function so callers cannot mutate the shared policy object.
 */
export function withSegmentRetry<T>(
  run: (attempt: number) => Promise<Result<T, RetryError>>,
  signal?: AbortSignal,
): Promise<Result<T, RetryError>> {
  return withRetry(run, {
    maxAttempts: SEGMENT_RETRY_POLICY.maxAttempts,
    delayFor: SEGMENT_RETRY_POLICY.delayFor,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Convenience wrapper for manifest fetches (E17). */
export function withManifestRetry<T>(
  run: (attempt: number) => Promise<Result<T, RetryError>>,
  signal?: AbortSignal,
): Promise<Result<T, RetryError>> {
  return withRetry(run, {
    maxAttempts: MANIFEST_RETRY_POLICY.maxAttempts,
    delayFor: MANIFEST_RETRY_POLICY.delayFor,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Backoff helper kept separate from the policy so tests can assert the formula directly. */
export function exponentialDelay(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * 2 ** attempt;
}

/** Assertion helper used by tests: ok with a value of the caller's choice. */
export const okAttempt = <T>(value: T): Result<T, RetryError> => ok(value);
