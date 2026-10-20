import { describe, expect, it } from "vitest";
import { EMPTY_NAME, SANITIZE_LIMIT, sanitizeName } from "../src/naming/sanitize.js";
import {
  DEFAULT_MAX_LENGTH,
  DEFAULT_TEMPLATE,
  compileSmartnaming,
  defaultSmartnaming,
  loadSmartnaming,
  materializeRule,
  selectRule,
  validateDirectory,
} from "../src/naming/rules.js";
import { hostnameLabel, renderBasename } from "../src/naming/render.js";

describe("sanitizeName parity (original `xt`)", () => {
  it.each([
    ["  hello world  ", "hello world"],
    ["a--b", "a-b"],
    ["-  -a", "a"],
    ["file.name.mp4", "file.name.mp4"],
    ["...hidden", "hidden"],
    ["a/b:c|d?e", "abcde"],
    ["日本語 動画", "日本語 動画"],
    ["a___b", "a___b"],
    ["", EMPTY_NAME],
    ["***", EMPTY_NAME],
    [".", EMPTY_NAME],
    ["\t\n", EMPTY_NAME],
  ])("sanitises %j to %j", (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });

  it("normalises to NFC so composed and decomposed accents match", () => {
    expect(sanitizeName("cafe\u0301")).toBe(sanitizeName("caf\u00e9"));
    expect(sanitizeName("caf\u00e9")).toBe("café");
  });

  it("cuts to the sanitiser limit and strips trailing separators afterwards", () => {
    const long = `${"a".repeat(SANITIZE_LIMIT - 1)}--b`;
    const result = sanitizeName(long);
    expect(result.length).toBeLessThanOrEqual(SANITIZE_LIMIT);
    expect(result.startsWith("a".repeat(SANITIZE_LIMIT - 1))).toBe(true);
  });

  it("drops a trailing dash that only appears after truncation", () => {
    const input = `${"a".repeat(SANITIZE_LIMIT - 1)}-b`;
    expect(sanitizeName(input).endsWith("-")).toBe(false);
  });
});

describe("download directory validation (original `Uv`)", () => {
  it.each([
    ["", ""],
    ["Videos", "Videos/"],
    ["/Videos", "Videos/"],
    ["Videos/", "Videos/"],
    ["/Videos/Movies/", "Videos/Movies/"],
    ["my folder", "my folder/"],
  ])("normalises %j to %j", (input, expected) => {
    expect(validateDirectory(input)).toEqual({ tag: "Ok", value: expected });
  });

  it("rejects segments with characters the sanitiser would change", () => {
    const result = validateDirectory("Videos/a:b");
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") {
      expect(result.error).toContain("This not a valid path");
    }
  });

  it("rejects a path whose segments are fine but whose total length is too long", () => {
    // Each segment survives the sanitiser; the joined path exceeds the 255-character limit.
    const result = validateDirectory(`${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(100)}`);
    expect(result).toEqual({ tag: "Err", error: "Path too long" });
  });

  it("rejects a single segment that the sanitiser would shorten", () => {
    const result = validateDirectory("x".repeat(256));
    expect(result.tag).toBe("Err");
    if (result.tag === "Err") expect(result.error).toContain("This not a valid path");
  });
});

