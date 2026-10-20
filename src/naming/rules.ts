/**
 * Smart-naming rules: parsing, validation, selection and materialisation.
 *
 * Evidence: service worker `zi` (defaults), `Uv` (directory validation), `jv` (rule file
 * validation), `np` (compile entry point), `ip` (rule selection / materialisation).
 * analysis/pretty/service__main.js.pretty.js lines 9340-9360 and 9400-9464; original bytes ~200k.
 *
 * The rules file is user-editable JSON with a default template plus URL-matched overrides:
 *
 *   { "max_length": 64, "template": "%title",
 *     "rule": [ { "url": "youtube.com", "template": "%title (%hostname)",
 *                 "selector": "#title h1", "directory": "YouTube/" } ] }
 */
import { err, ok, type Result } from "../core/option.js";
import { sanitizeName } from "./sanitize.js";

export interface SmartnamingDefault {
  max_length: number;
  template: string;
  force_doc_title?: boolean;
}

export interface SmartnamingReplace {
  from: string;
  to: string;
}

/** A rule exactly as written in the user's JSON file. */
export interface SmartnamingRuleSource {
  template: string;
  url: string;
  max_length: number | null;
  selector: string | null;
  subdir?: string;
  force_doc_title?: boolean;
  replace?: SmartnamingReplace[];
}

export interface CompiledSmartnaming {
  default_: SmartnamingDefault;
  rules: SmartnamingRuleSource[];
}

/** A rule ready for rendering: replaces compiled to regexes, selector already evaluated. */
export interface MaterializedRule {
  template: string;
  selector: string | null;
  max_length: number;
  replace: Array<{ from: RegExp | string; to: string }>;
  subdir: string;
  force_doc_title: boolean;
}

/** Rule actually chosen for a page, before materialisation. */
export interface SelectedRule {
  template: string;
  max_length: number;
  subdir: string;
  force_doc_title: boolean;
  replace: SmartnamingReplace[];
  selector: string | null;
}

export const DEFAULT_MAX_LENGTH = 64;
export const DEFAULT_TEMPLATE = "%title";
export const MAX_DIRECTORY_LENGTH = 255;

/** Built-in fallback used when no user rules file exists / fails to compile. */
export function defaultSmartnaming(): CompiledSmartnaming {
  return { default_: { max_length: DEFAULT_MAX_LENGTH, template: DEFAULT_TEMPLATE }, rules: [] };
}

/**
 * Validate a user-supplied download subdirectory.
 * Returns the normalised directory (always trailing slash) or an error string shown to the user.
 */
export function validateDirectory(input: string): Result<string, string> {
  let directory = input;
  if (directory === "") return ok("");
  if (directory.startsWith("/")) directory = directory.slice(1);
  if (directory.endsWith("/")) directory = directory.slice(0, -1);
  for (const segment of directory.split("/")) {
    if (sanitizeSegment(segment) !== segment) {
      return err('This not a valid path. Avoid special characters. Use "/" between directories.');
    }
  }
  const joined = `${directory.split("/").join("/")}/`;
  if (joined.length > MAX_DIRECTORY_LENGTH) return err("Path too long");
  return ok(joined);
}

/** A directory segment must survive the sanitiser unchanged. */
const sanitizeSegment = sanitizeName;

/** Parse and validate a rules file. */
export function compileSmartnaming(source: string): Result<CompiledSmartnaming, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return err("Invalid syntax");
  }
  const document = raw as {
    max_length?: unknown;
    template?: unknown;
    force_doc_title?: unknown;
    rule?: unknown;
  };
  if (typeof document?.max_length !== "number" || document.max_length < 1) {
    return err("Default `max_length` value invalid or missing");
  }
  if (typeof document.template !== "string" || document.template.length === 0) {
    return err("Default `template` value invalid or missing");
  }
  const defaults: SmartnamingDefault = {
    max_length: document.max_length,
    template: document.template,
    force_doc_title: document.force_doc_title === true,
  };
  if (!Array.isArray(document.rule)) return ok({ default_: defaults, rules: [] });
  const rules = validateRules(document.rule);
  return rules.tag === "Err" ? rules : ok({ default_: defaults, rules: rules.value });
}

