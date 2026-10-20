/**
 * Verbose diagnostics are off in release builds. Flip DEBUG_LOGS locally when a live
 * investigation needs the per-detection / per-hint stream back.
 */
const DEBUG_LOGS = false;

export function debugInfo(...data: unknown[]): void {
  if (DEBUG_LOGS) console.info("[media-downloader]", ...data);
}
