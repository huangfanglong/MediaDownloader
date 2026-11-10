/**
 * The service worker's fetch adapter must hand the browser the whole request: every `FetchInitLike`
 * field a caller sets has to survive it. The manifest collector relies on `redirect: "error"` to
 * refuse redirect-following, so a field picker here would convert a deliberate safety gate into a
 * followed redirect — and do the same to every field a future caller begins to use.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAdapter } from "../src/extension/fetch-adapter.js";
import type { FetchInitLike } from "../src/transfer/fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("service worker fetch adapter", () => {
  it("hands the platform fetch every init field, including the redirect gate", async () => {
    const platformFetch = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("payload"),
    );
    vi.stubGlobal("fetch", platformFetch);

    const signal = new AbortController().signal;
    const headers = new Headers({ referer: "https://site.test/watch" });
    const init: FetchInitLike = {
      headers,
      signal,
      cache: "no-cache",
      redirect: "error",
    };
    await fetchAdapter("https://cdn.test/manifest.m3u8", init);

    expect(platformFetch).toHaveBeenCalledTimes(1);
    const [url, requestInit] = platformFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cdn.test/manifest.m3u8");
    expect(requestInit.redirect).toBe("error");
    expect(requestInit.cache).toBe("no-cache");
    expect(requestInit.signal).toBe(signal);
    expect(new Headers(requestInit.headers).get("referer")).toBe("https://site.test/watch");
  });

  it("still forwards a plain headerless request", async () => {
    const platformFetch = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response("payload"),
    );
    vi.stubGlobal("fetch", platformFetch);

    await fetchAdapter("https://cdn.test/file.mp4");
    expect(platformFetch.mock.calls[0]?.[0]).toBe("https://cdn.test/file.mp4");
    expect(platformFetch.mock.calls[0]?.[1]).toBeUndefined();
  });
});
