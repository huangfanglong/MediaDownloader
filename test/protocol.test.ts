import { describe, expect, it } from "vitest";
import {
  Channel,
  WORKER_SERVICE_CHANNEL,
  cyrb53,
  injectedHrefChannel,
} from "../src/protocol/channels.js";
import { decode, encode, structured } from "../src/protocol/serde.js";
import { none, some, ok, err } from "../src/core/option.js";

/**
 * Independent transcription of the original's hash algorithm, kept in the test as a second oracle
 * so the rebuilt implementation is checked against something other than itself.
 *
 * The second seed is the artifact's constant 1103547991 (0x41C6CE57), NOT the published cyrb53
 * value 0x41C64E6D. Cross-checked against artifact literals in the embedded default ruleset:
 * `behaviour_hash_2168192316009402` (BLOCK_MEDIA_DETECTION) and
 * `experiment_hash_1986546207779496` (ALLOW_BRAVE_YT_DL).
 */
function canonicalCyrb53(input: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Vectors produced by the canonical algorithm; they pin the wire contract if the implementation
// is ever "cleaned up" into incompatible territory. The first two are independently corroborated:
// "hello" matches the detection evidence's be() fixture, ALLOW_BRAVE_YT_DL matches a ruleset
// literal recovered in the messaging evidence.
const CYRB53_VECTORS: Array<[string, number]> = [
  ["hello", 4625896200565286],
  ["ALLOW_BRAVE_YT_DL", 1986546207779496],
  ["", 3338908027751811],
  ["a", 7929297801672961],
  ["https://www.youtube.com/watch?v=abc123", 7725822338635421],
  ["http://localhost:8080/", 318676438322802],
  ["https://example.com/movie.m3u8?x=1", 6691518674872229],
  ["https://www.bilibili.com/video/BV1xx411c7mD?p=1", 2094678233989109],
];

describe("channel contract (proven from the shipped bundle)", () => {
  it("exposes exactly the nine channel ids used by every context", () => {
    expect(Channel).toEqual({
      FromInjectedToService: 0,
      FromContentToService: 1,
      FromServiceToWorker: 2,
      FromWorkerToService: 3,
      FromUntrustedInjectedToTrusted: 4,
      FromTrustedInjectedToUntrusted: 5,
      FromServiceToContent: 6,
      FromServiceToInjected: 7,
      FromServiceToService: 8,
    });
  });

  it("names the shared worker BroadcastChannel worker_service", () => {
    expect(WORKER_SERVICE_CHANNEL).toBe("worker_service");
  });

  it("derives per-page injected channel names as injected-<cyrb53(href)>", () => {
    expect(injectedHrefChannel("https://example.com/movie.m3u8?x=1")).toBe(
      "injected-6691518674872229",
    );
  });
});

describe("cyrb53 parity", () => {
  it.each(CYRB53_VECTORS)("hashes %j", (input, expected) => {
    expect(cyrb53(input)).toBe(expected);
    expect(cyrb53(input)).toBe(canonicalCyrb53(input));
  });

  it("splits into 53 bits that survive JSON", () => {
    for (const [input] of CYRB53_VECTORS) {
      const value = cyrb53(input);
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(JSON.parse(JSON.stringify(value))).toBe(value);
    }
  });
});

describe("wire serde (tagged values crossing extension contexts)", () => {
  it("encodes primitives as {primitive, val}", () => {
    expect(encode("x")).toEqual({ __serde_tag: "primitive", __serde_val: "x" });
    expect(encode(7)).toEqual({ __serde_tag: "primitive", __serde_val: 7 });
    expect(encode(false)).toEqual({ __serde_tag: "primitive", __serde_val: false });
    expect(encode(null)).toEqual({ __serde_tag: "primitive", __serde_val: null });
  });

  it("encodes URLs by href so structured clone keeps them URLs", () => {
    expect(encode(new URL("https://cdn.example/a.m3u8"))).toEqual({
      __serde_tag: "url",
      __serde_val: "https://cdn.example/a.m3u8",
    });
  });

  it("encodes Headers as entry pairs (Headers iteration order is normalised)", () => {
    const headers = new Headers([
      ["referer", "https://example.com/"],
      ["origin", "https://example.com"],
    ]);
    expect(encode(headers)).toEqual({
      __serde_tag: "headers",
      __serde_val: [
        ["origin", "https://example.com"],
        ["referer", "https://example.com/"],
      ],
    });
  });

  it("encodes Set, Map, RegExp, Option and Result with their own tags", () => {
    expect(encode(new Set(["a"]))).toEqual({
      __serde_tag: "set",
      __serde_val: [{ __serde_tag: "primitive", __serde_val: "a" }],
    });
    expect(encode(new Map([["k", 1]]))).toEqual({
      __serde_tag: "map",
      __serde_val: [
        [
          { __serde_tag: "primitive", __serde_val: "k" },
          { __serde_tag: "primitive", __serde_val: 1 },
        ],
      ],
    });
    expect(encode(/ab+c/gi)).toEqual({ __serde_tag: "regex", __serde_val: ["ab+c", "gi"] });
    expect(encode(some("t"))).toEqual({
      __serde_tag: "some",
      __serde_val: { __serde_tag: "primitive", __serde_val: "t" },
    });
    expect(encode(none)).toEqual({ __serde_tag: "none" });
    expect(encode(ok(1))).toEqual({
      __serde_tag: "ok",
      __serde_val: { __serde_tag: "primitive", __serde_val: 1 },
    });
    expect(encode(err("bad"))).toEqual({
      __serde_tag: "err",
      __serde_val: { __serde_tag: "primitive", __serde_val: "bad" },
    });
  });

  it("encodes plain objects recursively", () => {
    expect(encode({ a: [1, { b: true }] })).toEqual({
      __serde_tag: "object",
      __serde_val: {
        a: {
          __serde_tag: "array",
          __serde_val: [
            { __serde_tag: "primitive", __serde_val: 1 },
            {
              __serde_tag: "object",
              __serde_val: { b: { __serde_tag: "primitive", __serde_val: true } },
            },
          ],
        },
      },
    });
  });

  it("decodes back to the original runtime types", () => {
    const url = new URL("https://cdn.example/v.mp4");
    const result = decode(encode(url));
    expect(result).toBeInstanceOf(URL);
    expect((result as URL).href).toBe(url.href);

    const headers = decode(encode(new Headers({ cookie: "a=b" }))) as Headers;
    expect(headers.get("cookie")).toBe("a=b");

    const map = decode(encode(new Map<string, number>([["x", 2]]))) as Map<string, number>;
    expect(map.get("x")).toBe(2);

    expect(decode(encode(some(5)))).toEqual(some(5));
    expect(decode(encode(none))).toEqual(none);
    expect(decode(encode(/x/g))).toBeInstanceOf(RegExp);
  });

  it("round-trips a download-plan-shaped payload through structured clone", () => {
    const plan = {
      download_id: "download_1234",
      url: new URL("https://cdn.example/movie.m3u8"),
      url_audio: none,
      headers: new Headers({ referer: "https://example.com/" }),
      strategy: "m3u8_audio_video_one_source",
      extension: "mp4",
      subdir: "Downloads/",
      will_use_jsfetch: false,
      cache: some("reload"),
    };
    const roundTripped = structured(plan);
    expect(roundTripped).toEqual(plan);
    expect(roundTripped.url).toBeInstanceOf(URL);
    expect(roundTripped.headers).toBeInstanceOf(Headers);
    expect(roundTripped.cache).toEqual(some("reload"));
  });

  it("rejects unknown tags instead of guessing", () => {
    expect(() => decode({ __serde_tag: "mystery" })).toThrow(/Unknown serde tag/);
  });
});
