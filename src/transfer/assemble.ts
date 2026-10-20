/**
 * Segment request descriptors, byte assembly, AES-128 boundary and progress accounting.
 *
 * Evidence: `analysis/evidence/04-download-transfer.md`
 *  - E15 — HLS segment descriptor shape produced by the manifest parser `oe`
 *    (`{url, is_live, sequence_number, duration_s?, encryption?{url,iv}, byte_range?{offset,length},
 *    init?{url, encryption?, byte_range?}}`); relative URIs resolved against the manifest URL;
 *    `carry_get_params` copies the master query string onto segment URLs; default AES IV is the
 *    16-byte big-endian media sequence number (`_n`, download_worker lines 4102-4105);
 *    `#EXT-X-MAP` init bytes are prepended before demux (lines 4027-4050).
 *  - E16 — byte-range segments use `Range: bytes=<offset>-<offset+length-1>` (download_worker `Ft`,
 *    lines 3995-4017).
 *  - E17 — failure policy: `un = 0.35` max invalid-segment ratio; strings
 *    `Required segment was invalid, aborting download.` /
 *    `Too many invalid segments, aborting download.` (lines 3983, 4180-4202).
 *  - E19 — output gates: `< 1000` bytes is a hard failure, duration `< 95 %` or size `< 90 %`
 *    (both with ratio `>= 5`) is `percentage_incomplete` (download_worker lines 2223-2273).
 */
import { err, ok, type Result } from "../core/option.js";
import {
  otherFailureReason,
  type EndingReason,
  type MediaDuration,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Segment model (mirrors the parsed manifest shape, snake_case fields included)
// ---------------------------------------------------------------------------

export interface ByteRange {
  offset: number;
  length: number;
}

/** AES-128 key reference attached to a segment or its init segment. */
export interface SegmentEncryption {
  url: string | URL;
  /** Explicit IV when the playlist supplied one; otherwise derived from the media sequence. */
  iv?: Uint8Array;
}

/** `#EXT-X-MAP` init segment. */
export interface HlsInitSegment {
  url: string | URL;
  byte_range?: ByteRange;
  encryption?: SegmentEncryption;
}

/** One media segment as produced by the manifest parser. */
export interface HlsSegment {
  url: string | URL;
  is_live?: boolean;
  sequence_number?: number;
  duration_s?: number;
  byte_range?: ByteRange;
  encryption?: SegmentEncryption;
  init?: HlsInitSegment;
}

export interface Aes128Reference {
  keyUrl: string;
  iv: Uint8Array;
}

/** One thing the transfer layer must GET, in assembly order. */
export interface SegmentDescriptor {
  url: string;
  /** Value for the `Range` request header, e.g. `bytes=0-1023`. */
  range?: string;
  /** When present the downloaded bytes must be AES-128 decrypted before demux/assembly. */
  aes128?: Aes128Reference;
  /** Marks the `#EXT-X-MAP` request so callers can cache/dedupe it. */
  isInit?: boolean;
}

export interface BuildSegmentRequestsOptions {
  /** Manifest URL used to resolve relative URLs. */
  masterUrl: string | URL;
  /** Copy the master URL's query string onto every media segment URL (`carry_get_params`). */
  carryGetParams: boolean;
  /** Init segment to fetch once before the media segments (falls back to `segments[0].init`). */
  initSegment?: HlsInitSegment;
  /** First media sequence number; used for the default AES IV. Defaults to 0. */
  mediaSequence?: number;
  /**
   * Emit the init descriptor before every segment that carries one instead of once at the front.
   * See the module comment: the original prepends cached init bytes per segment at demux time
   * (E15); a single leading descriptor is the contract for the rebuilt plan model.
   */
  repeatInit?: boolean;
}

// ---------------------------------------------------------------------------
// Descriptor generation
// ---------------------------------------------------------------------------

/** 16-byte big-endian IV: 12 zero bytes then the 32-bit sequence number (`_n`, E15). */
export function defaultIv(sequenceNumber: number): Uint8Array {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequenceNumber >>> 0, false);
  return iv;
}

/** `bytes=<offset>-<offset+length-1>` (`Ft`, E16). */
export function byteRangeHeader(range: ByteRange): string {
  return `bytes=${range.offset}-${range.offset + range.length - 1}`;
}

function resolveUrl(value: string | URL, base: string | URL): string {
  return new URL(typeof value === "string" ? value : value.href, base).href;
}

function applyCarry(
  url: string,
  masterUrl: URL,
  carryGetParams: boolean,
): string {
  if (!carryGetParams || masterUrl.search === "") return url;
  const resolved = new URL(url);
  resolved.search = masterUrl.search;
  return resolved.href;
}

