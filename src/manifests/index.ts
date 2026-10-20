/**
 * Manifest parsers and resolution helpers (evidence: analysis/evidence/03-manifest-resolution.md).
 *
 * `hls.ts`  — HLS playlists (master/media/subtitle) and variant/rendition/duration helpers.
 * `dash.ts` — MPD documents (representations, DRM, in-manifest subtitles).
 */
export * from "./hls.js";
export * from "./dash.js";
