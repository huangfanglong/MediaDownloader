import { decodeTaggingParameter } from "./media-hint.js";

export const unescapeJson = (value: string): string =>
  value.replace(/\\u0026/gu, "&").replace(/\\\//gu, "/").replace(/\\"/gu, '"');

/** Asset identity from Instagram's base64 `efg` tag (`xpv_asset_id`/`asset_id`). */
export function instagramAssetKey(rawUrl: string): string | undefined {
  try {
    const decoded = decodeTaggingParameter(new URL(rawUrl));
    if (decoded.length === 0) return undefined;
    const data = JSON.parse(decoded) as Record<string, unknown>;
    const value = data.xpv_asset_id ?? data.asset_id ?? data.video_id ?? data.pk;
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  } catch {
    return undefined;
  }
}
