/**
 * Bounded-range response checks: a loop may only trust bytes that can be placed at the offset it
 * requested. These are the pure rules every range loop uses before appending a body.
 */
import { describe, expect, it } from "vitest";
import { checkRangeResponse, parseContentRange } from "../src/transfer/range-integrity.js";

const range = (contentRange: string) => ({
  requestedOffset: 0,
  requestedLength: 1024,
  status: 206,
  contentRange,
});

describe("parseContentRange", () => {
  it("parses bounded ranges with a known or unknown total", () => {
    expect(parseContentRange("bytes 0-1023/2048")).toEqual({ start: 0, end: 1023, total: 2048 });
    expect(parseContentRange("bytes 1024-2047/*")).toEqual({ start: 1024, end: 2047 });
  });

  it("rejects malformed or impossible ranges", () => {
    expect(parseContentRange("items 0-1/2")).toBeUndefined();
    expect(parseContentRange("bytes 10-9/20")).toBeUndefined();
    expect(parseContentRange("bytes 0-5/5")).toBeUndefined();
    expect(parseContentRange("bytes 0-5")).toBeUndefined();
  });
});

describe("checkRangeResponse", () => {
  it("accepts a whole-object 200 only at the start, with the advertised size", () => {
    expect(
      checkRangeResponse({
        requestedOffset: 0,
        requestedLength: 1024,
        status: 200,
        bodyLength: 4096,
        declaredTotal: 4096,
      }),
    ).toEqual({ tag: "Ok", kind: "whole-object" });
    expect(
      checkRangeResponse({
        requestedOffset: 0,
        requestedLength: 1024,
        status: 200,
        bodyLength: 1000,
        declaredTotal: 4096,
      }).tag,
    ).toBe("Err");
  });

  it("rejects HTTP 200 once the range is no longer at the start", () => {
    const verdict = checkRangeResponse({
      requestedOffset: 1024,
      requestedLength: 1024,
      status: 200,
      bodyLength: 1024,
    });
    expect(verdict.tag).toBe("Err");
    if (verdict.tag === "Err") expect(verdict.reason).toMatch(/200|ignored/i);
  });

  it("requires Content-Range to start at the requested offset", () => {
    const verdict = checkRangeResponse({
      ...range("bytes 0-1023/4096"),
      requestedOffset: 1024,
      bodyLength: 1024,
    });
    expect(verdict.tag).toBe("Err");
    if (verdict.tag === "Err") expect(verdict.reason).toMatch(/starting at 0/i);
  });

  it("requires the body to match the declared range length", () => {
    const verdict = checkRangeResponse({
      ...range("bytes 0-1023/4096"),
      bodyLength: 512,
    });
    expect(verdict.tag).toBe("Err");
    if (verdict.tag === "Err") expect(verdict.reason).toMatch(/declares 1024/i);
  });

  it("rejects a range total that disagrees with the advertised size", () => {
    const verdict = checkRangeResponse({
      ...range("bytes 0-1023/9999"),
      bodyLength: 1024,
      declaredTotal: 4096,
    });
    expect(verdict.tag).toBe("Err");
    if (verdict.tag === "Err") expect(verdict.reason).toMatch(/disagrees/i);
  });

  it("accepts a verified range", () => {
    expect(
      checkRangeResponse({ ...range("bytes 1024-2047/4096"), requestedOffset: 1024, bodyLength: 1024 }),
    ).toEqual({ tag: "Ok", kind: "range", start: 1024, end: 2047, total: 4096 });
  });

  it("falls back to status and body length when Content-Range is hidden", () => {
    expect(
      checkRangeResponse({
        requestedOffset: 1024,
        requestedLength: 1024,
        status: 206,
        bodyLength: 1024,
      }).tag,
    ).toBe("Ok");
    const oversized = checkRangeResponse({
      requestedOffset: 1024,
      requestedLength: 1024,
      status: 206,
      bodyLength: 2048,
    });
    expect(oversized.tag).toBe("Err");
    if (oversized.tag === "Err") expect(oversized.reason).toMatch(/2048 bytes for a 1024-byte request/i);
  });

  it("rejects unexpected status codes and malformed Content-Range", () => {
    expect(
      checkRangeResponse({ requestedOffset: 0, requestedLength: 1024, status: 204, bodyLength: 0 }).tag,
    ).toBe("Err");
    expect(
      checkRangeResponse({ ...range("nonsense"), bodyLength: 1024 }).tag,
    ).toBe("Err");
  });
});
