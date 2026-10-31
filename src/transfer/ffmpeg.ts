/**
 * ffmpeg.wasm runner (single-thread @ffmpeg/core) used for YouTube 1080p+/4K merges and the
 * MP4/MKV/WebM/MP3 output options.
 *
 * Verified in a sandboxed Brave extension dedicated-worker context (no cross-origin isolation
 * needed): wrapper + core load from chrome-extension:// URLs, `classWorkerURL` must point at the
 * vendored wrapper worker, and the extension-page CSP needs `'wasm-unsafe-eval'`.
 * Licensing: the bundled core is GPL-2.0-or-later (GPLv3-compatible; see docs/THIRD_PARTY.md).
 */
import { FFmpeg, FFFSType } from "@ffmpeg/ffmpeg";

export type FfmpegContainer = "mp4" | "mkv" | "webm" | "mp3";

export type FfmpegInput =
  | { name: string; bytes: Uint8Array; file?: never }
  | { name: string; file: File; bytes?: never };

export interface FfmpegJob {
  inputs: FfmpegInput[];
  args: string[];
  outputName: string;
  /** Estimated size of the produced file, when the caller knows it (copy/remux jobs). */
  expectedOutputBytes?: number;
}

/** Minimal OPFS staging root the runner uses to verify a streamed output exists. */
export interface OpfsStagingRoot {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<{
    getFileHandle(name: string): Promise<{ getFile(): Promise<File> }>;
  }>;
}

/** Destination for an FFmpeg output that the worker writes straight into OPFS. */
export interface FfmpegStagingTarget {
  root: OpfsStagingRoot;
  directory: string;
  filename: string;
}

/** Marker the worker recognises in the output argument to switch to OPFS output. */
export const FFMPEG_OUTPUT_MARKER = "/media-downloader-out/";

/** Thrown when the worker could not put the output into OPFS; the caller falls back to memory. */
export class FfmpegStagingUnavailableError extends Error {
  constructor() {
    super("ffmpeg output staging is unavailable");
    this.name = "FfmpegStagingUnavailableError";
  }
}

/** Injectable seam so the download worker can be unit-tested without WASM. */
export interface FfmpegRunnerLike {
  run(job: FfmpegJob): Promise<Uint8Array>;
  /** Optional streaming output: the worker writes directly into OPFS staging. */
  runToStaging?(job: FfmpegJob, target: FfmpegStagingTarget): Promise<void>;
}

/**
 * Default budget for bytes that must be copied into FFmpeg's memory filesystem.
 *
 * Byte inputs are resident roughly twice while they cross the worker boundary and land in
 * MEMFS, so a byte-input job peaks at roughly three times its combined input size (measured
 * against the shipped core: 620 MiB in → ~1.9 GiB peak; 1241 MiB in → ~3.85 GiB peak).
 * 600 MiB keeps that peak near 1.9 GiB, which a browser worker can still hold. File inputs
 * are mounted through WORKERFS and are not counted. Tests inject a smaller budget.
 *
 * Staged inputs remove the input copy, but FFmpeg still writes its output to MEMFS and the
 * wrapper copies that output back, so very large outputs remain output-memory bound. Streaming
 * the output to OPFS is the next step; until then this budget stays the safety net.
 */
export const MAX_FFMPEG_BYTE_INPUT_BYTES = 600 * 1024 * 1024;

/** Thrown before anything is handed to the wasm core when byte inputs exceed the budget. */
export class FfmpegInputTooLargeError extends Error {
  constructor(
    readonly byteLength: number,
    readonly limitBytes: number,
  ) {
    super("The downloaded media is too large to process in the browser; choose Auto or a lower quality");
    this.name = "FfmpegInputTooLargeError";
  }
}

/**
 * Default ceiling for a whole output pulled back into the caller's memory.
 *
 * Without a streamed output the file exists twice (MEMFS copy + read-back copy) before it is
 * staged, so a 1 GiB output peaks around 2 GiB. Staged/streamed outputs are budgeted separately.
 */
export const MAX_FFMPEG_OUTPUT_BYTES = 1024 * 1024 * 1024;

/** Thrown before FFmpeg runs when the produced file would not fit the memory budget. */
export class FfmpegOutputTooLargeError extends Error {
  constructor(
    readonly expectedBytes: number,
    readonly limitBytes: number,
  ) {
    super("The produced file would be too large to keep in the browser; choose Auto or a lower quality");
    this.name = "FfmpegOutputTooLargeError";
  }
}

