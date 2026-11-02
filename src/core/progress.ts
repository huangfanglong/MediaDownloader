/**
 * One percentage scale for every download-progress producer.
 *
 * The panel renders `DownloadProgress.percent.value` as a percentage: it clamps to 0..100, rounds
 * and appends "%". The worker already emits 0..100 on both of its paths, but the browser-side
 * ranged path used to emit `offset / total` (0..1), which the panel rounded to 0/1% for the whole
 * transfer. Keeping the formula here makes the unit explicit and gives every producer
 * a single function to call.
 *
 * The shipped worker preferred the muxed output duration (`ffmpeg_get_out_time_ms`) over bytes when
 * both were known (`U`, E19). The rebuilt ffmpeg.wasm runner does not surface a per-job
 * out-duration, so every producer here reports bytes against a known total (native/ranged/runtime
 * relay) or settled segments against the planned segment count (HLS). The duration-based variant
 * was removed with that data source: keeping a second unused formula would only invite drift.
 */

/** The scale the panel renders: 0..100. */
export const PERCENT_MAX = 100;

/** Highest value an in-progress transfer reports; 100 is reserved for finished work. */
export const IN_PROGRESS_PERCENT_MAX = 99;

/** Clamp to 0..max. Non-finite input is ignored rather than rendered as a broken bar. */
export function clampPercent(value: number | undefined, max = PERCENT_MAX): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(max, value));
}

/** Percentage from a completed ratio (0..1). Out-of-range ratios are clamped, not wrapped. */
export function percentFromRatio(ratio: number, max = PERCENT_MAX): number {
  if (!Number.isFinite(ratio)) return 0;
  return clampPercent(ratio * PERCENT_MAX, max) ?? 0;
}

/**
 * Percentage from fetched bytes against a known total.
 *
 * Returns undefined when the total is unknown (or not a usable positive number), so callers can
 * omit the percent and let the panel show downloaded bytes instead.
 */
export function percentFromBytes(
  fetchedBytes: number,
  totalBytes: number | undefined,
  max = PERCENT_MAX,
): number | undefined {
  if (totalBytes === undefined || !Number.isFinite(totalBytes) || totalBytes <= 0) return undefined;
  if (!Number.isFinite(fetchedBytes)) return undefined;
  return percentFromRatio(fetchedBytes / totalBytes, max);
}
