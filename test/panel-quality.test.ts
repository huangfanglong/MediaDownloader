// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  QUALITY_PROBE_INTERVAL_MS,
  QUALITY_PROBE_MAX_ATTEMPTS,
  QualityProbeTracker,
  collectPageQuality,
} from "../src/extension/panel-quality.js";

/** jsdom has no media pipeline: give the element the properties the page probe reads. */
function video(width: number, height: number, paused: boolean): HTMLVideoElement {
  const element = document.createElement("video");
  Object.defineProperty(element, "videoWidth", { configurable: true, value: width });
  Object.defineProperty(element, "videoHeight", { configurable: true, value: height });
  Object.defineProperty(element, "paused", { configurable: true, value: paused });
  Object.defineProperty(element, "duration", { configurable: true, value: 60 });
  return element;
}

describe("page quality probe", () => {
  it("prefers a playing video over a paused one in the light DOM", () => {
    document.body.innerHTML = "";
    document.body.append(video(640, 360, true), video(1920, 1080, false));
    expect(collectPageQuality(document)).toEqual({ width: 1920, height: 1080 });
  });

  it("falls back to a paused video's resolution instead of giving up", () => {
    document.body.innerHTML = "";
    document.body.append(video(1280, 720, true));
    expect(collectPageQuality(document)).toEqual({ width: 1280, height: 720 });
  });

  it("reads a player that lives inside an open shadow root", () => {
    document.body.innerHTML = "";
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(video(1920, 1080, false));
    document.body.append(host);
    expect(collectPageQuality(document)).toEqual({ width: 1920, height: 1080 });
  });

  it("still prefers a playing shadow-root video over a paused light-DOM one", () => {
    document.body.innerHTML = "";
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).append(video(1920, 1080, false));
    document.body.append(video(640, 360, true), host);
    expect(collectPageQuality(document)).toEqual({ width: 1920, height: 1080 });
  });

  it("bounds the shadow-root walk instead of traversing a huge DOM", () => {
    document.body.innerHTML = "";
    const filler = Array.from({ length: 20 }, () => document.createElement("div"));
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).append(video(1920, 1080, false));
    document.body.append(...filler, host);
    // The host is beyond the element budget, so the fallback walk must stop before reaching it.
    expect(collectPageQuality(document, 5, 8)).toBeUndefined();
    expect(collectPageQuality(document, 100, 8)).toEqual({ width: 1920, height: 1080 });
  });

  it("bounds how deep nested shadow roots are searched", () => {
    document.body.innerHTML = "";
    const outerHost = document.createElement("div");
    const outerShadow = outerHost.attachShadow({ mode: "open" });
    const innerHost = document.createElement("div");
    const innerShadow = innerHost.attachShadow({ mode: "open" });
    innerShadow.append(video(1920, 1080, false));
    outerShadow.append(innerHost);
    document.body.append(outerHost);
    // One shadow level is searched; the nested root needs a second level, which is not allowed.
    expect(collectPageQuality(document, 10_000, 0)).toBeUndefined();
    expect(collectPageQuality(document, 10_000, 1)).toEqual({ width: 1920, height: 1080 });
  });

  it("returns undefined when the frame has no video", () => {
    document.body.innerHTML = "<div>no player here</div>";
    expect(collectPageQuality(document)).toBeUndefined();
  });
});

describe("quality probe retry policy", () => {
  const snapshot = (tabId: number, pageUrl: string) => ({ tab_id: tabId, page_url: pageUrl });

  it("probes immediately, then at most every interval and only up to the attempt budget", () => {
    const tracker = new QualityProbeTracker();
    const page = snapshot(7, "https://site.test/watch");
    expect(tracker.shouldProbe(page, 1_000)).toBe(true);
    expect(tracker.shouldProbe(page, 1_000 + QUALITY_PROBE_INTERVAL_MS - 1)).toBe(false);
    expect(tracker.shouldProbe(page, 1_000 + QUALITY_PROBE_INTERVAL_MS)).toBe(true);
    expect(tracker.shouldProbe(page, 1_000 + 2 * QUALITY_PROBE_INTERVAL_MS)).toBe(true);
    // The budget is spent: no more page walks for this page, however long the panel stays open.
    expect(tracker.shouldProbe(page, 1_000 + 3 * QUALITY_PROBE_INTERVAL_MS)).toBe(false);
    expect(tracker.shouldProbe(page, 1_000 + 100 * QUALITY_PROBE_INTERVAL_MS)).toBe(false);
    expect(QUALITY_PROBE_MAX_ATTEMPTS).toBe(3);
  });

  it("stops probing once a measurement arrived", () => {
    const tracker = new QualityProbeTracker();
    const page = snapshot(7, "https://site.test/watch");
    expect(tracker.shouldProbe(page, 0)).toBe(true);
    expect(tracker.resolve(7, { width: 1920, height: 1080 })).toBe(true);
    expect(tracker.measuredQuality).toEqual({ width: 1920, height: 1080 });
    expect(tracker.shouldProbe(page, 60_000)).toBe(false);
  });

  it("does not probe without a tab, and ignores results for another tab", () => {
    const tracker = new QualityProbeTracker();
    expect(tracker.shouldProbe({ page_url: "https://site.test/watch" }, 0)).toBe(false);
    expect(tracker.shouldProbe(snapshot(7, "https://site.test/watch"), 0)).toBe(true);
    expect(tracker.resolve(8, { width: 640, height: 360 })).toBe(false);
    expect(tracker.measuredQuality).toBeUndefined();
    expect(tracker.resolve(7, undefined)).toBe(false);
    expect(tracker.measuredQuality).toBeUndefined();
  });

  it("gives a changed tab or page a fresh attempt budget and drops the old measurement", () => {
    const tracker = new QualityProbeTracker();
    expect(tracker.shouldProbe(snapshot(7, "https://site.test/a"), 0)).toBe(true);
    expect(tracker.resolve(7, { width: 1920, height: 1080 })).toBe(true);
    expect(tracker.shouldProbe(snapshot(8, "https://site.test/a"), 1)).toBe(true);
    expect(tracker.measuredQuality).toBeUndefined();
    expect(tracker.shouldProbe(snapshot(8, "https://site.test/b"), 2)).toBe(true);
    // Exhaust the retries, then a navigation re-arms them.
    expect(tracker.shouldProbe(snapshot(8, "https://site.test/b"), 2 + QUALITY_PROBE_INTERVAL_MS)).toBe(true);
    expect(tracker.shouldProbe(snapshot(8, "https://site.test/b"), 2 + 2 * QUALITY_PROBE_INTERVAL_MS)).toBe(true);
    expect(tracker.shouldProbe(snapshot(8, "https://site.test/b"), 2 + 3 * QUALITY_PROBE_INTERVAL_MS)).toBe(false);
    expect(tracker.shouldProbe(snapshot(8, "https://site.test/c"), 3 + 3 * QUALITY_PROBE_INTERVAL_MS)).toBe(true);
  });
});
