/**
 * Toolbar badge feedback.
 *
 * The toolbar icon is static artwork (manifest icons); the badge tells the user how many
 * downloadable media items the current tab has, in the familiar red "unread" pill. Pending
 * notifications still take precedence (same translucent red as before); active downloads keep
 * their blue count only when no media is detected.
 */

/** `chrome.action.setBadgeBackgroundColor` argument for unread notifications. */
export const NOTIFICATION_BADGE_BACKGROUND: readonly number[] = [255, 0, 0, 190];

/** Red pill for detected downloadable media (the "unseen messages" look). */
export const MEDIA_BADGE_BACKGROUND = "#dc2626";

/** `chrome.action.setBadgeBackgroundColor` argument for active downloads. */
export const DOWNLOAD_BADGE_BACKGROUND = "#0284c7";

/** `chrome.action.setBadgeTextColor` argument in every non-empty case. */
export const BADGE_TEXT_COLOR = "white";

/** Counts that drive the badge. */
export interface BadgeCounts {
  /** `notifications.size + remote_notifications.size` (E29). */
  notificationCount: number;
  /** `downloading.size` — queued + running transfers (E29). */
  downloadingCount: number;
  /** Detected media items for the current tab (drives the red count badge). */
  mediaCount?: number;
}

export type BadgeBackgroundColor = string | number[];

/** A pure description of the `chrome.action.*` calls to make; the shell performs them. */
export interface BadgeState {
  text: string;
  backgroundColor?: BadgeBackgroundColor;
  textColor?: string;
}

/** Chrome renders at most four characters; large counts collapse to `99+`. */
export function formatBadgeCount(count: number): string {
  const safe = Math.max(0, Math.trunc(count));
  if (safe === 0) return "";
  return safe > 99 ? "99+" : String(safe);
}

/**
 * Badge priority:
 *  1. notifications > 0 → translucent red badge with the notification count;
 *  2. detected media > 0 → solid red badge with the media count;
 *  3. else downloading > 0 → blue badge with the download count;
 *  4. else empty text.
 */
export function computeBadge({
  notificationCount,
  downloadingCount,
  mediaCount = 0,
}: BadgeCounts): BadgeState {
  const notifications = Math.max(0, Math.trunc(notificationCount));
  const downloading = Math.max(0, Math.trunc(downloadingCount));
  const media = Math.max(0, Math.trunc(mediaCount));
  if (notifications > 0) {
    return {
      text: formatBadgeCount(notifications),
      backgroundColor: [...NOTIFICATION_BADGE_BACKGROUND],
      textColor: BADGE_TEXT_COLOR,
    };
  }
  if (media > 0) {
    return {
      text: formatBadgeCount(media),
      backgroundColor: MEDIA_BADGE_BACKGROUND,
      textColor: BADGE_TEXT_COLOR,
    };
  }
  if (downloading > 0) {
    return {
      text: formatBadgeCount(downloading),
      backgroundColor: DOWNLOAD_BADGE_BACKGROUND,
      textColor: BADGE_TEXT_COLOR,
    };
  }
  return { text: "" };
}
