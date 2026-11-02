import { describe, expect, it } from "vitest";
import { MEDIA_SELECTION_CAP, MediaSelections } from "../src/extension/panel-state.js";

describe("panel per-media selections", () => {
  it("merges control changes into one entry", () => {
    const selections = new MediaSelections();
    expect(selections.get("h1")).toBeUndefined();
    selections.save("h1", { quality: "2" });
    expect(selections.get("h1")).toEqual({ quality: "2", format: "", source: "" });
    selections.save("h1", { format: "mkv" });
    expect(selections.get("h1")).toEqual({ quality: "2", format: "mkv", source: "" });
    selections.save("h1", { source: "hls" });
    expect(selections.get("h1")).toEqual({ quality: "2", format: "mkv", source: "hls" });
  });

  it("stays bounded and evicts the least recently used media", () => {
    const selections = new MediaSelections();
    for (let index = 0; index <= MEDIA_SELECTION_CAP; index += 1) {
      selections.save(`h${index}`, { quality: String(index) });
    }
    expect(selections.size).toBe(MEDIA_SELECTION_CAP);
    // The oldest entry fell out; the newest is still there.
    expect(selections.get("h0")).toBeUndefined();
    expect(selections.get(`h${MEDIA_SELECTION_CAP}`)?.quality).toBe(String(MEDIA_SELECTION_CAP));

    // Reading an entry keeps it alive: saving another one evicts the still-untouched one instead.
    expect(selections.get("h1")?.quality).toBe("1");
    selections.save("fresh", { quality: "9" });
    expect(selections.size).toBe(MEDIA_SELECTION_CAP);
    expect(selections.get("h1")).toBeDefined();
    expect(selections.get("h2")).toBeUndefined();
  });
});
