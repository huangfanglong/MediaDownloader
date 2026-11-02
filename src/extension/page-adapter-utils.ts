export const unescapeJson = (value: string): string =>
  value.replace(/\\u0026/gu, "&").replace(/\\\//gu, "/").replace(/\\"/gu, '"');

/** Asset identity from Instagram's base64 `efg` tag; one implementation, shared with the adapter. */
export { instagramAssetKey } from "./media-hint.js";