function encryptionOf(
  encryption: SegmentEncryption | undefined,
  master: URL,
  sequenceNumber: number,
): Aes128Reference | undefined {
  if (!encryption) return undefined;
  return {
    keyUrl: resolveUrl(encryption.url, master),
    iv: encryption.iv
      ? new Uint8Array(encryption.iv)
      : defaultIv(sequenceNumber),
  };
}

function descriptorForInit(
  init: HlsInitSegment,
  master: URL,
): SegmentDescriptor {
  const descriptor: SegmentDescriptor = {
    url: resolveUrl(init.url, master),
    isInit: true,
  };
  if (init.byte_range) descriptor.range = byteRangeHeader(init.byte_range);
  const aes128 = encryptionOf(init.encryption, master, 0);
  if (aes128) descriptor.aes128 = aes128;
  return descriptor;
}

/**
 * Turn parsed playlist segments into an ordered GET list:
 * optional init first (unless `repeatInit`), then media segments in playlist order.
 * Relative URLs resolve against `masterUrl`; byte ranges become `Range` values; AES-128
 * references resolve the key URL and derive the default IV when the playlist omitted one.
 */
export function buildSegmentRequests(
  segments: readonly HlsSegment[],
  options: BuildSegmentRequestsOptions,
): SegmentDescriptor[] {
  const master = new URL(
    typeof options.masterUrl === "string"
      ? options.masterUrl
      : options.masterUrl.href,
  );
  const baseSequence = options.mediaSequence ?? 0;
  const descriptors: SegmentDescriptor[] = [];

  const explicitInit = options.initSegment;
  const firstSegmentInit = segments.find(
    (segment) => segment.init !== undefined,
  )?.init;
  const singleInit = explicitInit ?? firstSegmentInit;

  if (singleInit && !options.repeatInit)
    descriptors.push(descriptorForInit(singleInit, master));

  segments.forEach((segment, index) => {
    if (options.repeatInit) {
      const init = segment.init ?? explicitInit;
      if (init) descriptors.push(descriptorForInit(init, master));
    }
    const sequenceNumber = segment.sequence_number ?? baseSequence + index;
    const url = applyCarry(
      resolveUrl(segment.url, master),
      master,
      options.carryGetParams,
    );
    const descriptor: SegmentDescriptor = { url };
    if (segment.byte_range)
      descriptor.range = byteRangeHeader(segment.byte_range);
    const aes128 = encryptionOf(segment.encryption, master, sequenceNumber);
    if (aes128) descriptor.aes128 = aes128;
    descriptors.push(descriptor);
  });

  return descriptors;
}

// ---------------------------------------------------------------------------
// Byte assembly
// ---------------------------------------------------------------------------

/** Total byte length of the chunks (E16/E20 — the original grows a `Uint8Array` per chunk). */
export function totalBytes(chunks: readonly Uint8Array[]): number {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  return total;
}

