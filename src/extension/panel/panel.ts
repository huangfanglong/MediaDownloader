/**
 * Panel UI (side panel / popup)..
 *
 * Data contract: the panel renders a plain, serde-encoded `PanelSnapshot` pushed by the service
 * worker (channel 6). Actions are content→service messages (channel 1); the service resolves the
 * media item by tab id + hash so the panel never has to re-send full media objects.
 *
 * Stability rule: the service polls that snapshot every 2 s. Rows are only rebuilt when their
 * *display* signature changes, and never while a native quality/format dropdown is open — otherwise
 * the browser closes the dropdown under the cursor.
 */
import { Channel } from "../../protocol/channels.js";
import { MSG } from "../../protocol/messages.js";
import { REBUILD_MESSAGES } from "../../protocol/rebuild-messages.js";
import { decode } from "../../protocol/serde.js";
import { statusPresentation } from "../panel-status.js";
import { BoundedCache } from "../bounded-cache.js";
import {
  formatLabel,
  panelMediaSignature,
  PREVIEW_WINDOW_SECONDS,
  previewStartSeconds,
  type PanelSnapshot,
} from "../panel-snapshot.js";

interface ChromeRuntimeLike {
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
}

interface ChromeScriptingLike {
  executeScript(options: {
    target: { tabId: number; allFrames?: boolean };
    world?: "MAIN" | "ISOLATED";
    func: (...args: never[]) => unknown;
    args?: unknown[];
  }): Promise<Array<{ result?: unknown }>>;
}

const chromeApi = (globalThis as {
  chrome?: { runtime?: ChromeRuntimeLike; scripting?: ChromeScriptingLike };
}).chrome;
const runtime = chromeApi?.runtime;
const scripting = chromeApi?.scripting;
let activeTabId: number | undefined;
let lastSnapshot: PanelSnapshot | undefined;
let qualityTabId: number | undefined;
let qualityPageUrl: string | undefined;
let qualityProbedAt = 0;
let measuredQuality: { width: number; height: number; bitrate?: number } | undefined;
const list = document.getElementById("media-list");
const empty = document.getElementById("empty");
const statusLine = document.getElementById("status");
const statusLabel = document.getElementById("status-label");
const statusDetail = document.getElementById("status-detail");
const statusTrack = document.getElementById("status-track");
const statusFill = document.getElementById("status-fill");
const pageTitle = document.getElementById("page-title");

/** Per-media select values survive a row rebuild (quality / format). */
const SELECTIONS = new Map<string, { quality: string; format: string; source: string }>();
let lastRowSignature: string | undefined;
let pendingSnapshot: PanelSnapshot | undefined;

function send(name: string, data: unknown): void {
  void runtime?.sendMessage({ msg: { name, data }, channel: Channel.FromContentToService }).catch(() => undefined);
}

