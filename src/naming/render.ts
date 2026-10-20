/**
 * Basename rendering from a materialised smart-naming rule.
 *
 * Evidence: service worker `Ar` (analysis/pretty/service__main.js.pretty.js lines 9437-9464;
 * original artifact bytes ~200k). Placeholder semantics are reproduced exactly:
 *
 *  - `%title`    first of media title, page title, media filename (trimmed)
 *  - `%hostname` the second-level label of the media host ("" for single-label hosts)
 *  - `%selector` the page element value resolved by the rule's CSS selector
 *
 * A placeholder with no value is removed together with one preceding space, dash or underscore.
 * If the template ends up empty, the raw title / hostname is used. The result is sanitised, cut
 * to the rule's `max_length`, run through the rule's replacements, then sanitised and cut again.
 */
import { sanitizeName } from "./sanitize.js";
import type { MaterializedRule } from "./rules.js";

export interface NameMediaLike {
  /** Media-level title, when the extractor provided one. */
  title?: string;
  /** Media-level filename, when the extractor provided one. */
  filename?: string;
}

export interface NameMetaLike {
  /** Tab/page title captured at discovery time. */
  title?: string;
  /** Page URL; only its host is used here. */
  url?: string;
}

export interface RenderedName {
  basename: string;
  subdir: string;
}

const PLACEHOLDERS = ["%title", "%hostname", "%selector"] as const;

/** Second-level label of a URL host, e.g. `example` for `www.example.com`; "" when absent. */
export function hostnameLabel(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return undefined;
  }
  const labels = host.split(".").slice(-2);
  labels.pop();
  return labels[0];
}

/** Pick the first non-empty title; an empty media title must not erase the page title. */
function pickTitle(media: NameMediaLike, meta: NameMetaLike): string | undefined {
  for (const candidate of [media.title, meta.title, media.filename]) {
    if (candidate === undefined) continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Render the final basename and subdirectory for a download.
 * `rule.subdir` is already prefixed with the configured download directory.
 */
export function renderBasename(
  media: NameMediaLike,
  meta: NameMetaLike,
  rule: MaterializedRule,
): RenderedName {
  const title = pickTitle(media, meta);
  const hostname = hostnameLabel(meta.url);

  let template = rule.template;
  const apply = (placeholder: string, value: string | undefined): void => {
    if (value) {
      template = template.replace(placeholder, value);
      return;
    }
    template = template
      .replace(` ${placeholder}`, "")
      .replace(`-${placeholder}`, "")
      .replace(`_${placeholder}`, "")
      .replace(placeholder, "");
  };

  apply(PLACEHOLDERS[0], title);
  apply(PLACEHOLDERS[1], hostname);
  apply(PLACEHOLDERS[2], rule.selector ?? undefined);

  let basename = template || title || hostname || "";
  basename = sanitizeName(basename).substring(0, rule.max_length);
  for (const replacement of rule.replace) basename = basename.replaceAll(replacement.from, replacement.to);
  basename = sanitizeName(basename).substring(0, rule.max_length);

  return { basename, subdir: rule.subdir };
}