/** Concatenate in order into one buffer. */
export function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(totalBytes(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Prepend an init segment (`#EXT-X-MAP`) to fetched media bytes (E15). */
export function prependInit(init: Uint8Array, body: Uint8Array): Uint8Array {
  const output = new Uint8Array(init.length + body.length);
  output.set(init, 0);
  output.set(body, init.length);
  return output;
}

// ---------------------------------------------------------------------------
// AES-128 boundary
// ---------------------------------------------------------------------------

/** Request handed to an injected decrypter. */
export interface Aes128Request {
  key: Uint8Array;
  iv: Uint8Array;
  data: Uint8Array;
}

/**
 * AES-128-CBC decryption seam. The original decrypts segments in the worker with WebCrypto
 * (download_worker lines 4018-4050, `Tr`/`Ir`); internals are not replicated here, so callers
 * inject an implementation. No key material is stored in the artifact.
 */
export interface Aes128Decrypter {
  decrypt(request: Aes128Request): Promise<Uint8Array>;
}

/** Default decrypter: the rebuild documents the boundary and refuses to fake encryption. */
export const unsupportedAes128Decrypter: Aes128Decrypter = {
  async decrypt(): Promise<Uint8Array> {
    throw new Error(
      "AES-128 decryption is not implemented (transfer boundary)",
    );
  },
};

// ---------------------------------------------------------------------------
// Progress accounting and completion gates
// ---------------------------------------------------------------------------

/** Max tolerated fraction of invalid segments (`un = 0.35`, E17). */
export const MAX_FAILED_SEGMENT_RATIO = 0.35;
/** Below this many output bytes the transfer failed (`< 1e3`, E19). */
export const MIN_OUTPUT_BYTES = 1_000;
/** Duration completeness threshold (`< 95 %` ⇒ incomplete, E19). */
export const MIN_DURATION_COMPLETION_RATIO = 0.95;
/** Size completeness threshold (`< 90 %` ⇒ incomplete, E19). */
export const MIN_SIZE_COMPLETION_RATIO = 0.9;
/** Percent gates are only trusted from 5 % upward (E19). */
export const MIN_TRUSTED_PERCENT = 5;

export interface PercentPlan {
  duration?: MediaDuration;
  size?: number;
  /** Needed only to disable the percent for `http_strip_audio_jsfetch` (E19). */
  strategy?: string;
}

export interface PercentResult {
  is_known: boolean;
  value: number;
}

/**
 * The worker's percent rule (E19, `U` lines 2192-2209): prefer the muxed output duration when the
 * plan knows a finite duration, else output bytes against the known total size, else unknown.
 * `outputDurationMs` is the value of `ffmpeg_get_out_time_ms`; `fetchedBytes` is the running
 * output size. The strip-audio strategy never trusts percentages in the original.
 */
export function computePercent(
  plan: PercentPlan,
  fetchedBytes: number,
  outputDurationMs?: number,
): PercentResult {
  if (plan.strategy === "http_strip_audio_jsfetch")
    return { is_known: false, value: 0 };
  if (
    typeof plan.duration === "number" &&
    plan.duration > 0 &&
    outputDurationMs !== undefined
  ) {
    return {
      is_known: true,
      value: (100 * outputDurationMs) / (plan.duration * 1000),
    };
  }
  if (typeof plan.size === "number" && plan.size > 0) {
    return { is_known: true, value: (100 * fetchedBytes) / plan.size };
  }
  return { is_known: false, value: 0 };
}

/** `true` when the invalid-segment fraction exceeds the proven 0.35 cap (E17). */
export function isTooManyFailedSegments(
  failedSegments: number,
  totalSegments: number,
): boolean {
  if (totalSegments <= 0) return false;
  return failedSegments / totalSegments > MAX_FAILED_SEGMENT_RATIO;
}

export interface SegmentFailureInput {
  failedSegments: number;
  totalSegments: number;
  /** The first segment of a stream is mandatory; its failure aborts immediately (E17). */
  isFirst: boolean;
}

/**
 * Decide what to do after a demuxed segment is invalid (E17):
 * abort with the mandatory-segment string, abort on too many failures, or skip it.
 */
export function classifySegmentFailure(
  input: SegmentFailureInput,
): Result<"skip", EndingReason> {
  if (input.isFirst)
    return err(
      otherFailureReason("Required segment was invalid, aborting download."),
    );
  if (isTooManyFailedSegments(input.failedSegments, input.totalSegments)) {
    return err(
      otherFailureReason("Too many invalid segments, aborting download."),
    );
  }
  return ok("skip");
}

/** `percentage_incomplete` ending reason (E19). */
export function percentageIncompleteReason(): EndingReason {
  return {
    user_abort: false,
    e4XX_5XX_failure: false,
    percentage_incomplete: true,
    other_failure: false,
  };
}

export interface CompletenessInput {
  outputBytes: number;
  /** Plan duration in seconds, when known. */
  durationS?: number;
  /** Muxed output duration in ms (`ffmpeg_get_out_time_ms`), when known. */
  outputDurationMs?: number;
  /** Plan total size in bytes, when known. */
  sizeBytes?: number;
}

/**
 * Output acceptance gates from `U` (E19): a file under 1000 bytes is a hard failure; otherwise a
 * muxed duration under 95 % of the plan duration (or size under 90 % of the plan size), with at
 * least 5 % progress, ends as `percentage_incomplete`. Returns the output size when acceptable.
 */
export function checkOutputCompleteness(
  input: CompletenessInput,
): Result<{ outputBytes: number }, EndingReason> {
  if (input.outputBytes < MIN_OUTPUT_BYTES) {
    return err(
      otherFailureReason(
        `Expected larger size, but only got ${input.outputBytes} bytes`,
      ),
    );
  }

  let ratio: number | undefined;
  let threshold: number | undefined;
  if (
    typeof input.durationS === "number" &&
    input.durationS > 0 &&
    input.outputDurationMs !== undefined
  ) {
    ratio = input.outputDurationMs / (input.durationS * 1000);
    threshold = MIN_DURATION_COMPLETION_RATIO;
  } else if (typeof input.sizeBytes === "number" && input.sizeBytes > 0) {
    ratio = input.outputBytes / input.sizeBytes;
    threshold = MIN_SIZE_COMPLETION_RATIO;
  }

  if (ratio !== undefined && threshold !== undefined) {
    const percent = ratio * 100;
    if (percent < threshold * 100 && percent >= MIN_TRUSTED_PERCENT) {
      return err(percentageIncompleteReason());
    }
  }

  return ok({ outputBytes: input.outputBytes });
}
