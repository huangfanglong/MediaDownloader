/**
 * Byte ceilings for response bodies the download worker holds in memory.
 *
 * Manifests have been capped since the first hardening round (`MAX_HLS_MANIFEST_BYTES` /
 * `MAX_MPD_BYTES`, 8 MiB) because a playlist is untrusted input. Segment bodies carry exactly the
 * same trust level — the playlist URI decides them — yet the worker passed no `maxBytes` to
 * `fetchBytes` for them, so a segment URL naming a multi-gigabyte (or endless) resource was
 * buffered whole, four times over (segment concurrency), with no ceiling in the path.
 *
 * `fetchBytes` already refuses a body past `maxBytes`; these are the worker's policy values for
 * doing so. They are injected through `DownloadWorkerDeps.limits` so tests can exercise the same
 * boundaries without multi-megabyte payloads; production uses `DEFAULT_TRANSFER_LIMITS`.
 */

export interface TransferLimits {
  /**
   * Largest single segment (or init segment) body the worker will retain.
   *
   * 128 MiB covers the largest legitimate HLS segments in evidence (10 s of 4K video at
   * ~100 Mbit/s ≈ 125 MB) and stays in the same order of magnitude as the byte budget the app
   * already accepts for FFmpeg input (`MAX_FFMPEG_BYTE_INPUT_BYTES`, 600 MiB).
   */
  maxSegmentBytes: number;
  /**
   * Largest amount of completed-but-unwritten segment data held while waiting for the write head.
   *
   * Staged assembly can only flush the contiguous prefix of the playlist, so out-of-order
   * completions accumulate until the missing head segment arrives. Without a budget that retention
   * grows with playlist length (not concurrency), which is what makes a single stalled segment a
   * memory-DoS. Workers wait for a flush before fetching more once this budget is exceeded.
   */
  maxRetainedSegmentBytes: number;
  /**
   * Largest whole track the in-memory mux fallback will fetch (`fetchSourceBytes`).
   *
   * Matches `MAX_ADAPTIVE_TRACK_BYTES`, the ceiling the YouTube adapter already applies to adaptive
   * renditions.
   */
  maxTrackBytes: number;
  /**
   * Largest playlist the no-staging fallback will buffer before refusing.
   *
   * That path keeps every segment in RAM and then muxes (another 3-4x output), so it must fail
   * rather than grow without bound. It is unreachable in production (FFmpeg is always injected).
   */
  maxUnstagedHlsBytes: number;
}

export const DEFAULT_TRANSFER_LIMITS: TransferLimits = Object.freeze({
  maxSegmentBytes: 128 * 1024 * 1024,
  maxRetainedSegmentBytes: 128 * 1024 * 1024,
  maxTrackBytes: 512 * 1024 * 1024,
  maxUnstagedHlsBytes: 512 * 1024 * 1024,
});

/** Merge caller overrides over the defaults (used by the worker's injected dependencies). */
export function resolveTransferLimits(
  overrides?: Partial<TransferLimits>,
): TransferLimits {
  return { ...DEFAULT_TRANSFER_LIMITS, ...overrides };
}
