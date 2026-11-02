/**
 * Size advertised by a media URL's query string.
 *
 * Kept apart from the ranged download loop so the page-context relay can validate its own byte
 * count without pulling the transfer layer into the content-script bundle.
 */

/** Size advertised by the query string (`clen=` or `len=`), when present and positive. */
export function declaredSize(url: URL): number | undefined {
  for (const name of ["clen", "len", "size"]) {
    const raw = url.searchParams.get(name);
    if (raw === null) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}
