/**
 * Panel view model: a plain, JSON-safe projection of the service state.
 *
 * The original UI renders directly from storage state; the rebuild pushes an explicit snapshot so
 * the panel never depends on internal Map/URL/Headers shapes (and can be tested without a DOM).
 */
import type { MediaItem, PlaylistEntry, TabMeta } from "../core/types.js";
import { renderBasename } from "../naming/render.js";

export interface PanelMediaRow {
  hash: string;
  type: string;
  label: string;
  extension?: string;
  duration?: string | number;
  size?: number;
  /** Poster thumbnail URL rendered by the panel. */
  thumbnail?: string;
  /** Quality dropdown entries (best first); empty/undefined for single-rendition media. */
  variants?: Array<{ index: number; label: string; container?: string }>;
  /** Why Auto will use a container different from the selected quality's codec. */
  muxNote?: string;
  /** Muted hover-preview source (direct video track; absent for manifests). */
  preview?: string;
  /** Visible reason when this detected media cannot be downloaded yet. */
  download_disabled_reason?: string;
  /** Default download source tag (FMT for direct formats, HLS for m3u8). */
  source?: "FMT" | "HLS" | "DASH";
  /** Selectable sources; more than one only when the player exposed both FMT and HLS. */
  sources?: Array<{ value: "fmt" | "hls" | "dash"; label: "FMT" | "HLS" | "DASH" }>;
  has_drm: boolean;
}

export interface PanelDownloadRow {
  download_id: string;
  status: string;
  percent?: number;
  bitrate?: number;
}

export interface PanelNotificationRow {
  type: string;
  message?: string;
}

export interface PanelSnapshot {
  tab_id?: number;
  page_url?: string;
  page_title?: string;
  default_action?: string;
  media: PanelMediaRow[];
  downloading: PanelDownloadRow[];
  notifications: PanelNotificationRow[];
}

export interface PanelSnapshotInput {
  tabId?: number;
  meta?: TabMeta;
  media: ReadonlyMap<string, MediaItem> | readonly MediaItem[];
  downloading: ReadonlyMap<string, { status: string; percent?: number; bitrate: number }>;
  notifications: ReadonlyMap<string, { type: string; message?: string; details?: string }>;
}

const toArray = (media: PanelSnapshotInput["media"]): MediaItem[] =>
  Array.isArray(media) ? [...media] : [...(media as ReadonlyMap<string, MediaItem>).values()];

/** Best-effort human label: smart-naming-aware basename plus the output extension. */
export function mediaLabel(media: MediaItem, meta?: TabMeta): string {
  const extension = media.extension ?? media.demuxer ?? "";
  let basename = media.title ?? media.filename ?? "";
  if (meta) {
    try {
      basename = renderBasename(
        { title: media.title, filename: media.filename },
        { title: meta.title, url: meta.url?.href },
        meta.smartnaming_rule,
      ).basename;
    } catch {
      // Keep the simple title fallback when the rule cannot render.
    }
  }
  if (!basename) basename = `${media.type} ${media.hash.slice(-6)}`;
  return extension ? `${basename}.${extension}` : basename;
}

/** Human-readable format label for the panel meta line (never the internal media type). */
export function formatLabel(row: Pick<PanelMediaRow, "type" | "extension">): string | undefined {
  const extension = row.extension?.toUpperCase();
  if (extension !== undefined && extension.length > 0) return extension;
  if (row.type === "m3u8" || row.type === "m3u8_playlist") return "HLS";
  if (row.type === "mpd_playlist") return "DASH";
  return undefined;
}

const DEMUXER_LABELS: Record<string, string> = {
  mp4: "MP4",
  m4a: "M4A",
  webm: "WEBM",
  mkv: "MKV",
  ts: "TS",
};

/** Quality label: `MP4 · 1920x1080 · 4MB/s`. */
export interface QualityFallback {
  width?: number;
  height?: number;
  bitrate?: number;
}

function bitrateLabel(bitrate: number | undefined): string | undefined {
  if (bitrate === undefined || !Number.isFinite(bitrate) || bitrate <= 0) return undefined;
  const bytesPerSecond = bitrate / 8;
  return bytesPerSecond >= 1e6
    ? `${(bytesPerSecond / 1e6).toFixed(1)}MB/s`
    : `${Math.max(1, Math.round(bytesPerSecond / 1e3))}KB/s`;
}

