/**
 * Saving the assembled file and mapping terminal states / worker failures to ending reasons.
 */
import { err, ok, type Result } from "../core/option.js";
import {
  httpFailureReason,
  otherFailureReason,
  userAbortReason,
  type DownloadPlan,
  type EndingReason,
} from "../core/types.js";
import { percentageIncompleteReason } from "./assemble.js";
import { MEDIA_EXTENSIONS } from "./media-extensions.js";

// ---------------------------------------------------------------------------
// Filename and chrome.downloads request
// ---------------------------------------------------------------------------

export type FilenamePlan = Pick<
  DownloadPlan,
  "subdir" | "good_basename" | "extension"
>;

/**
 * Final download filename. `subdir` is already normalised with a trailing slash when non-empty
 * (`materializeRule` / `validateDirectory`), so plain concatenation reproduces the original.
 */
export function composeFilename(plan: FilenamePlan): string {
  const extension = plan.extension.toLowerCase();
  const safeExtension = MEDIA_EXTENSIONS.has(extension) ? extension : "mp4";
  // A page/title can end in .txt (or a CDN can claim text/plain) even when the worker sniffed
  // real media. Never let that become the final extension; strip the misleading suffix first.
  // Direct-file titles can also include the planned extension already; do not append it twice.
  const basename = plan.good_basename
    .replace(/\.(?:txt|html?|json|xml|php|aspx?|jsp|bin)(?=$|[\s._-])/giu, "")
    .replace(new RegExp(`\\.${safeExtension}$`, "iu"), "")
    .trim();
  return `${plan.subdir}${basename.length > 0 ? basename : "video"}.${safeExtension}`;
}

/** Subset of `chrome.downloads.DownloadOptions` used by the recovered call site. */
export interface DownloadRequest {
  url: string;
  filename: string;
  conflictAction: "uniquify";
  saveAs: boolean;
}

export interface BuildDownloadRequestInput {
  blobUrl: string;
  plan: FilenamePlan & Pick<DownloadPlan, "save_as">;
}

/** Exact `chrome.downloads.download` argument shape (E28). */
export function buildDownloadRequest(
  input: BuildDownloadRequestInput,
): DownloadRequest {
  return {
    url: input.blobUrl,
    filename: composeFilename(input.plan),
    conflictAction: "uniquify",
    saveAs: input.plan.save_as,
  };
}

/** Answer for the `downloads.onDeterminingFilename` side-channel (E28). */
export interface DeterminingFilenameAnswer {
  filename: string;
  conflictAction: "uniquify";
}

/** The blob URL download gets the exact composed name, uniquified, via this hook (E28). */
export function buildDeterminingFilenameAnswer(
  filename: string,
): DeterminingFilenameAnswer {
  return { filename, conflictAction: "uniquify" };
}

// ---------------------------------------------------------------------------
// Terminal download state
// ---------------------------------------------------------------------------

export interface DownloadTerminalState {
  /**
   * Settlement snapshot only (`in_progress` excluded): the save wait must never label a
   * still-running browser download as a failure — it keeps waiting on `onChanged` + re-check
   * ticks instead.
   */
  state: "complete" | "interrupted";
  /** `DownloadItem.filename`; present once the browser picked a path. */
  filename?: string;
  /** `DownloadItem.error` (browser-provided string). */
  error?: string;
  /** `onChanged` `error.current`, e.g. `USER_CANCELED`. */
  interruptReason?: string;
}

/** Exact user-visible strings from `Jv` . */
export const DOWNLOAD_ERROR_MESSAGES = {
  notFound: "Error downloading file, ID not found.",
  interrupted: "Download was interrupted.",
  interruptedOnChange: "Download interrupted.",
  unknown: "Unknown download error",
  completedDetailsMissing: "Download completed but file details not found.",
  userCanceled: "Download canceled by the user",
} as const;

/** Reason for a `downloads.search` that returns no item . */
export function downloadNotFoundReason(): EndingReason {
  return otherFailureReason(DOWNLOAD_ERROR_MESSAGES.notFound);
}

