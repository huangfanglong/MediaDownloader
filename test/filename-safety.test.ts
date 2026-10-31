import { describe, expect, it } from "vitest";
import { renderBasename } from "../src/naming/render.js";
import { EMPTY_NAME } from "../src/naming/sanitize.js";
import { isSafePathComponent, normalizeSubdir, repairBasename, repairPathComponent } from "../src/naming/safe-path.js";
import { composeFilename } from "../src/transfer/save.js";

const baseRule = {
  template: "%title",
  selector: null,
  max_length: 64,
  replace: [],
  subdir: "",
  force_doc_title: false,
};

describe("isSafePathComponent — Chrome's portable download-name rules", () => {
  it.each([
    "CON",
    "con",
    "NUL",
    "NUL.zip",
    "aux",
    "PRN",
    "COM1",
    "COM9",
    "LPT1",
    "LPT9",
    "CON.2024",
    "nul.tar.gz",
  ])("rejects the reserved device name %j, with or without an extension", (name) => {
    expect(isSafePathComponent(name)).toBe(false);
  });

  it.each([
    "COM0",
    "COM10",
    "CONIN",
    "_CON",
    "CON-file",
    "normal",
    "media-CON",
    "name..mp4",
    "Wait for it",
  ])("accepts %j, which is not reserved", (name) => {
    expect(isSafePathComponent(name)).toBe(true);
  });

  it.each([
    "",
    " ",
    "\t",
    ".",
    "..",
    ".hidden",
    "name.",
    "name. ",
    "name ",
    "a/b",
    "a\\b",
    "a:b",
    "a?b",
    "a*b",
    "a<b",
    "a>b",
    'a"b',
    "a|b",
    "a\u0000b",
  ])("rejects the unsafe component %j", (name) => {
    expect(isSafePathComponent(name)).toBe(false);
  });

  it("accepts ordinary titles with internal dots and non-ASCII text", () => {
    expect(isSafePathComponent("Episode 1..2 (final)")).toBe(true);
    expect(isSafePathComponent("日本語 動画")).toBe(true);
    expect(isSafePathComponent("a-b_c")).toBe(true);
  });
});

describe("repairPathComponent", () => {
  it.each([
    ["CON", "_CON"],
    ["nul.zip", "_nul.zip"],
    ["LPT9", "_LPT9"],
    ["CON.2024", "_CON.2024"],
    ["name.", "name"],
    ["name. ", "name"],
    ["name..", "name"],
    [".hidden", "hidden"],
    ["a:b", "ab"],
    ["COM0", "COM0"],
    ["normal", "normal"],
    ["Episode 1..2", "Episode 1..2"],
    ["", EMPTY_NAME],
    ["**", EMPTY_NAME],
  ])("repairs %j to %j", (input, expected) => {
    expect(repairPathComponent(input)).toBe(expected);
  });

  it("is idempotent", () => {
    expect(repairPathComponent(repairPathComponent("CON"))).toBe("_CON");
  });
});

describe("repairBasename (extension is appended afterwards)", () => {
  it.each([
    ["CON", "_CON"],
    ["nul.zip", "_nul.zip"],
    ["LPT9", "_LPT9"],
    ["CON.2024", "_CON.2024"],
    ["COM0", "COM0"],
    ["normal", "normal"],
    ["Episode 1..2", "Episode 1..2"],
    ["Wait for it...", "Wait for it..."],
    ["", EMPTY_NAME],
    ["**", EMPTY_NAME],
  ])("repairs %j to %j", (input, expected) => {
    expect(repairBasename(input)).toBe(expected);
  });
});

describe("normalizeSubdir", () => {
  it.each([
    ["", ""],
    ["Downloads/", "Downloads/"],
    ["CON/Clips", "_CON/Clips/"],
    ["foo./bar", "foo/bar/"],
    ["nul/", "_nul/"],
    ["/Media//Clips/", "Media/Clips/"],
    ["media\\clips", "media/clips/"],
    ["  /  ", ""],
    ["COM0/", "COM0/"],
  ])("normalises %j to %j", (input, expected) => {
    expect(normalizeSubdir(input)).toBe(expected);
  });
});

describe("rendered basenames stay inside Chrome's rules", () => {
  it("repairs a media title that is a reserved device name", () => {
    const rendered = renderBasename({ title: "CON" }, {}, baseRule);
    expect(rendered.basename).toBe("_CON");
    expect(composeFilename({ subdir: "", good_basename: rendered.basename, extension: "mp4" })).toBe("_CON.mp4");
    expect(isSafePathComponent("_CON.mp4")).toBe(true);
  });

  it("repairs reserved names created by max_length truncation", () => {
    const rendered = renderBasename({}, {}, { ...baseRule, template: "CONference", max_length: 3 });
    expect(rendered.basename).toBe("_CON");
  });

  it("repairs reserved names created by replace rules", () => {
    const rendered = renderBasename(
      {},
      {},
      { ...baseRule, template: "foo", replace: [{ from: "foo", to: "CON" }] },
    );
    expect(rendered.basename).toBe("_CON");
  });

  it("keeps a title ending in an ellipsis, and the appended extension makes it accepted", () => {
    const rendered = renderBasename({ title: "Wait for it..." }, {}, baseRule);
    expect(rendered.basename).toBe("Wait for it...");
    const composed = composeFilename({ subdir: "", good_basename: rendered.basename, extension: "mp4" });
    expect(composed).toBe("Wait for it....mp4");
    expect(isSafePathComponent(composed)).toBe(true);
  });

  it("leaves ordinary titles alone", () => {
    expect(renderBasename({ title: "Example Video" }, {}, baseRule).basename).toBe("Example Video");
    expect(renderBasename({ title: "COM0" }, {}, baseRule).basename).toBe("COM0");
  });
});
