/**
 * Output container MIME type for the staged download blob.
 *
 * Evidence: E24/E25 (`analysis/evidence/04-download-transfer.md`). The container/codec decision
 * itself lives where the decision is made: `plan/strategies.ts` maps a demuxer to the planned
 * container (`it`/E24-E25) and `plan/build.ts` owns the js-fetch container rule, including the
 * mixed WebM/AAC → MKV exception. This module used to carry a second copy of that truth table
 * (`decideOutput`, `shouldRemux`, `muxerForDemuxer`); no production caller used it and it had
 * already drifted from the shipped rule, so the duplicate was removed and its evidence comment
 * moved next to the rule that actually runs.
 */

/** MIME type for the staged download blob. An empty type lets Chromium replace media extensions. */
export function blobMimeType(extension: string): string {
  switch (extension.toLowerCase()) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "mkv":
      return "video/x-matroska";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "flv":
      return "video/x-flv";
    case "ts":
    case "m2ts":
      return "video/mp2t";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}
