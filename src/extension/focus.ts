/**
 * Focused-media selection.
 *
 * Requirement: on pages with several media elements, offers the
 * one the user focused/played, not every autoplaying video. The original's imperative logic is not
 * readable from the pretty artifacts, so this is a rebuild-only heuristic:
 *
 *  - the page hook tracks the last played/focused media element and the media URLs requested while
 *    it played (this maps MSE/blob playback back to network URLs),
 *  - hints whose URL identity (origin + path) matches those URLs are marked focused and win the
 *    listing; the sniffer's duplicate items are filtered with the same identity in the service.
 *
 * Identity deliberately ignores the query string: Instagram/Threads request the same path with
 * volatile `_nc_*` parameters, while the path itself is unique per asset.
 */
import type { MediaItem } from "../core/types.js";

export interface MediaFocusState {
  /** Focused media URLs (hint, poster or observed network URLs). */
  urls: string[];
  /** Timestamp of the last focus/play event (`now()` clock). */
  at: number;
}

/** Focus information is ignored after this long without a play/focus event. */
export const FOCUS_TTL_MS = 5 * 60_000;

/** Stable identity for focus matching: `origin + pathname`, lower-cased. */
export function focusKey(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.origin}${url.pathname}`.toLowerCase();
  } catch {
    return undefined;
  }
}

function mediaUrlCandidates(media: MediaItem): string[] {
  const candidates: string[] = [];
  if (media.url !== undefined) candidates.push(media.url.href);
  if (media.master_url !== undefined) candidates.push(media.master_url.href);
  for (const entry of media.playlist ?? []) {
    const pick = (value: URL | false | undefined): void => {
      if (value !== undefined && value !== false) candidates.push(value.href);
    };
    pick(entry.av?.video);
    pick(entry.av?.audio);
  }
  return candidates;
}

/** True when the media item is the focused asset (or not focus-filterable at all). */
export function mediaMatchesFocus(media: MediaItem, focus: Pick<MediaFocusState, "urls">): boolean {
  if (media.is_youtube) return true; // the YouTube adapter already resolves the current video
  if (media.type !== "http_playlist") return true; // manifests are page-level, not per-video
  const keys = new Set(focus.urls.map(focusKey).filter((key): key is string => key !== undefined));
  if (keys.size === 0) return true;
  return mediaUrlCandidates(media).some((candidate) => {
    const key = focusKey(candidate);
    return key !== undefined && keys.has(key);
  });
}

/**
 * Keep the focused media only. Falls back to the full list when focus is stale/empty or nothing
 * matches (safer than showing an empty panel).
 */
export function filterFocusedMedia<T extends MediaItem>(
  media: readonly T[],
  focus: MediaFocusState | undefined,
  now: number = Date.now(),
): T[] {
  if (focus === undefined || focus.urls.length === 0) return [...media];
  if (now - focus.at > FOCUS_TTL_MS) return [...media];
  if (media.length <= 1) return [...media];
  const focused = media.filter((item) => mediaMatchesFocus(item, focus));
  if (focused.length === 0) return [...media];
  // Instagram's API row carries all renditions, while the sniffer may also add one row per
  // requested rendition. A single-URL row covered by a richer focused row is a duplicate.
  const urlSets = focused.map((item) => new Set(mediaUrlCandidates(item)));
  const kept = focused.filter((_item, index) => {
    const own = urlSets[index];
    if (own === undefined) return true;
    return !urlSets.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      const covered = own.size > 0 && [...own].every((url) => other.has(url));
      if (!covered) return false;
      // A richer row replaces the sniffer's subset; for identical URL sets keep the first.
      return other.size > own.size || (other.size === own.size && otherIndex < index);
    });
  });
  return kept.length > 0 ? kept : focused;
}