function formatDuration(duration: string | number | undefined): string | undefined {
  if (duration === undefined) return undefined;
  if (typeof duration === "string") return duration === "unknown" ? undefined : duration;
  const total = Math.round(duration);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function saveSelection(hash: string, patch: Partial<{ quality: string; format: string; source: string }>): void {
  const current = SELECTIONS.get(hash) ?? { quality: "0", format: "", source: "" };
  SELECTIONS.set(hash, { ...current, ...patch });
}

function createThumbnail(mediaWrap: HTMLElement, row: PanelSnapshot["media"][number]): void {
  if (row.thumbnail === undefined || row.thumbnail.length === 0) return;
  const thumbnail = document.createElement("img");
  thumbnail.className = "media-thumb";
  thumbnail.src = row.thumbnail;
  thumbnail.alt = "";
  thumbnail.loading = "lazy";
  // Do not leak the extension origin/page URL to a page-controlled image host.
  thumbnail.referrerPolicy = "no-referrer";
  // Sharp YouTube source is maxresdefault; not every video has it, so degrade gracefully.
  thumbnail.addEventListener("error", () => {
    const current = thumbnail.getAttribute("src") ?? "";
    const fallback =
      current.includes("maxresdefault.jpg")
        ? "sddefault.jpg"
        : current.includes("sddefault.jpg")
          ? "hqdefault.jpg"
          : undefined;
    if (fallback === undefined) {
      thumbnail.remove();
      return;
    }
    thumbnail.src = current.replace(/maxresdefault\.jpg|sddefault\.jpg/u, fallback);
  });
  mediaWrap.append(thumbnail);
}

/** Page-context fetches keep Referer/cookies; Chrome refuses these media URLs from the panel. */
const PREVIEW_PROXY_MAX_BYTES = 262_144;
const PREVIEW_PROXY_TTL_MS = 30_000;
const PREVIEW_PROXY_MAX_ENTRIES = 8;
const proxiedPreviewCache = new BoundedCache<string, string>(
  PREVIEW_PROXY_MAX_ENTRIES,
  PREVIEW_PROXY_TTL_MS,
  (objectUrl) => URL.revokeObjectURL(objectUrl),
);

function needsPagePreviewProxy(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /\.m4s(?:$|[?#])/iu.test(parsed.pathname) ||
      /(^|\.)bilivideo\.com$/iu.test(parsed.hostname) ||
      /(^|\.)doppiocdn\.(?:net|media)$/iu.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

async function fetchPagePreviewBlob(url: string): Promise<string | undefined> {
  if (scripting === undefined || activeTabId === undefined) return undefined;
  const cached = proxiedPreviewCache.get(url);
  if (cached !== undefined) return cached;
  try {
    const results = await scripting.executeScript({
      target: { tabId: activeTabId },
      world: "MAIN",
      func: async (targetUrl: string, maxBytes: number) => {
        try {
          const response = await fetch(targetUrl, {
            headers: { range: `bytes=0-${maxBytes - 1}` },
            credentials: "include",
          });
          if (!response.ok) return undefined;
          const reader = response.body?.getReader();
          if (reader === undefined) return undefined;
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (total < maxBytes) {
            const read = await reader.read();
            if (read.done) break;
            const value = read.value;
            if (value === undefined) break;
            const remaining = maxBytes - total;
            const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
            chunks.push(slice);
            total += slice.byteLength;
            if (total >= maxBytes) break;
          }
          await reader.cancel().catch(() => undefined);
          if (total === 0) return undefined;
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          let binary = "";
          const block = 0x8000;
          for (let index = 0; index < bytes.byteLength; index += block) {
            binary += String.fromCharCode(...bytes.subarray(index, index + block));
          }
          return { data: btoa(binary), type: response.headers.get("content-type") ?? "video/mp4" };
        } catch {
          return undefined;
        }
      },
      args: [url, PREVIEW_PROXY_MAX_BYTES],
    });
    const result = results[0]?.result as { data?: unknown; type?: unknown } | undefined;
    if (result === undefined || typeof result.data !== "string") return undefined;
    const binary = atob(result.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const blob = new Blob([bytes], { type: typeof result.type === "string" ? result.type : "video/mp4" });
    const objectUrl = URL.createObjectURL(blob);
    proxiedPreviewCache.set(url, objectUrl);
    return objectUrl;
  } catch {
    return undefined;
  }
}

function mountHoverPreview(
  mediaWrap: HTMLElement,
  row: PanelSnapshot["media"][number],
  src: string,
  startAtZero = false,
): HTMLVideoElement {
  const preview = document.createElement("video");
  preview.className = "media-preview";
  preview.src = src;
  preview.setAttribute("referrerpolicy", "no-referrer");
  preview.muted = true;
  preview.loop = true;
  preview.playsInline = true;
  preview.autoplay = true;
  if (row.thumbnail !== undefined) preview.poster = row.thumbnail;
  let segmentStart = 0;
  preview.addEventListener("loadedmetadata", () => {
    segmentStart = startAtZero ? 0 : previewStartSeconds(preview.duration);
    if (segmentStart > 0) {
      try {
        preview.currentTime = segmentStart;
      } catch {
        /* seeking unavailable before the first frame; playback will still start */
      }
    }
  });
  preview.addEventListener("timeupdate", () => {
    if (!Number.isFinite(preview.duration)) return;
    if (preview.currentTime >= segmentStart + PREVIEW_WINDOW_SECONDS) {
      try {
        preview.currentTime = segmentStart;
      } catch {
        /* ignore seek failures */
      }
    }
  });
  mediaWrap.append(preview);
  void preview.play().catch(() => undefined);
  return preview;
}

function attachHoverPreview(mediaWrap: HTMLElement, row: PanelSnapshot["media"][number]): void {
  const hoverPreview = row.preview;
  if (hoverPreview === undefined || hoverPreview.length === 0) return;
  let proxyStarted = false;
  let hovered = false;
  const attachProxy = async (): Promise<void> => {
    if (proxyStarted) return;
    proxyStarted = true;
    const objectUrl = await fetchPagePreviewBlob(hoverPreview);
    if (objectUrl === undefined || !hovered) return;
    mediaWrap.querySelector("video.media-preview")?.remove();
    mountHoverPreview(mediaWrap, row, objectUrl, true);
  };
  mediaWrap.addEventListener("mouseenter", () => {
    if (mediaWrap.querySelector("video.media-preview") !== null) return;
    hovered = true;
    proxyStarted = false;
    if (needsPagePreviewProxy(hoverPreview)) {
      void attachProxy();
      return;
    }
    const direct = mountHoverPreview(mediaWrap, row, hoverPreview);
    let settled = false;
    const fallback = (): void => {
      if (settled) return;
      settled = true;
      void attachProxy();
    };
    direct.addEventListener("loadeddata", () => {
      settled = true;
    });
    direct.addEventListener("error", fallback);
    setTimeout(() => {
      if (!settled && hovered && direct.readyState < 2) fallback();
    }, 1500);
  });
  mediaWrap.addEventListener("mouseleave", () => {
    hovered = false;
    mediaWrap.querySelector("video.media-preview")?.remove();
  });
}

window.addEventListener("unload", () => proxiedPreviewCache.clear());
function createSourceControl(row: PanelSnapshot["media"][number]): HTMLElement | undefined {
  const sources = row.sources;
  if (sources === undefined || sources.length === 0) return undefined;
  if (sources.length === 1) {
    const tag = document.createElement("span");
    tag.className = "media-source-tag";
    tag.textContent = sources[0]?.label ?? row.source ?? "FMT";
    tag.title = "Source detected for this media";
    return tag;
  }
  const select = document.createElement("select");
  select.className = "media-source-select";
  select.setAttribute("aria-label", "Download source");
  select.title = "Download source: FMT is the direct format stream; HLS is the segmented manifest";
  for (const source of sources) {
    const option = document.createElement("option");
    option.value = source.value;
    option.textContent = source.label;
    select.append(option);
  }
  const saved = SELECTIONS.get(row.hash)?.source;
  select.value = saved !== undefined && sources.some((source) => source.value === saved) ? saved : "fmt";
  select.addEventListener("change", () => saveSelection(row.hash, { source: select.value }));
  return select;
}

function createSelectors(
  row: PanelSnapshot["media"][number],
  details: HTMLElement,
): { qualitySelect?: HTMLSelectElement; formatSelect: HTMLSelectElement } {
  const saved = SELECTIONS.get(row.hash);

  let qualitySelect: HTMLSelectElement | undefined;
  if (row.variants !== undefined && row.variants.length > 0) {
    qualitySelect = document.createElement("select");
    qualitySelect.className = "media-quality";
    qualitySelect.setAttribute("aria-label", "Quality");
    qualitySelect.title =
      row.variants.length > 1
        ? "Quality: codec, resolution and approximate rendition bitrate"
        : "Quality: only one rendition was detected";
    for (const variant of row.variants) {
      const option = document.createElement("option");
      option.value = String(variant.index);
      option.textContent = variant.label;
      option.title =
        variant.container !== undefined
          ? "Video-only WEBM rendition; its AAC audio is muxed into MKV on download"
          : "Approximate average bitrate of this rendition (not the measured download speed)";
      qualitySelect.append(option);
    }
    qualitySelect.value = saved?.quality ?? qualitySelect.options[0]?.value ?? "0";
    qualitySelect.addEventListener("change", () => saveSelection(row.hash, { quality: qualitySelect?.value ?? "0" }));
    details.append(qualitySelect);
  }

  const formatSelect = document.createElement("select");
  formatSelect.className = "media-quality";
  formatSelect.setAttribute("aria-label", "Output format");
  const selectedVariant = (): { container?: string } | undefined =>
    row.variants?.find((variant) => String(variant.index) === (qualitySelect?.value ?? "0"));
  const autoOption = document.createElement("option");
  autoOption.value = "";
  const syncAutoLabel = (): void => {
    const container = selectedVariant()?.container;
    autoOption.textContent = container !== undefined ? `Auto (${container.toUpperCase()})` : "Auto (native)";
    formatSelect.title =
      container !== undefined
        ? `Output format (Auto = ${container.toUpperCase()}; selected WEBM video has AAC audio)`
        : "Output format (Auto = the selected rendition's native container)";
  };
  syncAutoLabel();
  formatSelect.append(autoOption);
  for (const [value, label] of [
    ["mp4", "MP4"],
    ["mkv", "MKV"],
    ["webm", "WebM"],
    ["mp3", "MP3 (audio)"],
  ] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    formatSelect.append(option);
  }
  formatSelect.value = saved?.format ?? "";
  formatSelect.addEventListener("change", () => saveSelection(row.hash, { format: formatSelect.value }));
  qualitySelect?.addEventListener("change", syncAutoLabel);
  details.append(formatSelect);

  return { ...(qualitySelect !== undefined ? { qualitySelect } : {}), formatSelect };
}

function renderRows(snapshot: PanelSnapshot): void {
  if (!list) return;
  list.textContent = "";
  for (const row of snapshot.media) {
    const item = document.createElement("li");
    item.className = "media-row";

    const mediaWrap = document.createElement("div");
    mediaWrap.className = "media-thumb-wrap";
    createThumbnail(mediaWrap, row);
    attachHoverPreview(mediaWrap, row);
    if (mediaWrap.childElementCount > 0) item.append(mediaWrap);

    const details = document.createElement("div");
    details.className = "media-details";
    const titleLine = document.createElement("div");
    titleLine.className = "media-title-line";
    const sourceControl = createSourceControl(row);
    if (sourceControl !== undefined) titleLine.append(sourceControl);
    const label = document.createElement("span");
    label.className = "media-label";
    label.textContent = row.label;
    titleLine.append(label);
    const meta = document.createElement("span");
    meta.className = "media-meta";
    const bits = [formatLabel(row), formatDuration(row.duration)].filter(
      (bit): bit is string => typeof bit === "string" && bit.length > 0,
    );
    meta.textContent = bits.join(" · ");
    details.append(titleLine, meta);

    const { qualitySelect, formatSelect } = createSelectors(row, details);
    if (row.muxNote !== undefined) {
      const note = document.createElement("span");
      note.className = "media-note";
      note.textContent = row.muxNote;
      details.append(note);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Download";
    button.addEventListener("click", () => {
      button.disabled = true;
      send(MSG.contentToService.DoDownload, {
        tab_id: snapshot.tab_id,
        media_hash: row.hash,
        // A one-option quality select is informational; omit it so the saved/default rendition
        // settings still apply. A real choice (2+ options) overrides them.
        ...(qualitySelect !== undefined && qualitySelect.options.length > 1
          ? { preferred_entry: Number(qualitySelect.value) }
          : {}),
        ...(formatSelect.value !== "" ? { output_format: formatSelect.value } : {}),
        ...(() => {
          const select = titleLine.querySelector("select.media-source-select") as HTMLSelectElement | null;
          return select !== null ? { source: select.value } : {};
        })(),
      });
    });

    item.append(details, button);
    list.append(item);
  }
}

function renderStatus(snapshot: PanelSnapshot): void {
  if (!statusLine || !statusLabel || !statusDetail || !statusTrack || !statusFill) return;
  const presentation = statusPresentation(snapshot.downloading, snapshot.notifications);
  statusLine.dataset.tone = presentation.tone;
  statusLabel.textContent = presentation.label;
  statusDetail.textContent = presentation.detail ?? "";
  if (presentation.percent !== undefined) {
    statusTrack.hidden = false;
    statusTrack.setAttribute("aria-valuenow", String(presentation.percent));
    statusTrack.setAttribute("aria-valuetext", `${presentation.percent}% complete`);
    statusFill.style.width = `${presentation.percent}%`;
  } else {
    statusTrack.hidden = true;
    statusTrack.removeAttribute("aria-valuenow");
    statusTrack.removeAttribute("aria-valuetext");
    statusFill.style.width = "0%";
  }
}

function formatMeasuredBitrate(bitrate: number): string {
  const bytesPerSecond = bitrate / 8;
  return bytesPerSecond >= 1e6
    ? `${(bytesPerSecond / 1e6).toFixed(1)}MB/s`
    : `${Math.max(1, Math.round(bytesPerSecond / 1e3))}KB/s`;
}

async function probePageQuality(tabId: number): Promise<{ width: number; height: number; bitrate?: number } | undefined> {
  if (scripting === undefined) return undefined;
  try {
    const results = await scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        const videos: HTMLVideoElement[] = [];
        const walk = (root: Document | ShadowRoot): void => {
          videos.push(...(Array.from(root.querySelectorAll("video")) as HTMLVideoElement[]));
          for (const element of Array.from(root.querySelectorAll("*"))) {
            const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
            if (shadow !== null && shadow !== undefined) walk(shadow);
          }
        };
        walk(document);
        const video =
          videos.find((candidate) => !candidate.paused && candidate.videoWidth > 0 && candidate.videoHeight > 0) ??
          videos.find((candidate) => candidate.videoWidth > 0 && candidate.videoHeight > 0);
        if (video === undefined) return undefined;
        let bytes = 0;
        try {
          for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
            if (!/\.(?:ts|m4s|mp4|m4a|webm)(?:[?#]|$)/iu.test(entry.name)) continue;
            const size = entry.transferSize > 0 ? entry.transferSize : entry.encodedBodySize;
            if (Number.isFinite(size) && size > 0) bytes += size;
          }
        } catch {
          /* resource timing unavailable */
        }
        const duration = video.duration;
        const bitrate =
          Number.isFinite(duration) && duration > 0 && bytes > 0 ? Math.round((bytes * 8) / duration) : undefined;
        return {
          width: video.videoWidth,
          height: video.videoHeight,
          ...(bitrate !== undefined && bitrate > 0 ? { bitrate } : {}),
        };
      },
    });
    const result = results
      .map((entry) => entry.result as { width?: unknown; height?: unknown; bitrate?: unknown } | undefined)
      .find((entry) => entry !== undefined && typeof entry.width === "number" && typeof entry.height === "number");
    if (result === undefined || typeof result.width !== "number" || typeof result.height !== "number") return undefined;
    console.info("[media-downloader] measured page quality", result.width, result.height, result.bitrate ?? "");
    return {
      width: result.width,
      height: result.height,
      ...(typeof result.bitrate === "number" && result.bitrate > 0 ? { bitrate: result.bitrate } : {}),
    };
  } catch {
    return undefined;
  }
}

function scheduleQualityProbe(snapshot: PanelSnapshot): void {
  const tabId = snapshot.tab_id;
  if (tabId === undefined || scripting === undefined) return;
  if (tabId !== qualityTabId || snapshot.page_url !== qualityPageUrl) {
    qualityTabId = tabId;
    qualityPageUrl = snapshot.page_url;
    measuredQuality = undefined;
    qualityProbedAt = 0;
  }
  if (measuredQuality !== undefined) return;
  if (Date.now() - qualityProbedAt < 5000) return;
  qualityProbedAt = Date.now();
  void probePageQuality(tabId).then((quality) => {
    if (activeTabId !== tabId) return;
    measuredQuality = quality;
    if (lastSnapshot !== undefined) render(lastSnapshot);
  });
}

function enrichRowsWithMeasuredQuality(snapshot: PanelSnapshot): PanelSnapshot {
  const quality = measuredQuality;
  if (quality === undefined) return snapshot;
  return {
    ...snapshot,
    media: snapshot.media.map((row) => {
      const variant = row.variants?.[0];
      if (row.variants?.length !== 1 || variant === undefined) return row;
      const hasResolution = /\d{2,5}[xX]\d{2,5}|\d{3,4}p/u.test(variant.label);
      const hasBitrate = /\d+(?:\.\d+)?(?:KB|MB)\/s/u.test(variant.label);
      if (hasResolution && hasBitrate) return row;
      const parts = [variant.label];
      if (!hasResolution) parts.push(`${quality.width}x${quality.height}`);
      if (!hasBitrate && quality.bitrate !== undefined) parts.push(formatMeasuredBitrate(quality.bitrate));
      return { ...row, variants: [{ ...variant, label: parts.join(" · ") }] };
    }),
  };
}

function dropdownOpen(): boolean {
  return list !== null && document.activeElement instanceof HTMLSelectElement && list.contains(document.activeElement);
}

function flushPending(): void {
  if (pendingSnapshot === undefined || dropdownOpen()) return;
  const snapshot = enrichRowsWithMeasuredQuality(pendingSnapshot);
  pendingSnapshot = undefined;
  lastRowSignature = panelMediaSignature(snapshot.media);
  renderRows(snapshot);
  if (empty) empty.hidden = snapshot.media.length > 0;
  renderStatus(snapshot);
}

function render(snapshot: PanelSnapshot): void {
  lastSnapshot = snapshot;
  activeTabId = snapshot.tab_id;
  scheduleQualityProbe(snapshot);
  const enriched = enrichRowsWithMeasuredQuality(snapshot);
  if (!list || !empty || !statusLine || !pageTitle) return;
  pageTitle.textContent = snapshot.page_title ?? snapshot.page_url ?? "No page";
  const signature = panelMediaSignature(enriched.media);
  if (signature !== lastRowSignature) {
    if (dropdownOpen()) {
      pendingSnapshot = snapshot;
    } else {
      lastRowSignature = signature;
      renderRows(enriched);
      empty.hidden = enriched.media.length > 0;
    }
  } else {
    empty.hidden = enriched.media.length > 0;
  }
  renderStatus(snapshot);
}

list?.addEventListener("focusout", () => {
  // Native dropdown closed: apply any snapshot that arrived while it was open.
  setTimeout(flushPending, 0);
});

runtime?.onMessage.addListener((message: unknown) => {
  const envelope = message as { msg?: { name?: string; data?: unknown }; channel?: number };
  if (envelope?.channel !== Channel.FromServiceToContent) return;
  if (envelope.msg?.name !== REBUILD_MESSAGES.SessionSnapshot) return;
  const snapshot = decode(envelope.msg.data) as PanelSnapshot;
  render(snapshot);
});

send(REBUILD_MESSAGES.RequestSession, null);

// The worker pushes snapshots on changes; this poll covers messages lost while it was asleep.
setInterval(() => send(REBUILD_MESSAGES.RequestSession, null), 2000);
