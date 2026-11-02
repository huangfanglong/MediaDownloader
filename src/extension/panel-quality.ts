/**
 * Page-context quality probe and the retry policy that drives it.
 *
 * `collectPageQuality` is handed to `chrome.scripting.executeScript({ func })`, so it is
 * serialized and runs in the page's MAIN world: it may only reference globals and values defined
 * inside itself (no module imports, no constants from this file's scope).
 */

export interface PageQuality {
  width: number;
  height: number;
  bitrate?: number;
}

/** How often a page without a measurable video is retried, and how often before giving up. */
export const QUALITY_PROBE_INTERVAL_MS = 5_000;
export const QUALITY_PROBE_MAX_ATTEMPTS = 3;

/**
 * Collect the playing video's resolution (and an approximate bitrate) from one frame.
 *
 * The light DOM covers every normal player with one native selector. Open shadow roots are only
 * walked when the light DOM has no playing video, and that walk is bounded, so a pathological or
 * hostile page cannot turn a quality label into a full-DOM traversal on every probe. The shadow
 * budget is a literal default (not a module constant): Chrome serializes this function into the
 * page, where module scope does not exist.
 */
export function collectPageQuality(
  doc: Document = document,
  maxShadowElements: number = 10_000,
  maxShadowDepth: number = 8,
): PageQuality | undefined {
  const usable = (candidate: HTMLVideoElement): boolean =>
    candidate.videoWidth > 0 && candidate.videoHeight > 0;

  const lightVideos = Array.from(doc.querySelectorAll("video")) as HTMLVideoElement[];
  let video: HTMLVideoElement | undefined = lightVideos.find(
    (candidate) => usable(candidate) && !candidate.paused,
  );
  if (video === undefined) {
    // No playing light-DOM video: a bounded walk over open shadow roots is the fallback.
    const shadowVideos: HTMLVideoElement[] = [];
    let visited = 0;
    const walk = (root: Document | ShadowRoot, depth: number): void => {
      if (visited >= maxShadowElements || depth > maxShadowDepth) return;
      for (const element of Array.from(root.querySelectorAll("*"))) {
        if (visited >= maxShadowElements) return;
        visited += 1;
        const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadow === null || shadow === undefined) continue;
        shadowVideos.push(...(Array.from(shadow.querySelectorAll("video")) as HTMLVideoElement[]));
        walk(shadow, depth + 1);
      }
    };
    walk(doc, 0);
    video =
      shadowVideos.find((candidate) => usable(candidate) && !candidate.paused) ??
      shadowVideos.find((candidate) => usable(candidate)) ??
      lightVideos.find((candidate) => usable(candidate));
  }
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
  const bitrate = Number.isFinite(duration) && duration > 0 && bytes > 0 ? Math.round((bytes * 8) / duration) : undefined;
  return {
    width: video.videoWidth,
    height: video.videoHeight,
    ...(bitrate !== undefined && bitrate > 0 ? { bitrate } : {}),
  };
}

/**
 * When to probe, and what the last successful probe measured.
 *
 * The panel renders on every snapshot; without a budget a page that never yields a usable video
 * (cross-origin player, audio-only page) would be re-walked every interval for as long as the
 * panel stays open. A page gets a fixed number of attempts, reset when the tab or page changes.
 */
export class QualityProbeTracker {
  private tabId: number | undefined;
  private pageUrl: string | undefined;
  private attempts = 0;
  private lastAttemptAt = 0;
  private measured: PageQuality | undefined;

  /** True when the panel should run another probe for this snapshot now. */
  shouldProbe(snapshot: { tab_id?: number; page_url?: string }, now: number): boolean {
    const tabId = snapshot.tab_id;
    if (tabId === undefined) return false;
    if (tabId !== this.tabId || snapshot.page_url !== this.pageUrl) {
      this.tabId = tabId;
      this.pageUrl = snapshot.page_url;
      this.attempts = 0;
      this.lastAttemptAt = 0;
      this.measured = undefined;
    }
    if (this.measured !== undefined) return false;
    if (this.attempts >= QUALITY_PROBE_MAX_ATTEMPTS) return false;
    if (this.attempts > 0 && now - this.lastAttemptAt < QUALITY_PROBE_INTERVAL_MS) return false;
    this.attempts += 1;
    this.lastAttemptAt = now;
    return true;
  }

  /** Quality measured on the current page, once a probe has succeeded. */
  get measuredQuality(): PageQuality | undefined {
    return this.measured;
  }

  /** Record a probe outcome; true when a measurement was accepted and the rows should re-render. */
  resolve(tabId: number, quality: PageQuality | undefined): boolean {
    if (tabId !== this.tabId || quality === undefined) return false;
    this.measured = quality;
    return true;
  }
}
