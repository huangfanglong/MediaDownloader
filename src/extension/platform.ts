/**
 * Runtime platform facts the loop cares about.
 *
 * Evidence: the original branches on a browser flag (`Ue`) derived from
 * `navigator.userAgent`/`browser` presence, and on a Firefox flag (`qe`) for a few behaviours;
 * Chromium additionally gets `extraHeaders` on webRequest listeners and `offscreen` documents.
 * Reproduced as data so the rest of the code can stay platform-agnostic and testable.
 */

export type Platform = "chromium" | "firefox";

export interface PlatformProfile {
  readonly platform: Platform;
  /** Chromium requires `extraHeaders` in extraInfoSpec to see Cookie/Set-Cookie. */
  readonly needsExtraHeaders: boolean;
  /** Offscreen documents exist on Chromium (Firefox uses a different background model). */
  readonly supportsOffscreenDocuments: boolean;
  /** Side panel API support. */
  readonly supportsSidePanel: boolean;
}

export function detectPlatform(hints: {
  hasBrowserNamespace: boolean;
  userAgent: string;
  hasSidePanel: boolean;
}): PlatformProfile {
  const platform: Platform = /firefox|fxios/i.test(hints.userAgent) || hints.hasBrowserNamespace ? "firefox" : "chromium";
  return {
    platform,
    needsExtraHeaders: platform === "chromium",
    supportsOffscreenDocuments: platform === "chromium",
    supportsSidePanel: hints.hasSidePanel,
  };
}

/**
 * Resource types subscribed for media sniffing. `main_frame`/`sub_frame` are included because
 * direct file navigations are media too; `image`, `font`, `stylesheet`, `script` are excluded so
 * thumbnails and page assets never become download candidates.
 * Evidence: 02-detection-pipeline.md D-constants (subscribed resource types).
 */
export const SNIFF_RESOURCE_TYPES = [
  "xmlhttprequest",
  "media",
  "main_frame",
  "sub_frame",
  "other",
] as const;