describe("smart-naming rules file (original `np` / `jv`)", () => {
  it("ships the documented defaults", () => {
    expect(defaultSmartnaming()).toEqual({
      default_: { max_length: 64, template: "%title" },
      rules: [],
    });
    expect(DEFAULT_MAX_LENGTH).toBe(64);
    expect(DEFAULT_TEMPLATE).toBe("%title");
  });

  it("reports invalid JSON instead of throwing", () => {
    expect(compileSmartnaming("{ nope")).toEqual({ tag: "Err", error: "Invalid syntax" });
  });

  it("requires a valid default max_length and template", () => {
    expect(compileSmartnaming(JSON.stringify({ template: "%title" }))).toEqual({
      tag: "Err",
      error: "Default `max_length` value invalid or missing",
    });
    expect(compileSmartnaming(JSON.stringify({ max_length: 0, template: "%title" }))).toEqual({
      tag: "Err",
      error: "Default `max_length` value invalid or missing",
    });
    expect(compileSmartnaming(JSON.stringify({ max_length: 64 }))).toEqual({
      tag: "Err",
      error: "Default `template` value invalid or missing",
    });
  });

  it("compiles a defaults-only file", () => {
    expect(compileSmartnaming(JSON.stringify({ max_length: 80, template: "%title" }))).toEqual({
      tag: "Ok",
      value: { default_: { max_length: 80, template: "%title", force_doc_title: false }, rules: [] },
    });
  });

  it("validates rule entries with 1-based positions", () => {
    const noTemplate = compileSmartnaming(JSON.stringify({ max_length: 64, template: "%title", rule: [{}] }));
    expect(noTemplate.tag).toBe("Err");
    if (noTemplate.tag === "Err") expect(noTemplate.error).toBe('"template = …" is missing or invalid in rule 1');

    const noUrl = compileSmartnaming(
      JSON.stringify({ max_length: 64, template: "%title", rule: [{ template: "%title" }] }),
    );
    if (noUrl.tag === "Err") expect(noUrl.error).toBe('"url = …" is missing or invalid in rule 1');

    const badMax = compileSmartnaming(
      JSON.stringify({ max_length: 64, template: "%title", rule: [{ template: "t", url: "u", max_length: 0 }] }),
    );
    if (badMax.tag === "Err") expect(badMax.error).toBe('"max_length = …" invalid in rule 1');

    const badSelector = compileSmartnaming(
      JSON.stringify({ max_length: 64, template: "%title", rule: [{ template: "t", url: "u", selector: "" }] }),
    );
    if (badSelector.tag === "Err") expect(badSelector.error).toBe('"selectors = …" is not a valid string in rule 1');

    const badReplace = compileSmartnaming(
      JSON.stringify({ max_length: 64, template: "%title", rule: [{ template: "t", url: "u", replace: "x" }] }),
    );
    if (badReplace.tag === "Err") expect(badReplace.error).toBe('"replace" is not an array');
  });

  it("compiles a full rule and keeps directory/subdir/replace", () => {
    const document = {
      max_length: 64,
      template: "%title",
      rule: [
        {
          template: "%title - %hostname",
          url: "example.com",
          max_length: 40,
          selector: "h1",
          directory: "Videos/Example/",
          replace: [{ from: "&", to: "and" }],
        },
      ],
    };
    const compiled = compileSmartnaming(JSON.stringify(document));
    expect(compiled).toEqual({
      tag: "Ok",
      value: {
        default_: { max_length: 64, template: "%title", force_doc_title: false },
        rules: [
          {
            template: "%title - %hostname",
            url: "example.com",
            max_length: 40,
            selector: "h1",
            subdir: "Videos/Example/",
            force_doc_title: false,
            replace: [{ to: "and", from: "&" }],
          },
        ],
      },
    });
  });

  it("falls back to built-in defaults when the file is missing or invalid", () => {
    expect(loadSmartnaming(null)).toEqual(defaultSmartnaming());
    expect(loadSmartnaming("not json")).toEqual(defaultSmartnaming());
    expect(loadSmartnaming(JSON.stringify({ max_length: 32, template: "%title" }))).toEqual({
      default_: { max_length: 32, template: "%title", force_doc_title: false },
      rules: [],
    });
  });
});

describe("rule selection and materialisation (original `ip`)", () => {
  const compiled = loadSmartnaming(
    JSON.stringify({
      max_length: 64,
      template: "%title",
      rule: [
        { template: "%selector", url: "youtube.com", selector: "#title", max_length: 30, directory: "YT/" },
        { template: "%title (%hostname)", url: "vimeo.com" },
      ],
    }),
  );

  it("picks the first rule whose url string occurs in the page url", () => {
    const selected = selectRule(compiled, "https://www.youtube.com/watch?v=1");
    expect(selected.template).toBe("%selector");
    expect(selected.max_length).toBe(30);
    expect(selected.selector).toBe("#title");
    expect(selected.subdir).toBe("YT/");
  });

  it("falls back to the default rule when nothing matches", () => {
    const selected = selectRule(compiled, "https://example.org/movie");
    expect(selected.template).toBe("%title");
    expect(selected.max_length).toBe(64);
    expect(selected.selector).toBeNull();
    expect(selected.subdir).toBe("");
  });

  it("materialises selector value, download directory and case-insensitive replacements", () => {
    const selected = selectRule(compiled, "https://www.vimeo.com/123");
    const materialized = materializeRule(
      { ...selected, replace: [{ from: "foo", to: "bar" }] },
      null,
      "Downloads/",
    );
    expect(materialized.subdir).toBe("Downloads/");
    expect(materialized.replace).toHaveLength(1);
    expect(materialized.replace[0]?.from).toBeInstanceOf(RegExp);
    expect((materialized.replace[0]?.from as RegExp).flags).toBe("gi");
  });

  it("keeps an invalid replacement pattern usable rather than dropping it", () => {
    const selected = selectRule(compiled, "https://example.org/x");
    const materialized = materializeRule(
      { ...selected, replace: [{ from: "(", to: "x" }] },
      null,
      "",
    );
    expect(materialized.replace[0]?.from).toBe("(");
  });
});

