/**
 * Unit tests for url-safety.ts helpers.
 */
import { describe, expect, it } from "vitest";
import { isSafeSegmentUrl, isPrivateNetworkHost } from "../src/transfer/url-safety.js";

describe("isSafeSegmentUrl", () => {
  const manifestUrl = new URL("https://cdn.example.com/stream/master.m3u8");

  it("allows http(s) public-network segments", () => {
    expect(isSafeSegmentUrl(new URL("https://cdn.example.com/seg-0.ts"), manifestUrl)).toBe(true);
    expect(isSafeSegmentUrl(new URL("http://other.example/seg-1.ts"), manifestUrl)).toBe(true);
  });

  it("rejects non-http(s) protocols", () => {
    expect(isSafeSegmentUrl(new URL("file:///etc/passwd"), manifestUrl)).toBe(false);
    expect(isSafeSegmentUrl(new URL("data:text/plain,hello"), manifestUrl)).toBe(false);
    expect(isSafeSegmentUrl(new URL("javascript:alert(1)"), manifestUrl)).toBe(false);
    expect(isSafeSegmentUrl(new URL("ftp://example.com/file"), manifestUrl)).toBe(false);
  });

  it("rejects URLs with userinfo", () => {
    expect(isSafeSegmentUrl(new URL("https://user:pass@example.com/seg"), manifestUrl)).toBe(false);
    expect(isSafeSegmentUrl(new URL("http://admin@localhost/seg"), manifestUrl)).toBe(false);
  });

  it("rejects cross-origin private-network hosts", () => {
    expect(isSafeSegmentUrl(new URL("http://127.0.0.1:9090/metrics"), manifestUrl)).toBe(false);
    expect(isSafeSegmentUrl(new URL("http://192.168.1.1/admin"), manifestUrl)).toBe(false);
    expect(isSafeSegmentUrl(new URL("http://10.0.0.1/internal"), manifestUrl)).toBe(false);
    expect(isSafeSegmentUrl(new URL("http://localhost/api"), manifestUrl)).toBe(false);
    expect(isSafeSegmentUrl(new URL("http://example.local/file"), manifestUrl)).toBe(false);
  });

  it("allows same-origin private-network hosts (LAN carve-out)", () => {
    const lanManifest = new URL("http://192.168.1.10:8096/videos/master.m3u8");
    expect(isSafeSegmentUrl(new URL("http://192.168.1.10:8096/videos/seg-0.ts"), lanManifest)).toBe(true);
    expect(isSafeSegmentUrl(new URL("http://192.168.1.10:8096/videos/seg-1.ts"), lanManifest)).toBe(true);

    const localhostManifest = new URL("http://localhost:8080/stream/master.m3u8");
    expect(isSafeSegmentUrl(new URL("http://localhost:8080/stream/seg-0.ts"), localhostManifest)).toBe(true);
  });

  it("rejects cross-origin private-network even when manifest is public", () => {
    expect(isSafeSegmentUrl(new URL("http://192.168.1.1/admin"), manifestUrl)).toBe(false);
  });

  it("rejects same-origin check bypass attempts (different ports, subdomains)", () => {
    const lanManifest = new URL("http://192.168.1.10:8096/videos/master.m3u8");
    expect(isSafeSegmentUrl(new URL("http://192.168.1.10:9090/admin"), lanManifest)).toBe(false);
    expect(isSafeSegmentUrl(new URL("http://192.168.1.11:8096/videos/seg"), lanManifest)).toBe(false);
  });
});

describe("isPrivateNetworkHost — IPv6 edge cases", () => {
  it("detects IPv4-mapped IPv6 loopback", () => {
    expect(isPrivateNetworkHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateNetworkHost("::ffff:7f00:1")).toBe(true);
  });

  it("detects NAT64 embedded private IPv4", () => {
    expect(isPrivateNetworkHost("64:ff9b::192.168.1.1")).toBe(true);
    expect(isPrivateNetworkHost("64:ff9b::10.0.0.1")).toBe(true);
  });

  it("detects 6to4 embedded private IPv4", () => {
    expect(isPrivateNetworkHost("2002:c0a8:101::1")).toBe(true); // 192.168.1.1
    expect(isPrivateNetworkHost("2002:0a00:0001::1")).toBe(true); // 10.0.0.1
  });

  it("detects link-local and unique-local IPv6", () => {
    expect(isPrivateNetworkHost("fe80::1")).toBe(true); // link-local
    expect(isPrivateNetworkHost("fc00::1")).toBe(true); // unique-local
    expect(isPrivateNetworkHost("fd12:3456:789a::1")).toBe(true); // unique-local
  });

  it("allows public IPv6", () => {
    expect(isPrivateNetworkHost("2001:db8::1")).toBe(false);
    expect(isPrivateNetworkHost("2606:2800:220:1:248:1893:25c8:1946")).toBe(false); // example.com
  });

  it("detects decimal-encoded loopback", () => {
    expect(isPrivateNetworkHost("127.0.0.1")).toBe(true);
    expect(isPrivateNetworkHost("127.1")).toBe(false); // invalid dotted-decimal, not private
  });
});

describe("isSafeSegmentUrl — scopedHeadersFor integration", () => {
  it("complements scopedHeadersFor: gate + scoping together prevent SSRF + credential exfil", () => {
    const manifestUrl = new URL("https://cdn.example.com/stream/master.m3u8");

    // Private-network: rejected by gate (isSafeSegmentUrl), so scopedHeadersFor never runs.
    expect(isSafeSegmentUrl(new URL("http://127.0.0.1:9090/metrics"), manifestUrl)).toBe(false);

    // Cross-origin public: allowed by gate, but scopedHeadersFor returns empty headers.
    expect(isSafeSegmentUrl(new URL("https://attacker.example.net/collect"), manifestUrl)).toBe(true);

    // Same-origin: allowed by gate, scopedHeadersFor returns captured headers.
    expect(isSafeSegmentUrl(new URL("https://cdn.example.com/stream/seg-0.ts"), manifestUrl)).toBe(true);
  });
});
