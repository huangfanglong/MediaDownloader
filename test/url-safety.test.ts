import { describe, expect, it } from "vitest";
import {
  isPrivateNetworkHost,
  isSafeManifestUrl,
  manifestEnrichmentAllowed,
  observedRequestKey,
} from "../src/transfer/url-safety.js";

describe("manifest URL safety", () => {
  it("rejects loopback, private, link-local and local names", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "printer.local",
      "router.internal",
      "127.0.0.1",
      "127.10.20.30",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "198.18.0.1",
      "0.0.0.0",
      "[::1]",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
    ]) {
      expect(isPrivateNetworkHost(host), host).toBe(true);
    }
  });


  it("blocks IPv4-mapped IPv6 in canonical hex and dotted forms", () => {
    for (const host of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "::ffff:192.168.0.1",
      "::ffff:c0a8:1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
    ]) {
      expect(isPrivateNetworkHost(host), host).toBe(true);
    }
    for (const host of ["::ffff:8.8.8.8", "::ffff:808:808", "2606:4700:4700::1111"]) {
      expect(isPrivateNetworkHost(host), host).toBe(false);
    }
    // URL.hostname canonicalizes dotted mapped IPv4 into hex groups.
    expect(isPrivateNetworkHost(new URL("http://[::ffff:127.0.0.1]/").hostname)).toBe(true);
  });
  it("allows ordinary public hosts", () => {
    for (const host of ["cdn.example", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(isPrivateNetworkHost(host), host).toBe(false);
    }
  });

  it("requires HTTPS/HTTP and a non-private host for manifests", () => {
    expect(isSafeManifestUrl(new URL("https://cdn.example/master.m3u8"))).toBe(true);
    expect(isSafeManifestUrl(new URL("http://10.0.0.1/master.m3u8"))).toBe(false);
    expect(isSafeManifestUrl(new URL("file:///etc/passwd"))).toBe(false);
  });

  it("auto-fetches unobserved manifests only when same-origin with the page", () => {
    const manifest = new URL("https://cdn.example/master.m3u8");
    const page = new URL("https://site.example/watch");
    expect(manifestEnrichmentAllowed(manifest, page, false)).toBe(false);
    expect(manifestEnrichmentAllowed(manifest, page, true)).toBe(true);
    expect(manifestEnrichmentAllowed(manifest, new URL("https://cdn.example/page"), false)).toBe(true);
    expect(manifestEnrichmentAllowed(new URL("http://127.0.0.1/a.m3u8"), page, true)).toBe(false);
  });

  it("normalizes observed request keys by origin+pathname", () => {
    expect(observedRequestKey(new URL("https://cdn.example/a/b.m3u8?token=1#x"))).toBe(
      "https://cdn.example/a/b.m3u8",
    );
  });
});