/** Validate an array of rule objects (1-based positions in error messages, like the original). */
export function validateRules(input: unknown[]): Result<SmartnamingRuleSource[], string> {
  const rules: SmartnamingRuleSource[] = [];
  let position = 0;
  for (const candidate of input) {
    position += 1;
    if (typeof candidate !== "object" || candidate === null) return err(`invalid rule object ${position}`);
    const rule = candidate as Record<string, unknown>;
    if (typeof rule.template !== "string") {
      return err(`"template = \u2026" is missing or invalid in rule ${position}`);
    }
    if (typeof rule.url !== "string") {
      return err(`"url = \u2026" is missing or invalid in rule ${position}`);
    }
    const parsed: SmartnamingRuleSource = {
      max_length: null,
      selector: null,
      template: rule.template,
      url: rule.url,
      force_doc_title: rule.force_doc_title === true,
    };
    if ("max_length" in rule && (typeof rule.max_length !== "number" || rule.max_length < 1)) {
      return err(`"max_length = \u2026" invalid in rule ${position}`);
    }
    parsed.max_length = (rule.max_length as number | undefined) || null;
    if ("selector" in rule) {
      if (typeof rule.selector !== "string" || rule.selector.length === 0) {
        return err(`"selectors = \u2026" is not a valid string in rule ${position}`);
      }
      parsed.selector = rule.selector;
    }
    if (typeof rule.directory === "string") {
      const directory = validateDirectory(rule.directory);
      if (directory.tag === "Err") return directory;
      parsed.subdir = directory.value;
    }
    if ("replace" in rule) {
      if (!Array.isArray(rule.replace)) return err('"replace" is not an array');
      const replacements: SmartnamingReplace[] = [];
      for (const entry of rule.replace) {
        if (typeof entry !== "object" || entry === null) return err("invalid replace value");
        const replacement = entry as Record<string, unknown>;
        if ("from" in replacement && typeof replacement.from === "string") {
          if ("to" in replacement && typeof replacement.to === "string") {
            replacements.push({ to: replacement.to, from: replacement.from });
          } else {
            return err('"replace" is missing "to" field, or "to" field is not a string');
          }
        } else {
          return err('"replace" is missing "from" field, or "from" field is not a string');
        }
      }
      parsed.replace = replacements;
    }
    rules.push(parsed);
  }
  return ok(rules);
}

/**
 * Load a rules file with the service worker's fallback semantics: a missing or invalid file
 * silently falls back to the built-in defaults.
 */
export function loadSmartnaming(source: string | null | undefined): CompiledSmartnaming {
  if (!source) return defaultSmartnaming();
  const compiled = compileSmartnaming(source);
  return compiled.tag === "Ok" ? compiled.value : defaultSmartnaming();
}

/**
 * Choose the rule for a page: the first rule whose `url` string occurs inside the page URL
 * (substring match, not a pattern), otherwise the defaults.
 */
export function selectRule(compiled: CompiledSmartnaming, pageUrl: string | undefined): SelectedRule {
  if (pageUrl !== undefined) {
    for (const rule of compiled.rules) {
      if (pageUrl.includes(rule.url)) {
        return {
          template: rule.template,
          max_length: rule.max_length || compiled.default_.max_length,
          replace: rule.replace ?? [],
          subdir: rule.subdir ? rule.subdir : "", // joined with the download directory later
          force_doc_title: rule.force_doc_title === true,
          selector: rule.selector,
        };
      }
    }
  }
  return {
    template: compiled.default_.template,
    max_length: compiled.default_.max_length,
    replace: [],
    subdir: "",
    force_doc_title: compiled.default_.force_doc_title === true,
    selector: null,
  };
}

/**
 * Materialise a selected rule: compile `replace.from` to a global case-insensitive RegExp,
 * prefix the subdirectory with the configured download directory, and attach the selector's
 * resolved value (the caller evaluates the selector in the page).
 */
export function materializeRule(
  selected: SelectedRule,
  selectorValue: string | null,
  downloadDirectory: string,
): MaterializedRule {
  const replace: Array<{ from: RegExp | string; to: string }> = [];
  for (const entry of selected.replace) {
    let from: RegExp | string = entry.from;
    try {
      from = new RegExp(entry.from, "gi");
    } catch {
      // Original keeps the raw string when the pattern is invalid; replaceAll still accepts it.
    }
    replace.push({ from, to: entry.to });
  }
  return {
    template: selected.template,
    selector: selected.selector ? selectorValue : null,
    max_length: selected.max_length,
    replace,
    subdir: downloadDirectory + (selected.subdir || ""),
    force_doc_title: selected.force_doc_title,
  };
}


