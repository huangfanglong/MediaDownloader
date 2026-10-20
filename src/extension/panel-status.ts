/**
 * Presentation model for the panel's bottom status bar.
 *
 * The service exposes raw machine states (`queuing`, `downloading`, `finalizing`) and raw
 * notification types (`download_error`, ...). The panel must never concatenate those tokens into
 * user-visible copy ("Downloading downloading"); this module maps them to a small, consistent
 * status model with a tone and an optional progress value.
 */
import type { PanelDownloadRow, PanelNotificationRow } from "./panel-snapshot.js";

export type StatusTone = "idle" | "progress" | "success" | "error";

export interface StatusPresentation {
  tone: StatusTone;
  label: string;
  detail?: string;
  /** 0..100 for a determinate progress bar; absent for indeterminate/idle states. */
  percent?: number;
}

const DOWNLOAD_LABELS: Record<string, { label: string; detail: string }> = {
  queuing: { label: "Preparing download", detail: "Waiting to start…" },
  downloading: { label: "Downloading", detail: "Transferring data…" },
  finalizing: { label: "Finishing file", detail: "Processing the downloaded media…" },
};

const NOTIFICATION_LABELS: Record<string, string> = {
  download_complete: "Download complete",
  download_success: "Download complete",
  download_error: "Download failed",
  download_interrupted: "Download interrupted",
  download_with_drm_failed: "Protected media cannot be downloaded",
  youtube_too_many_downloads: "YouTube is limiting downloads",
  limit_youtube: "YouTube download limit",
  no_youtube: "YouTube downloads are unavailable in this browser",
  tos: "Please review the terms of service",
};

const humanize = (value: string): string => {
  const words = value.replace(/[_-]+/gu, " ").trim();
  return words.length === 0 ? "Update" : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const validPercent = (value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
};

const downloadPresentation = (downloads: readonly PanelDownloadRow[]): StatusPresentation => {
  const first = downloads[0];
  if (first === undefined) return { tone: "idle", label: "Ready" };

  const progressEntry = downloads.find((entry) => entry.status !== "queuing" && validPercent(entry.percent) !== undefined);
  const percent = validPercent(progressEntry?.percent);
  const known = DOWNLOAD_LABELS[first.status];
  const label = downloads.length > 1 ? `Downloading ${downloads.length} items` : known?.label ?? humanize(first.status);
  const detail =
    percent !== undefined
      ? `${percent}% complete`
      : known?.detail ?? (downloads.length > 1 ? "Transfers in progress..." : "In progress...");
  return {
    tone: "progress",
    label,
    detail,
    ...(percent !== undefined ? { percent } : {}),
  };
};

const notificationPresentation = (notification: PanelNotificationRow | undefined): StatusPresentation | undefined => {
  if (notification === undefined) return undefined;
  const type = notification.type.toLowerCase();
  const label = NOTIFICATION_LABELS[type] ?? humanize(notification.type);
  const tone: StatusTone = /(error|fail|interrupt|drm|limit|blocked|unavailable|no_youtube)/u.test(type)
    ? "error"
    : /(complete|success|saved)/u.test(type)
      ? "success"
      : "idle";
  return {
    tone,
    label,
    ...(notification.message !== undefined && notification.message.length > 0
      ? { detail: notification.message }
      : {}),
  };
};

/** Build the status-bar view model. Active transfers win over the latest notification. */
export function statusPresentation(
  downloading: readonly PanelDownloadRow[],
  notifications: readonly PanelNotificationRow[],
): StatusPresentation {
  if (downloading.length > 0) return downloadPresentation(downloading);
  return notificationPresentation(notifications[0]) ?? { tone: "idle", label: "Ready" };
}
