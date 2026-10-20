/**
 * Saving the assembled file and mapping terminal states / worker failures to ending reasons.
 *
 * Evidence: `analysis/evidence/04-download-transfer.md`
 *  - E28 — filename = `subdir + good_basename + "." + extension`; download options
 *    `{url: blobUrl, conflictAction:"uniquify", filename, saveAs}`; `onDeterminingFilename`
 *    re-asserts the same filename with `conflictAction:"uniquify"`
 *    (service__main.js.pretty.js lines 10051-10183).
 *  - E29 — terminal-state strings (lines 10072-10119):
 *    `Error downloading file, ID not found.`, `Download was interrupted.`,
 *    `Download interrupted.`, `Unknown download error`,
 *    `Download completed but file details not found.`, user cancel `"Download canceled by the user"`.
 *  - E32 — `Ws` maps an ending reason to UI text: `User abort` / `HTTP error. Status: <n>.` /
 *    `Incomplete percentage.` / `Error. <message>.` (lines 8883-8890).
 *  - E17/E19 — worker failure strings mapped by {@link mapWorkerErrorToReason}.
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
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4", "m4v", "mkv", "webm", "mov", "flv", "ts",
  "mp3", "m4a", "ogg", "opus", "wav", "m2ts",
]);

export function composeFilename(plan: FilenamePlan): string {
  // A page/title can end in .txt (or a CDN can claim text/plain) even when the worker sniffed
  // real media. Never let that become the final extension; strip the misleading suffix first.
  const basename = plan.good_basename
    .replace(/\.(?:txt|html?|json|xml|php|aspx?|jsp|bin)(?=$|[\s._-])/giu, "")
    .trim();
  const extension = plan.extension.toLowerCase();
  const safeExtension = MEDIA_EXTENSIONS.has(extension) ? extension : "mp4";
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

export type DownloadStateName = "in_progress" | "interrupted" | "complete";

export interface DownloadTerminalState {
  state: DownloadStateName;
  /** `DownloadItem.filename`; present once the browser picked a path. */
  filename?: string;
  /** `DownloadItem.error` (browser-provided string). */
  error?: string;
  /** `onChanged` `error.current`, e.g. `USER_CANCELED`. */
  interruptReason?: string;
}

/** Exact user-visible strings from `Jv` (E29). */
export const DOWNLOAD_ERROR_MESSAGES = {
  notFound: "Error downloading file, ID not found.",
  interrupted: "Download was interrupted.",
  interruptedOnChange: "Download interrupted.",
  unknown: "Unknown download error",
  completedDetailsMissing: "Download completed but file details not found.",
  userCanceled: "Download canceled by the user",
} as const;

/** Reason for a `downloads.search` that returns no item (E29). */
export function downloadNotFoundReason(): EndingReason {
  return otherFailureReason(DOWNLOAD_ERROR_MESSAGES.notFound);
}

/**
 * Map a `downloads.search` / `onChanged` snapshot to the recovered result:
 *  - `complete` + filename ⇒ `Ok({path})`;
 *  - interrupted by the user (`interruptReason === "USER_CANCELED"`) ⇒ `Err(userAbort)`;
 *  - other errors keep the browser error string as an other-failure message.
 * `in_progress` is not a terminal state; callers wait for `onChanged` instead (E29).
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
  if (state.state === "interrupted") {
    if (state.interruptReason === "USER_CANCELED")
      return err(userAbortReason());
    if (state.error) return err(otherFailureReason(state.error));
    return err(otherFailureReason(DOWNLOAD_ERROR_MESSAGES.interruptedOnChange));
  }
  return err(otherFailureReason("Download still in progress"));
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