/** Quality label: format, resolution, approximate bitrate. */
export function variantLabel(entry: PlaylistEntry, index: number, fallback?: QualityFallback): string {
  const format = DEMUXER_LABELS[entry.demuxer] ?? (entry.demuxer.length > 0 ? entry.demuxer.toUpperCase() : undefined);
  const parts: string[] = [];
  if (format !== undefined) parts.push(format);
  const size = entry.quality.size;
  const width = size?.width ?? fallback?.width;
  const height = size?.height ?? fallback?.height;
  if (width !== undefined && height !== undefined) {
    parts.push(`${width}x${height}`);
  } else if (height !== undefined) {
    parts.push(`${height}p`);
  }
  const rate = bitrateLabel(entry.quality.bitrate ?? fallback?.bitrate);
  if (rate !== undefined) parts.push(rate);
  if (parts.length === 0) parts.push(`Quality ${index + 1}`);
  return parts.join(" · ");
}
function previewUrl(item: MediaItem): string | undefined {
  if (item.preview_url !== undefined) return item.preview_url.href;
  if (item.type === "http_playlist") {
    const entry = item.playlist?.[0];
    const video = entry?.av?.video;
    if (video !== undefined && video !== false) return video.href;
    return item.url?.href;
  }
  return undefined;
}