/**
 * Map a settled `downloads.search` / `onChanged` snapshot to the recovered result:
 *  - `complete` + filename ⇒ `Ok({path})`;
 *  - interrupted by the user (`interruptReason === "USER_CANCELED"`) ⇒ `Err(userAbort)`;
 *  - other errors keep the browser error string as an other-failure message.
 * `in_progress` snapshots never reach here: settlement waits for `onChanged` / re-checks .
 */
export function mapDownloadTerminalState(
  state: DownloadTerminalState,
): Result<{ path: string }, EndingReason> {
  if (state.state === "complete") {
    if (state.filename) return ok({ path: state.filename });
    return err(
      otherFailureReason(DOWNLOAD_ERROR_MESSAGES.completedDetailsMissing),
    );
  }
  if (state.interruptReason === "USER_CANCELED")
    return err(userAbortReason());
  if (state.error) return err(otherFailureReason(state.error));
  return err(otherFailureReason(DOWNLOAD_ERROR_MESSAGES.interruptedOnChange));
}

// ---------------------------------------------------------------------------
// Worker error strings → ending reasons
// ---------------------------------------------------------------------------

/** Verbatim transfer error strings recovered from the worker (E12/E17/E19/E21). */
export const WORKER_ERROR_MESSAGES = {
  requiredSegmentInvalid: "Required segment was invalid, aborting download.",
  tooManyInvalidSegments: "Too many invalid segments, aborting download.",
  firstSegmentSkipped: "First segment was invalid and skipped, aborting.",
  decryptionFailed: "Decryption failed.",
  network: "Network error",
  read: "Read() error",
  fetchTimeout: "Fetch timeout",
  noBody: "No body",
  timeout: "Timeout",
  unknownFailurePrefix: "Unkown failure - status ",
  expectedLargerSizePrefix: "Expected larger size, but only got ",
  unknownLibavErrorPrefix: "Unknown libav error: ",
  audioHttpMediaFailedPrefix: "Failed to download audio http media ",
} as const;

const KNOWN_OTHER_FAILURES: readonly string[] = [
  WORKER_ERROR_MESSAGES.requiredSegmentInvalid,
  WORKER_ERROR_MESSAGES.tooManyInvalidSegments,
  WORKER_ERROR_MESSAGES.firstSegmentSkipped,
  WORKER_ERROR_MESSAGES.decryptionFailed,
  WORKER_ERROR_MESSAGES.network,
  WORKER_ERROR_MESSAGES.read,
  WORKER_ERROR_MESSAGES.fetchTimeout,
  WORKER_ERROR_MESSAGES.noBody,
  WORKER_ERROR_MESSAGES.timeout,
];

function isEndingReason(value: unknown): value is EndingReason {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { user_abort?: unknown }).user_abort === "boolean"
  );
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/**
 * Map a worker error (throw, `download_error.data.error`, or an already-shaped ending reason) to
 * an `EndingReason`. The classification mirrors the recovered taxonomy: abort and incomplete are
 * distinct, everything else is a message failure; never invent new reason kinds.
 */
export function mapWorkerErrorToReason(error: unknown): EndingReason {
  if (isEndingReason(error)) return error;
  const message = messageOf(error);
  if (message === "User abort") return userAbortReason();
  if (message === "Incomplete percentage.") return percentageIncompleteReason();

  const httpMatch = /^HTTP error\. Status: (\d+)\.$/.exec(message);
  if (httpMatch?.[1])
    return httpFailureReason(Number.parseInt(httpMatch[1], 10));

  if (KNOWN_OTHER_FAILURES.includes(message))
    return otherFailureReason(message);

  const genericMatch = /^Error\. ([\s\S]*)\.$/.exec(message);
  if (genericMatch?.[1]) return otherFailureReason(genericMatch[1]);

  // Everything else keeps the verbatim message: the original put it in `other_failure`.
  return otherFailureReason(message);
}

/**
 * `Ws` text mapping shown by the UI / stored in notification `ending_reason` (E32).
 * Order is significant: abort wins over HTTP failure, which wins over incompleteness.
 */
export function endingReasonToMessage(reason: EndingReason): string {
  if (reason.user_abort) return "User abort";
  if (reason.e4XX_5XX_failure) return `HTTP error. Status: ${reason.status}.`;
  if (reason.percentage_incomplete) return "Incomplete percentage.";
  return `Error. ${reason.message}.`;
}
