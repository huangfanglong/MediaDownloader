/**
 * Manifest parsers and resolution helpers (evidence: analysis/evidence/03-manifest-resolution.md).
 *
 * `hls.ts`  — HLS playlists (master/media/subtitle) and variant/rendition/duration helpers.
 * `dash.ts` — MPD documents (representations, DRM, in-manifest subtitles).
 * `json-manifest.ts` — DASH-in-JSON documents (the `master.json` class), mapped onto the HLS shape.
 */
export * from "./hls.js";
export * from "./dash.js";
export * from "./json-manifest.js";
