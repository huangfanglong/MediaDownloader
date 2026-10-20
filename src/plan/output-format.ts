/** Output container/audio choices offered by the panel `Format` select. */
import type { DownloadPlan } from "../core/types.js";

export type OutputFormat = "mp4" | "mkv" | "webm" | "mp3";

const OUTPUT_FORMATS: readonly OutputFormat[] = ["mp4", "mkv", "webm", "mp3"];

/** Validate an untrusted panel value. */
export function normalizeOutputFormat(raw: unknown): OutputFormat | undefined {
  return typeof raw === "string" && (OUTPUT_FORMATS as readonly string[]).includes(raw)
    ? (raw as OutputFormat)
    : undefined;
}

/** Ask the worker for a specific container/audio target (keeps the original plan immutable). */
export function applyOutputFormat(plan: DownloadPlan, format: OutputFormat): DownloadPlan {
  return { ...plan, extension: format, muxer: format, output_format: format };
}
