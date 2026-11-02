import { describe, expect, it } from "vitest";
import type { DownloadPlan } from "../src/core/types.js";
import { HeaderReplay, normalizeHeaderReplayUrl } from "../src/extension/header-replay.js";
import type { NetworkGateway } from "../src/extension/gateways.js";

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

  it("accepts an already parsed URL without mutating it", () => {
    const input = new URL("https://cdn.example/v/asset?id=abc&itag=18&range=0-1000");
    const normalized = normalizeHeaderReplayUrl(input);
    expect(normalized.href).not.toContain("range=");
    expect(normalized.assetKey).toBe("https://cdn.example/v/asset|abc|18");
    // The caller's URL (a plan URL, for instance) must keep its query untouched.
    expect(input.searchParams.get("range")).toBe("0-1000");
    expect(normalizeHeaderReplayUrl(input.href).href).toBe(normalized.href);
  });
});

describe("header replay cache maintenance", () => {
  const replayTtlMs = 10 * 60 * 1000;
  const ruleCalls: unknown[] = [];

  const fakeNetwork = (): NetworkGateway =>
    ({
      updateSessionRules: async (options: unknown) => {
        ruleCalls.push(options);
      },
      getSessionRules: async () => [],
    }) as unknown as NetworkGateway;

  const plan = (url: string): DownloadPlan =>
    ({
      download_id: "d1",
      headers: new Headers(),
      good_basename: "clip",
      subdir: "",
      save_as: false,
      will_use_jsfetch: false,
      strategy: "http_audio_video_one_source",
      url: new URL(url),
      carry_get_params: false,
      extension: "mp4",
      muxer: "mp4",
      is_youtube: false,
      throttle: false,
      cache: "default",
    }) as DownloadPlan;

  it("does not replay captures older than the TTL", async () => {
    let clock = 0;
    ruleCalls.length = 0;
    const replay = new HeaderReplay(fakeNetwork(), () => clock);
    replay.remember("https://cdn.example/v/asset?id=abc&itag=18", [{ name: "referer", value: "https://page.test/" }], {
      tabId: 7,
    });
    expect(await replay.apply(plan("https://cdn.example/v/asset?id=abc&itag=18"), { tabId: 7 })).toHaveLength(1);

    // Long after the TTL, a new request sweeps the expired entry instead of replaying it.
    clock = replayTtlMs + 60_000;
    replay.remember("https://cdn.example/other.mp4", [{ name: "referer", value: "https://page.test/" }], { tabId: 7 });
    expect(await replay.apply(plan("https://cdn.example/v/asset?id=abc&itag=18"), { tabId: 7 })).toEqual([]);
  });

  it("keeps the capture cache bounded", async () => {
    let clock = 0;
    ruleCalls.length = 0;
    const replay = new HeaderReplay(fakeNetwork(), () => clock);
    for (let index = 0; index < 400; index += 1) {
      replay.remember(
        `https://cdn.example/v/item-${index}.mp4`,
        [{ name: "referer", value: "https://page.test/" }],
        { tabId: 7 },
      );
      clock += 1;
    }
    // The oldest captures were evicted; the newest are still replayable.
    expect(await replay.apply(plan("https://cdn.example/v/item-0.mp4"), { tabId: 7 })).toEqual([]);
    expect(await replay.apply(plan("https://cdn.example/v/item-399.mp4"), { tabId: 7 })).toHaveLength(1);
  });

  it("still builds a replay rule for a fresh capture", async () => {
    ruleCalls.length = 0;
    const replay = new HeaderReplay(fakeNetwork(), () => 0);
    replay.remember("https://cdn.example/v/asset?id=abc&itag=18", [{ name: "referer", value: "https://page.test/" }], {
      tabId: 7,
    });
    const ruleIds = await replay.apply(plan("https://cdn.example/v/asset?id=abc&itag=18"), { tabId: 7 });
    expect(ruleIds).toHaveLength(1);
    const call = ruleCalls[0] as { addRules: unknown[] };
    expect(call.addRules).toHaveLength(1);
  });
});
