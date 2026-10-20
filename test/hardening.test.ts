import { describe, expect, it } from "vitest";
import { decode } from "../src/protocol/serde.js";
import { fetchBytes, sanitizeReplayHeaders } from "../src/transfer/fetch.js";
import { MAX_HLS_LINES, MAX_HLS_SEGMENTS, parsePlaylist } from "../src/manifests/hls.js";
import {
  normalizeHeaderReplayUrl,
  redactSessionForStorage,
  validateDownloadPlan,
} from "../src/extension/service-worker.js";
import type { DownloadPlan } from "../src/core/types.js";

describe("serde decoder limits (review 1.3)", () => {
  it("rejects deeply nested payloads instead of overflowing the stack", () => {
    let payload: unknown = { __serde_tag: "primitive", __serde_val: 1 };
    for (let index = 0; index < 64; index += 1) {
      payload = { __serde_tag: "array", __serde_val: [payload] };
    }
    expect(() => decode(payload)).toThrow(/depth/);
  });

  it("rejects prototype-polluting keys", () => {
    const hostile = JSON.parse('{"__serde_tag":"object","__serde_val":{"__proto__":{"polluted":true}}}');
    expect(() => decode(hostile)).toThrow(/unsafe key/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("enforces a node budget", () => {
    const wide = { __serde_tag: "array", __serde_val: Array.from({ length: 50 }, () => ({ __serde_tag: "primitive", __serde_val: 1 })) };
    expect(() => decode(wide, { maxNodes: 10 })).toThrow(/node count/);
  });
});

describe("response and manifest limits (review 3.1)", () => {
  it("aborts oversized response bodies", async () => {
    const body = new TextEncoder().encode("x".repeat(5000));
    let sent = false;
    const fetchImpl = (async () => ({
      status: 200,
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: body };
          },
        }),
      },
    })) as never;
    const result = await fetchBytes(fetchImpl, "https://cdn.test/big.m3u8", {}, { maxBytes: 100 });
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error.message).toMatch(/exceeds/);
  });

  it("rejects absurdly large HLS manifests", () => {
    const parsed = parsePlaylist("x".repeat(8 * 1024 * 1024 + 1), new URL("https://cdn.test/a.m3u8"));
    expect(parsed.kind).toBe("invalid");
  });

  it("caps segment counts on hostile playlists", () => {
    const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:2"];
    for (let index = 0; index < MAX_HLS_SEGMENTS + 500; index += 1) {
      lines.push("#EXTINF:1,", "seg.ts");
    }
    const parsed = parsePlaylist(lines.join("\n"), new URL("https://cdn.test/a.m3u8"));
    expect(parsed.kind).toBe("media");
    if (parsed.kind === "media") expect(parsed.segments.length).toBeLessThanOrEqual(MAX_HLS_SEGMENTS);
    expect(MAX_HLS_LINES).toBeGreaterThan(1000);
  });
});

describe("header replay sanitisation (review 1.2)", () => {
  it("keeps only safe, well-formed headers", () => {
    const sanitized = sanitizeReplayHeaders({
      cookie: "a=b",
      referer: "https://www.youtube.com/watch?v=1",
      "x-evil": "value",
      "bad name": "value",
      "sec-fetch-site": "same-site",
      "x-long": "y".repeat(5000),
    });
    expect(sanitized.get("cookie")).toBe("a=b");
    expect(sanitized.get("referer")).toContain("youtube.com");
    expect(sanitized.get("sec-fetch-site")).toBe("same-site");
    expect(sanitized.get("x-evil")).toBeNull();
    expect(sanitized.get("x-long")).toBeNull();
  });
});

describe("download plan validation (review 3.3)", () => {
  const base: DownloadPlan = {
    download_id: "d1",
    headers: new Headers(),
    good_basename: "ok",
    subdir: "",
    save_as: false,
    will_use_jsfetch: false,
    strategy: "http_audio_video_one_source",
    url: new URL("https://cdn.test/a.mp4"),
    carry_get_params: false,
    extension: "mp4",
    muxer: "mp4",
    is_youtube: false,
    throttle: false,
    cache: "default",
  };

  it("accepts a normal plan", () => {
    expect(validateDownloadPlan(base)).toBeUndefined();
  });

  it("rejects non-http URLs, path traversal and odd extensions", () => {
    expect(validateDownloadPlan({ ...base, url: new URL("data:text/plain,x") })).toMatch(/scheme/);
    expect(validateDownloadPlan({ ...base, subdir: "../../etc/" })).toMatch(/directory/);
    expect(validateDownloadPlan({ ...base, extension: "exe" })).toMatch(/extension/);
  });
});

