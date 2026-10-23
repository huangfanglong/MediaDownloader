import { describe, expect, it, vi } from "vitest";
import { BoundedCache } from "../src/extension/bounded-cache.js";

describe("bounded cache", () => {
  it("expires entries and releases their resources", () => {
    let now = 1_000;
    const evict = vi.fn();
    const cache = new BoundedCache<string, string>(3, 30_000, evict, () => now);
    cache.set("clip", "blob:clip");

    now += 30_001;
    expect(cache.get("clip")).toBeUndefined();
    expect(evict).toHaveBeenCalledWith("blob:clip", "clip");
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry when full", () => {
    const evict = vi.fn();
    const cache = new BoundedCache<string, string>(2, 30_000, evict, () => 1_000);
    cache.set("first", "blob:first");
    cache.set("second", "blob:second");
    expect(cache.get("first")).toBe("blob:first");

    cache.set("third", "blob:third");

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe("blob:first");
    expect(cache.get("third")).toBe("blob:third");
    expect(evict).toHaveBeenCalledOnce();
    expect(evict).toHaveBeenCalledWith("blob:second", "second");
  });

  it("releases replaced and cleared entries exactly once", () => {
    const evict = vi.fn();
    const cache = new BoundedCache<string, string>(2, 30_000, evict, () => 1_000);
    cache.set("clip", "blob:old");
    cache.set("clip", "blob:new");
    cache.clear();
    cache.clear();

    expect(evict.mock.calls).toEqual([
      ["blob:old", "clip"],
      ["blob:new", "clip"],
    ]);
  });
});
