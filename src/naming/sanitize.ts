/**
 * Filename sanitisation used by the smart-naming subsystem.
 *
 * Evidence: service worker `xt` (analysis/pretty/service__main.js.pretty.js lines 9424-9436;
 * original artifact bytes ~200k). Reproduced rule-for-rule because the output is user-visible
 * and directly testable.
 */
const FORBIDDEN = /[^\p{L}\p{N}\p{M}\-\s_.]/gu;
const LEADING_DOTS = /^\.+/gu;
const DASH_RUNS = /-+/gu;
const SPACE_RUNS = /\s+/gu;
const LEADING_SEPARATORS = /^(\s|-)+/gu;
const TRAILING_SEPARATORS = /(\s|-)+$/gu;

/** Maximum length kept by the sanitiser before the rule's own `max_length` applies. */
export const SANITIZE_LIMIT = 190;

/** Replacement used when sanitising leaves nothing behind. */
export const EMPTY_NAME = "no-name";

/**
 * Turn arbitrary text into a safe file basename.
 *
 * Order is significant: trimming and Unicode NFC normalisation happen first, leading dots are
 * dropped, everything not (letter|number|mark|dash|space|underscore|dot) is removed, dash runs
 * and whitespace runs collapse, leading separators are dropped, the string is cut to 190 code
 * units, trailing separators are dropped, and an empty result becomes `no-name`.
 */
export function sanitizeName(input: string): string {
  const sanitized = input
    .trim()
    .normalize("NFC")
    .replace(LEADING_DOTS, "")
    .replace(FORBIDDEN, "")
    .replace(DASH_RUNS, "-")
    .replace(SPACE_RUNS, " ")
    .replace(LEADING_SEPARATORS, "")
    .substring(0, SANITIZE_LIMIT)
    .replace(TRAILING_SEPARATORS, "");
  return sanitized.length === 0 ? EMPTY_NAME : sanitized;
}