/** ffmpeg args for merging a separate video + audio track into one container. */
export function mergeArgs(
  videoName: string,
  audioName: string,
  outputName: string,
  container: Exclude<FfmpegContainer, "mp3">,
  transcode: boolean,
): string[] {
  const args = ["-hide_banner", "-y", "-i", videoName, "-i", audioName, "-map", "0:v:0", "-map", "1:a:0"];
  if (!transcode) return [...args, "-c", "copy", outputName];
  if (container === "webm") {
    return [...args, "-c:v", "libvpx", "-b:v", "2M", "-c:a", "libopus", outputName];
  }
  return [...args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "160k", outputName];
}

/** ffmpeg args for extracting MP3 audio from a muxed/audio input. */
export function mp3Args(inputName: string, outputName: string): string[] {
  return ["-hide_banner", "-y", "-i", inputName, "-vn", "-c:a", "libmp3lame", "-q:a", "2", outputName];
}

/** ffmpeg args for re-containerising/muxing one input file. */
export function convertArgs(
  inputName: string,
  outputName: string,
  container: FfmpegContainer,
  transcode: boolean,
): string[] {
  const args = ["-hide_banner", "-y", "-i", inputName];
  if (!transcode) return [...args, "-map", "0", "-c", "copy", outputName];
  if (container === "webm") {
    return [...args, "-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "libvpx", "-b:v", "2M", "-c:a", "libopus", outputName];
  }
  return [
    ...args,
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    outputName,
  ];
}

/** Location of the vendored files (`vendor/ffmpeg/*`, `vendor/core/*`) from a worker page. */
export function defaultVendorBase(): string {
  const href = (globalThis as { location?: { href?: string } }).location?.href ?? "";
  if (href.length === 0) throw new Error("ffmpeg: cannot resolve vendor base outside a document/worker");
  return new URL("./vendor/", href).href;
}

export class FfmpegRunner implements FfmpegRunnerLike {
  private instance: FFmpeg | undefined;
  private loading: Promise<FFmpeg> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly vendorBase: string = defaultVendorBase(),
    private readonly onLog?: (line: string) => void,
    private readonly maxByteInputBytes: number = MAX_FFMPEG_BYTE_INPUT_BYTES,
    private readonly maxMemoryOutputBytes: number = MAX_FFMPEG_OUTPUT_BYTES,
  ) {}

  private async ensureLoaded(): Promise<FFmpeg> {
    if (this.instance !== undefined && this.instance.loaded) return this.instance;
    this.loading ??= (async () => {
      const ffmpeg = new FFmpeg();
      if (this.onLog !== undefined) {
        ffmpeg.on("log", ({ message }) => this.onLog?.(message));
      }
      const base = this.vendorBase.replace(/\/?$/u, "/");
      const started = Date.now();
      await ffmpeg.load({
        classWorkerURL: new URL("ffmpeg/worker.js", base).href,
        coreURL: new URL("core/ffmpeg-core.js", base).href,
        wasmURL: new URL("core/ffmpeg-core.wasm", base).href,
      });
      this.instance = ffmpeg;
      console.info("[media-downloader] ffmpeg core ready in", Date.now() - started, "ms");
      return ffmpeg;
    })();
    return this.loading;
  }

  run(job: FfmpegJob): Promise<Uint8Array> {
    const result = this.queue.then(() => this.runExclusive(job));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Run an FFmpeg job whose output is written straight into an OPFS staging file. */
  async runToStaging(job: FfmpegJob, target: FfmpegStagingTarget): Promise<void> {
    const byteLength = job.inputs.reduce((total, input) => total + (input.bytes?.byteLength ?? 0), 0);
    if (byteLength > this.maxByteInputBytes) throw new FfmpegInputTooLargeError(byteLength, this.maxByteInputBytes);
    const ffmpeg = await this.ensureLoaded();
    const fileInputs = job.inputs.filter(
      (input): input is Extract<FfmpegInput, { file: File }> => input.file !== undefined,
    );
    const byteInputs = job.inputs.filter(
      (input): input is Extract<FfmpegInput, { bytes: Uint8Array }> => input.bytes !== undefined,
    );
    const mountPoint = "/media-downloader-input";
    let mounted = false;
    let mountDirCreated = false;
    const marker = `${FFMPEG_OUTPUT_MARKER}${target.directory}/${target.filename}`;
    const args = job.args.map((arg) => (arg === job.outputName ? marker : arg));
    try {
      if (fileInputs.length > 0) {
        await ffmpeg.createDir(mountPoint).catch(() => undefined);
        mountDirCreated = true;
        const mountedOk = await ffmpeg.mount(FFFSType.WORKERFS, {
          blobs: fileInputs.map((input) => ({ name: input.name, data: input.file })),
        }, mountPoint);
        if (!mountedOk) throw new Error("ffmpeg WORKERFS is unavailable");
        mounted = true;
      }
      for (const input of byteInputs) await ffmpeg.writeFile(input.name, input.bytes);
      const mountedPaths = new Map(fileInputs.map((input) => [input.name, `${mountPoint}/${input.name}`]));
      const exitCode = await ffmpeg.exec(args.map((arg) => mountedPaths.get(arg) ?? arg));
      if (exitCode !== 0) throw new Error(`ffmpeg exited with ${exitCode}`);
    } finally {
      for (const input of byteInputs) await ffmpeg.deleteFile(input.name).catch(() => undefined);
      if (mounted) await ffmpeg.unmount(mountPoint).catch(() => undefined);
      if (mountDirCreated) await ffmpeg.deleteDir(mountPoint).catch(() => undefined);
    }
    const directory = await target.root.getDirectoryHandle(target.directory, { create: true });
    let file: File | undefined;
    try {
      file = await (await directory.getFileHandle(target.filename)).getFile();
    } catch {
      file = undefined;
    }
    if (file === undefined || file.size === 0) {
      await ffmpeg.deleteFile(`/${target.filename}`).catch(() => undefined);
      throw new FfmpegStagingUnavailableError();
    }
  }

  private async runExclusive(job: FfmpegJob): Promise<Uint8Array> {
    // Byte inputs are the only ones that occupy FFmpeg's memory filesystem; refuse an
    // oversized job here so every caller gets the same budget, not just the paths that
    // remembered to check.
    const byteLength = job.inputs.reduce((total, input) => total + (input.bytes?.byteLength ?? 0), 0);
    if (byteLength > this.maxByteInputBytes) {
      throw new FfmpegInputTooLargeError(byteLength, this.maxByteInputBytes);
    }
    if (job.expectedOutputBytes !== undefined && job.expectedOutputBytes > this.maxMemoryOutputBytes) {
      throw new FfmpegOutputTooLargeError(job.expectedOutputBytes, this.maxMemoryOutputBytes);
    }
    const ffmpeg = await this.ensureLoaded();
    const fileInputs = job.inputs.filter(
      (input): input is Extract<FfmpegInput, { file: File }> => input.file !== undefined,
    );
    const byteInputs = job.inputs.filter(
      (input): input is Extract<FfmpegInput, { bytes: Uint8Array }> => input.bytes !== undefined,
    );
    const mountPoint = "/media-downloader-input";
    let mountDirCreated = false;
    let mounted = false;
    try {
      if (fileInputs.length > 0) {
        await ffmpeg.createDir(mountPoint).catch(() => undefined);
        mountDirCreated = true;
        const mountedOk = await ffmpeg.mount(FFFSType.WORKERFS, {
          blobs: fileInputs.map((input) => ({ name: input.name, data: input.file })),
        }, mountPoint);
        if (!mountedOk) throw new Error("ffmpeg WORKERFS is unavailable");
        mounted = true;
      }
      for (const input of byteInputs) await ffmpeg.writeFile(input.name, input.bytes);
      const mountedPaths = new Map(fileInputs.map((input) => [input.name, `${mountPoint}/${input.name}`]));
      const args = job.args.map((arg) => mountedPaths.get(arg) ?? arg);
      const exitCode = await ffmpeg.exec(args);
      if (exitCode !== 0) throw new Error(`ffmpeg exited with ${exitCode}`);
      const output = await ffmpeg.readFile(job.outputName);
      // readFile already returns a fresh Uint8Array; wrapping it again copies the whole output.
      return output instanceof Uint8Array ? output : new TextEncoder().encode(String(output));
    } catch (error) {
      console.error("[media-downloader] ffmpeg failed", job.args.join(" "), String(error));
      // A trapped WASM core cannot be reused; drop it so the next attempt loads cleanly.
      try {
        this.instance?.terminate();
      } catch {
        /* termination is best-effort */
      }
      this.instance = undefined;
      this.loading = undefined;
      throw error;
    } finally {
      for (const input of byteInputs) await ffmpeg.deleteFile(input.name).catch(() => undefined);
      await ffmpeg.deleteFile(job.outputName).catch(() => undefined);
      if (mounted) await ffmpeg.unmount(mountPoint).catch(() => undefined);
      if (mountDirCreated) await ffmpeg.deleteDir(mountPoint).catch(() => undefined);
    }
  }
}
