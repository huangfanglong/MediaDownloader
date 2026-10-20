import { describe, expect, it } from "vitest";
import { normalizeHeaderReplayUrl } from "../src/extension/service-worker.js";

describe("header replay URL binding", () => {
  it("keeps scheme and pathname in the asset alias (no cross-context collisions)", () => {
    const https = normalizeHeaderReplayUrl("https://cdn.example/v/asset?id=abc&itag=18&range=0-1");
    const http = normalizeHeaderReplayUrl("http://cdn.example/v/asset?id=abc&itag=18");
    const otherPath = normalizeHeaderReplayUrl("https://cdn.example/other/asset?id=abc&itag=18");
    expect(https.assetKey).toBe("https://cdn.example/v/asset|abc|18");
    expect(http.assetKey).toBe("http://cdn.example/v/asset|abc|18");
    expect(otherPath.assetKey).toBe("https://cdn.example/other/asset|abc|18");
    expect(https.scheme).toBe("https:");
    expect(http.scheme).toBe("http:");
    expect(new Set([https.assetKey, http.assetKey, otherPath.assetKey]).size).toBe(3);
  });

  it("normalizes volatile range params while preserving the literal scheme/path", () => {
    const a = normalizeHeaderReplayUrl("https://cdn.example/v/asset?id=abc&itag=18&range=0-1000&c=WEB");
    const b = normalizeHeaderReplayUrl("https://cdn.example/v/asset?id=abc&itag=18");
    expect(a.href).toBe(b.href);
    expect(a.scheme).toBe("https:");
  });
});
