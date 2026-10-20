/**
 * Download-plan resolution (evidence: analysis/evidence/03-manifest-resolution.md).
 *
 * `strategies.ts` — closed strategy matrix (§3.2), entry/subtitle/rendition selection, previews.
 * `build.ts`      — `DownloadPlan` assembly from a discovered `MediaItem` + `TabMeta`.
 */
export * from "./strategies.js";
export * from "./build.js";
