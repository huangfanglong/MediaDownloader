/**
 * Unit tests for scopedHeadersFor (U1 credential isolation).
 */
import { describe, expect, it } from "vitest";
import { scopedHeadersFor } from "../src/transfer/fetch.js";

describe("scopedHeadersFor", () => {
  const capturedHeaders = new Headers({
    Authorization: "Bearer secret-token",
    "X-Api-Key": "sk-page-key",
    "X-Custom": "custom-value",
  });

  const captureOrigin = "https://cdn.example.com";

  it("returns captured headers for same-origin segments", () => {
    const sameOriginUrl = "https://cdn.example.com/stream/seg-0.ts";
    const scoped = scopedHeadersFor(sameOriginUrl, captureOrigin, capturedHeaders);

    expect(scoped.get("authorization")).toBe("Bearer secret-token");
    expect(scoped.get("x-api-key")).toBe("sk-page-key");
    expect(scoped.get("x-custom")).toBe("custom-value");
  });

  it("returns empty headers for cross-origin segments", () => {
    const crossOriginUrl = "https://other.example.com/seg-1.ts";
    const scoped = scopedHeadersFor(crossOriginUrl, captureOrigin, capturedHeaders);

    expect(scoped.get("authorization")).toBeNull();
    expect(scoped.get("x-api-key")).toBeNull();
    expect(scoped.get("x-custom")).toBeNull();
    expect([...scoped.keys()]).toHaveLength(0);
  });

  it("returns empty headers for cross-origin even with same scheme/host (different port)", () => {
    const differentPort = "https://cdn.example.com:8443/seg.ts";
    const scoped = scopedHeadersFor(differentPort, captureOrigin, capturedHeaders);

    expect([...scoped.keys()]).toHaveLength(0);
  });

  it("returns empty headers for cross-origin subdomains", () => {
    const subdomain = "https://sub.cdn.example.com/seg.ts";
    const scoped = scopedHeadersFor(subdomain, captureOrigin, capturedHeaders);

    expect([...scoped.keys()]).toHaveLength(0);
  });

  it("returns empty headers for scheme mismatch", () => {
    const httpUrl = "http://cdn.example.com/seg.ts";
    const scoped = scopedHeadersFor(httpUrl, captureOrigin, capturedHeaders);

    expect([...scoped.keys()]).toHaveLength(0);
  });

  it("handles paths and queries correctly (origin-only comparison)", () => {
    const withQuery = "https://cdn.example.com/different/path/seg.ts?key=value";
    const scoped = scopedHeadersFor(withQuery, captureOrigin, capturedHeaders);

    // Still same origin despite different path/query.
    expect(scoped.get("authorization")).toBe("Bearer secret-token");
  });
});

describe("scopedHeadersFor — cross-origin audio integration", () => {
  it("correctly scopes headers when audio manifest is on a different CDN", () => {
    const videoOrigin = "https://video-cdn.example.com";
    const audioSegmentUrl = "https://audio-cdn.example.net/audio/seg-0.ts";

    const headers = new Headers({ Authorization: "Bearer video-token" });
    const scoped = scopedHeadersFor(audioSegmentUrl, videoOrigin, headers);

    // Audio CDN is cross-origin from video capture origin → empty headers.
    expect(scoped.get("authorization")).toBeNull();
  });

  it("preserves headers when both video and audio are on the same capture origin", () => {
    const captureOrigin = "https://cdn.example.com";
    const audioSegmentUrl = "https://cdn.example.com/audio/seg-0.ts";

    const headers = new Headers({ Authorization: "Bearer shared-token" });
    const scoped = scopedHeadersFor(audioSegmentUrl, captureOrigin, headers);

    // Same origin → headers preserved.
    expect(scoped.get("authorization")).toBe("Bearer shared-token");
  });
});
