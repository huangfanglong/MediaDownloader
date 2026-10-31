/**
 * Portable filename rules Chrome applies to extension-supplied download names.
 *
 * `chrome.downloads.download()` and the `downloads.onDeterminingFilename` answer are both
 * validated with `net::IsSafePortableRelativePath` before a download starts
 * (chrome/browser/extensions/api/downloads/downloads_api.cc). A filename that fails is
 * answered with "Invalid filename" and the transfer is thrown away, so character
 * sanitisation alone is not enough: the name must also stay out of the Windows device
 * namespace and away from the trailing-dot/space and dot-segment rules.
 *
 * The rules are portable rather than Windows-only — Chrome enforces them everywhere
 * (net/base/filename_util.h):
 *  - a component is non-empty and is not `.` or `..`
 *  - it does not begin with `.`
 *  - it does not end with ` ` or `.`
 *  - it contains no path separators or characters Windows refuses
 *  - it is not a Windows reserved device name, case-insensitively and regardless of any
 *    extension (`NUL.zip` is still NUL)
 *
 * Names are repaired here instead of rejected: the media has already been downloaded and
 * assembled by the time the filename is used, so failing the save over a title the user
 * cannot control helps nobody. The device-name repair is Chromium's own convention: prefix
 * the name with `_` (see `GenerateSafeFileName` in net/base/filename_util.h).
 *
 * Directory segments and basenames are repaired by different functions on purpose:
 * {@link repairPathComponent} produces a component that stands on its own, while
 * {@link repairBasename} is followed by `.` + media extension, so a title ending in an
 * ellipsis cannot be refused and must not be rewritten.
 */
import { EMPTY_NAME, sanitizeName } from "./sanitize.js";

/** Reserved device names match the part before the first dot, so `NUL.zip` is still NUL. */
const RESERVED_COMPONENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?=$|\.)/iu;

/** Path separators and characters Windows does not allow in a file name. The global copy is
 *  for `replace`, the anchored one for the boolean test (a global regex carries `lastIndex`). */
const ILLEGAL_CHARACTER = /[<>:"/\\|?*\u0000-\u001f\u007f]/u;
const ILLEGAL_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu;

const LEADING_DOTS = /^\.+/u;

/** A standalone component may not end with a dot or a space. */
const TRAILING_SEPARATOR = /[. ]+$/u;

/** Directory separators accepted from configuration (`Media/Clips`, `Media\Clips`). */
const DIRECTORY_SEPARATORS = /[\\/]+/u;

/** Shell-integrated extensions (`.exe`, `.lnk`, …) are also refused by Chrome, but every
 *  output extension this extension can produce is on the media allowlist, so no check is
 *  needed here. Keep that assumption in mind if the extension list ever grows. */

/** True when `component` passes the portable rules Chrome applies to download names. */
export function isSafePathComponent(component: string): boolean {
  if (component.length === 0) return false;
  if (component === "." || component === "..") return false;
  if (component.startsWith(".")) return false;
  if (TRAILING_SEPARATOR.test(component)) return false;
  if (ILLEGAL_CHARACTER.test(component)) return false;
  return !RESERVED_COMPONENT.test(component);
}

/**
 * Repair a standalone path component so Chrome accepts it.
 *
 * Intended for names that already went through {@link sanitizeName} (or for configuration
 * text). It removes illegal characters and leading dots, trims, strips trailing dots and
 * spaces, and prefixes reserved device names with `_`. An empty result becomes `fallback`.
 */
export function repairPathComponent(component: string, fallback: string = EMPTY_NAME): string {
  const repaired = component
    .normalize("NFC")
    .replace(ILLEGAL_CHARACTERS, "")
    .replace(LEADING_DOTS, "")
    .replace(TRAILING_SEPARATOR, "")
    .trim();
  if (repaired.length === 0) return fallback;
  return RESERVED_COMPONENT.test(repaired) ? `_${repaired}` : repaired;
}

/**
 * Repair a basename that will get `.` + media extension appended.
 *
 * Trailing dots and spaces are left alone: the extension keeps them inside the final name
 * (`Wait for it....mp4` and `name..mp4` are accepted), and stripping them would rewrite
 * ordinary titles that end in an ellipsis. Reserved device names still need fixing, because
 * they stay reserved after the extension (`NUL.zip.mp4` is still NUL).
 */
export function repairBasename(basename: string, fallback: string = EMPTY_NAME): string {
  const repaired = basename
    .normalize("NFC")
    .replace(ILLEGAL_CHARACTERS, "")
    .replace(LEADING_DOTS, "")
    .trim();
  if (repaired.length === 0) return fallback;
  return RESERVED_COMPONENT.test(repaired) ? `_${repaired}` : repaired;
}

/**
 * Normalise a configured relative directory into safe components with a trailing slash.
 *
 * Settings and smart-naming rules both feed this: separators are collapsed, empty and
 * whitespace-only segments dropped, and each remaining segment is sanitised and repaired.
 */
export function normalizeSubdir(subdir: string): string {
  const segments = subdir
    .split(DIRECTORY_SEPARATORS)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => repairPathComponent(sanitizeName(segment)));
  return segments.length === 0 ? "" : `${segments.join("/")}/`;
}