export function buildPanelSnapshot(input: PanelSnapshotInput): PanelSnapshot {
  const pageThumbnail = input.meta?.thumbnail_url?.href;
  const media = toArray(input.media).map((item): PanelMediaRow => ({
    hash: item.hash,
    type: item.type,
    label: mediaLabel(item, input.meta),
    ...(item.extension !== undefined ? { extension: item.extension } : {}),
    ...(item.duration !== undefined ? { duration: item.duration } : {}),
    ...(item.playlist?.[0]?.size !== undefined ? { size: item.playlist[0].size } : {}),
    ...((item.thumbnail_url?.href ?? pageThumbnail) !== undefined
      ? { thumbnail: item.thumbnail_url?.href ?? pageThumbnail }
      : {}),
    ...((): { variants: PanelMediaRow["variants"]; muxNote?: string } => {
      const fallbackQuality: QualityFallback = {
        ...(item.rendered_width !== undefined ? { width: item.rendered_width } : {}),
        ...(item.rendered_height !== undefined ? { height: item.rendered_height } : {}),
        ...(item.estimated_bitrate !== undefined ? { bitrate: item.estimated_bitrate } : {}),
      };
      const entries = item.playlist !== undefined && item.playlist.length > 0 ? item.playlist : undefined;
      if (entries === undefined) {
        const format =
          item.type === "m3u8" || item.type === "m3u8_playlist" || item.type === "mpd_playlist"
            ? item.extension?.toUpperCase() ?? "MP4"
            : item.extension?.toUpperCase() ?? "Source";
        const parts = [format];
        if (fallbackQuality.width !== undefined && fallbackQuality.height !== undefined) {
          parts.push(`${fallbackQuality.width}x${fallbackQuality.height}`);
        }
        const rate = bitrateLabel(fallbackQuality.bitrate);
        if (rate !== undefined) parts.push(rate);
        return { variants: [{ index: 0, label: parts.join(" · ") }] };
      }
      // Show the real rendition label even when it is the only one. "Best available" hid the
      // codec/resolution that the adapter already knew.
      const labels = entries.map((entry, index) => variantLabel(entry, index, fallbackQuality));
      // Instagram WEBM renditions are video-only and pair with AAC audio; Auto must mux them
      // into Matroska. Surface that so the quality list (WEBM) and the output file (.mkv)
      // stop looking contradictory.
      const outputContainers = entries.map((entry) =>
        item.type === "http_playlist" &&
        item.is_youtube !== true &&
        entry.demuxer === "webm" &&
        entry.av?.audio !== undefined &&
        entry.av.audio !== false
          ? "mkv"
          : undefined,
      );
      const renderedLabels = labels.map((label, index) =>
        outputContainers[index] !== undefined ? label.replace(/^WEBM/u, "WEBM video") : label,
      );
      const labelCounts = new Map<string, number>();
      for (const label of renderedLabels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      const mixed = outputContainers.some((container) => container !== undefined);
      return {
        variants: renderedLabels.map((label, index) => ({
          index,
          label: (labelCounts.get(label) ?? 0) > 1 ? `${label} (${index + 1})` : label,
          ...(outputContainers[index] !== undefined ? { container: outputContainers[index] } : {}),
        })),
        ...(mixed ? { muxNote: "WEBM video + AAC audio → saves as MKV" } : {}),
      };
    })(),
    ...(previewUrl(item) !== undefined ? { preview: previewUrl(item) } : {}),
    ...(item.type === "mpd_playlist"
      ? { download_disabled_reason: "DASH downloads are not supported yet" }
      : {}),
    ...((): { source: PanelMediaRow["source"]; sources: NonNullable<PanelMediaRow["sources"]> } => {
      if (item.hls_url !== undefined) {
        return {
          source: "FMT",
          sources: [
            { value: "fmt", label: "FMT" },
            { value: "hls", label: "HLS" },
          ],
        };
      }
      if (item.type === "m3u8" || item.type === "m3u8_playlist") {
        return { source: "HLS", sources: [{ value: "hls", label: "HLS" }] };
      }
      if (item.type === "mpd_playlist") {
        return { source: "DASH", sources: [{ value: "dash", label: "DASH" }] };
      }
      return { source: "FMT", sources: [{ value: "fmt", label: "FMT" }] };
    })(),
    has_drm: item.has_drm ?? false,
  }));
  return {
    ...(input.tabId !== undefined ? { tab_id: input.tabId } : {}),
    ...(input.meta?.url !== undefined ? { page_url: input.meta.url.href } : {}),
    ...(input.meta?.title !== undefined ? { page_title: input.meta.title } : {}),
    ...(input.meta?.default_action !== undefined ? { default_action: input.meta.default_action } : {}),
    media,
    downloading: [...input.downloading.entries()].map(([downloadId, entry]) => ({
      download_id: downloadId,
      status: entry.status,
      ...(entry.percent !== undefined ? { percent: entry.percent } : {}),
      ...(entry.bitrate !== undefined ? { bitrate: entry.bitrate } : {}),
    })),
    notifications: [...input.notifications.values()].map((notification) => ({
      type: notification.type,
      ...(notification.message !== undefined
        ? { message: notification.message }
        : notification.details !== undefined
          ? { message: notification.details }
          : {}),
    })),
  };
}

/** Hover preview plays this many seconds from a later position before looping back. */
export const PREVIEW_WINDOW_SECONDS = 12;

/** Where the hover preview starts: ~35% in (at least 5 s, never inside the last 12 s). */
export function previewStartSeconds(duration: number | undefined): number {
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return 0;
  // Short clips: play the whole clip (a seek past the end would just stall).
  if (duration <= PREVIEW_WINDOW_SECONDS + 5) return 0;
  const preferred = Math.max(duration * 0.35, 5);
  return Math.min(preferred, duration - PREVIEW_WINDOW_SECONDS - 1);
}

/**
 * Display-only row signature. Excludes volatile fields (signed preview URL, size refresh) so a
 * routine 2-second snapshot does not rebuild the row DOM and close an open native dropdown.
 */
export function panelMediaSignature(media: readonly PanelMediaRow[]): string {
  return media
    .map((row) =>
      [
        row.hash,
        row.type,
        row.label,
        row.extension ?? "",
        String(row.duration ?? ""),
        String(row.size ?? ""),
        row.thumbnail ?? "",
        row.has_drm ? "1" : "0",
        row.source ?? "",
        (row.sources ?? []).map((source) => source.value).join(","),
        (row.variants ?? []).map((variant) => `${variant.index}:${variant.label}:${variant.container ?? ""}`).join(","),
        row.muxNote ?? "",
        row.download_disabled_reason ?? "",
      ].join("\u0001"),
    )
    .join("\u0002");
}
