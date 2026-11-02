/**
 * Integrity rules for one bounded-range response.
 *
 * A range loop may only trust bytes it can place at the offset it requested. Without these checks
 * a server or proxy that ignores `Range` answers every request with the same body; the loop
 * concatenates it until the advertised size and the corrupt result is reported as a complete
 * download. `Content-Range` is required where the fetch surface exposes it (extension-context
 * fetches do); a cross-origin page-context response may hide it, so that caller can only enforce
 * the weaker checks (status and body length).
 */

export interface RangeResponseFacts {
  /** Offset requested with `Range: bytes=<offset>-<end>`. */
  requestedOffset: number;
  /** Number of bytes requested (the range end is inclusive). */
  requestedLength: number;
  status: number;
  bodyLength: number;
  /** `Content-Range` response header, when the fetch surface exposes it. */
  contentRange?: string | null;
  /** Size the URL advertised (`clen`), when known. */
  declaredTotal?: number;
}

export interface ParsedContentRange {
  /** First byte position of this body. */
  start: number;
  /** Last byte position included in this body. */
  end: number;
  /** Complete representation size, when the header carries one (`*` does not). */
  total?: number;
}

export type RangeResponseVerdict =
  | { tag: "Ok"; kind: "whole-object" }
  | { tag: "Ok"; kind: "range"; start: number; end: number; total?: number }
  | { tag: "Err"; reason: string };

const CONTENT_RANGE = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/iu;

/** Parse a `Content-Range: bytes <start>-<end>/<total|*>` value; undefined when malformed. */
export function parseContentRange(value: string): ParsedContentRange | undefined {
  const match = CONTENT_RANGE.exec(value.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  const rawTotal = match[3];
  if (rawTotal === "*" || rawTotal === undefined) return { start, end };
  const total = Number(rawTotal);
  if (!Number.isSafeInteger(total) || total <= end) return undefined;
  return { start, end, total };
}

/** Validate one response before its bytes are appended to a ranged transfer. */
export function checkRangeResponse(facts: RangeResponseFacts): RangeResponseVerdict {
  const { requestedOffset, requestedLength, status, bodyLength, declaredTotal } = facts;

  if (status === 200) {
    // Only the first request can legitimately be answered with the whole object: the server ignored
    // Range. Any later 200 means these bytes are not at the requested offset.
    if (requestedOffset > 0) {
      return {
        tag: "Err",
        reason: `range request at offset ${requestedOffset} was answered with HTTP 200 (byte range ignored)`,
      };
    }
    if (bodyLength === 0) return { tag: "Err", reason: "range request returned an empty body" };
    if (declaredTotal !== undefined && bodyLength !== declaredTotal) {
      return {
        tag: "Err",
        reason: `whole-object response is ${bodyLength} bytes, the URL advertises ${declaredTotal}`,
      };
    }
    return { tag: "Ok", kind: "whole-object" };
  }

  if (status !== 206) {
    return { tag: "Err", reason: `range request was answered with HTTP ${status}` };
  }

  const raw = facts.contentRange?.trim();
  if (raw === undefined || raw === "") {
    // Cross-origin page responses can hide Content-Range. Enforce what remains visible.
    if (bodyLength > requestedLength) {
      return {
        tag: "Err",
        reason: `range response is ${bodyLength} bytes for a ${requestedLength}-byte request`,
      };
    }
    if (declaredTotal !== undefined && requestedOffset + bodyLength > declaredTotal) {
      return { tag: "Err", reason: `range response exceeds the advertised ${declaredTotal}-byte size` };
    }
    return {
      tag: "Ok",
      kind: "range",
      start: requestedOffset,
      end: requestedOffset + Math.max(0, bodyLength - 1),
    };
  }

  const parsed = parseContentRange(raw);
  if (parsed === undefined) return { tag: "Err", reason: `invalid Content-Range "${raw}"` };
  if (parsed.start !== requestedOffset) {
    return {
      tag: "Err",
      reason: `server returned range starting at ${parsed.start}, requested ${requestedOffset}`,
    };
  }
  const declaredLength = parsed.end - parsed.start + 1;
  if (bodyLength !== declaredLength) {
    return {
      tag: "Err",
      reason: `range body is ${bodyLength} bytes, Content-Range declares ${declaredLength}`,
    };
  }
  if (declaredTotal !== undefined) {
    if (parsed.total !== undefined && parsed.total !== declaredTotal) {
      return {
        tag: "Err",
        reason: `range total ${parsed.total} disagrees with the advertised ${declaredTotal}`,
      };
    }
    if (requestedOffset + declaredLength > declaredTotal) {
      return { tag: "Err", reason: `range response exceeds the advertised ${declaredTotal}-byte size` };
    }
  }
  return {
    tag: "Ok",
    kind: "range",
    start: parsed.start,
    end: parsed.end,
    ...(parsed.total === undefined ? {} : { total: parsed.total }),
  };
}