describe("header replay scoping (review round 2, critical)", () => {
  it("scopes asset keys by host so two origins cannot share captured credentials", () => {
    const first = normalizeHeaderReplayUrl("https://rr1.googlevideo.com/videoplayback?id=abc&itag=18&range=0-10");
    const second = normalizeHeaderReplayUrl("https://evil.example/videoplayback?id=abc&itag=18");
    expect(first.assetKey).not.toBe(second.assetKey);
    expect(first.assetKey).toContain("rr1.googlevideo.com");
    expect(second.assetKey).toContain("evil.example");
  });
});

describe("session persistence redaction (review round 2, privacy)", () => {
  it("strips credential headers before session storage", () => {
    const session = {
      current_win_tab: {},
      discovered: new Map([
        [
          1,
          {
            media: new Map([
              [
                "h",
                {
                  type: "http_playlist",
                  hash: "h",
                  is_youtube: true,
                  sent_headers: new Headers({ cookie: "a=b", referer: "https://youtube.com/" }),
                  discovery_timestamp_ms: 1,
                  cache: "default",
                },
              ],
            ]),
          },
        ],
      ]),
      downloading: new Map([
        [
          "d",
          {
            bitrate: 0,
            status: "queued",
            download_args: {
              download_id: "d",
              headers: new Headers({ cookie: "a=b", referer: "https://youtube.com/" }),
              good_basename: "x",
              subdir: "",
              save_as: false,
              will_use_jsfetch: false,
              strategy: "http_audio_video_one_source",
              url: new URL("https://cdn.test/a.mp4"),
              carry_get_params: false,
              extension: "mp4",
              muxer: "mp4",
              is_youtube: true,
              throttle: false,
              cache: "default",
            },
            media: {
              type: "http_playlist",
              hash: "h",
              is_youtube: true,
              sent_headers: new Headers({ cookie: "a=b" }),
              discovery_timestamp_ms: 1,
              cache: "default",
            },
            meta: {
              incognito: false,
              tab_id: 1,
              default_action: "download",
              smartnaming_rule: {
                template: "%title",
                selector: null,
                max_length: 64,
                replace: [],
                subdir: "",
                force_doc_title: false,
              },
            },
          },
        ],
      ]),
      notifications: new Map(),
      transient_history: [],
    };
    const redacted = redactSessionForStorage(session as never);
    expect(redacted.discovered.get(1)?.media.get("h")?.sent_headers.get("cookie")).toBeNull();
    expect(redacted.discovered.get(1)?.media.get("h")?.sent_headers.get("referer")).toContain("youtube");
    expect(redacted.downloading.get("d")?.download_args.headers.get("cookie")).toBeNull();
  });
});

describe("extra decoder limits (review round 2)", () => {
  it("rejects oversized string payloads", () => {
    const payload = { __serde_tag: "primitive", __serde_val: "x".repeat(64) };
    expect(() => decode(payload, { maxStringLength: 16 })).toThrow(/string payload/);
  });

  it("rejects oversized collections", () => {
    const payload = { __serde_tag: "array", __serde_val: Array.from({ length: 20 }, () => ({ __serde_tag: "primitive", __serde_val: 1 })) };
    expect(() => decode(payload, { maxCollectionLength: 5 })).toThrow(/collection too large/);
  });
});

describe("plan filename validation (review round 2)", () => {
  it("rejects separators and traversal in the basename", () => {
    const plan = {
      download_id: "d",
      headers: new Headers(),
      good_basename: "a/b",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "http_audio_video_one_source",
      url: new URL("https://cdn.test/a.mp4"),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    };
    expect(validateDownloadPlan(plan as never)).toMatch(/filename/);
  });
});

