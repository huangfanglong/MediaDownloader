/**
 * The service worker's fetch adapter: hand the browser the whole request instead of picking
 * fields. Every `FetchInitLike` field a caller sets (e.g. the manifest collector's
 * `redirect: "error"`) must survive it; a field picker silently drops each one a future caller
 * begins to use. Forwarding the init object is also what platform fetch does best — it ignores
 * anything it doesn't understand (like the transfer layer's `range`, converted to a header
 * before this adapter is reached).
 */
import type { FetchLike } from "../transfer/fetch.js";

export const fetchAdapter: FetchLike = async (url, init) =>
  (await fetch(url, init as RequestInit)) as never;