describe("basename rendering (original `Ar`)", () => {
  const baseRule = {
    template: "%title",
    selector: null,
    max_length: 64,
    replace: [],
    subdir: "Downloads/",
    force_doc_title: false,
  };

  it("prefers media title, then page title, then media filename", () => {
    const meta = { title: "Page title", url: "https://www.example.com/watch" };
    expect(renderBasename({ title: "Media title", filename: "f.mp4" }, meta, baseRule).basename).toBe(
      "Media title",
    );
    expect(renderBasename({ filename: "f.mp4" }, meta, baseRule).basename).toBe("Page title");
    expect(renderBasename({ filename: "f.mp4" }, { url: "https://www.example.com/watch" }, baseRule).basename).toBe(
      "f.mp4",
    );
  });

  it("expands %hostname to the second-level label only", () => {
    const rule = { ...baseRule, template: "%hostname" };
    expect(renderBasename({ title: "T" }, { url: "https://www.example.com/x" }, rule).basename).toBe(
      "example",
    );
    expect(renderBasename({ title: "T" }, { url: "https://a.b.example.co.uk/x" }, rule).basename).toBe("co");
    expect(hostnameLabel("http://localhost:8080/")).toBeUndefined();
  });

  it("removes empty placeholders together with one preceding separator", () => {
    expect(
      renderBasename({ title: "T" }, {}, { ...baseRule, template: "%title - %selector" }).basename,
    ).toBe("T");
    expect(renderBasename({ title: "T" }, {}, { ...baseRule, template: "%title_%selector" }).basename).toBe(
      "T",
    );
  });

  it("uses selector text when the rule resolved one", () => {
    expect(
      renderBasename({ title: "T" }, {}, { ...baseRule, template: "%selector", selector: "Cool clip" })
        .basename,
    ).toBe("Cool clip");
  });

  it("does not let an empty media title erase the page title", () => {
    expect(renderBasename({ title: "   " }, { title: "Full page title" }, baseRule).basename).toBe("Full page title");
    expect(renderBasename({}, { title: "Full page title" }, baseRule).basename).toBe("Full page title");
  });

  it("falls back to title, then hostname, then empty template", () => {
    expect(renderBasename({ title: "T" }, { url: "https://www.example.com/" }, { ...baseRule, template: "" }).basename).toBe(
      "T",
    );
    expect(renderBasename({}, { url: "https://www.example.com/" }, { ...baseRule, template: "" }).basename).toBe(
      "example",
    );
    expect(renderBasename({}, {}, { ...baseRule, template: "" }).basename).toBe(EMPTY_NAME);
  });

  it("applies max_length, replacements and a second sanitisation", () => {
    // Sanitising runs first (removing the ampersand), then replacements, then sanitising again.
    expect(
      renderBasename({}, {}, { ...baseRule, template: "a & b", max_length: 5 }).basename,
    ).toBe("a b");
    expect(
      renderBasename({}, {}, { ...baseRule, template: "foo bar", replace: [{ from: "foo", to: "FOO" }] })
        .basename,
    ).toBe("FOO bar");
    expect(
      renderBasename({}, {}, { ...baseRule, template: "abcdef", max_length: 3 }).basename,
    ).toBe("abc");
  });

  it("returns the materialised subdirectory unchanged", () => {
    expect(renderBasename({ title: "T" }, {}, baseRule).subdir).toBe("Downloads/");
  });
});
