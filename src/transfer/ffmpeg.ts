/**
 * ffmpeg.wasm runner (single-thread @ffmpeg/core) used for YouTube 1080p+/4K merges and the
 * MP4/MKV/WebM/MP3 output options.
 *
 * Verified in a sandboxed Brave extension dedicated-worker context (no cross-origin isolation
 * needed): wrapper + core load from chrome-extension:// URLs, `classWorkerURL` must point at the
 * vendored wrapper worker, and the extension-page CSP needs `'wasm-unsafe-eval'`.
 * Licensing: the bundled core is GPL-2.0-or-later (GPLv3-compatible; see docs/THIRD_PARTY.md).
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";

export type FfmpegContainer = "mp4" | "mkv" | "webm" | "mp3";

export interface FfmpegInput {
  name: string;
  bytes: Uint8Array;
}

export interface FfmpegJob {
  inputs: FfmpegInput[];
  args: string[];
  outputName: string;
}

/** Injectable seam so the download worker can be unit-tested without WASM. */
export interface FfmpegRunnerLike {
  run(job: FfmpegJob): Promise<Uint8Array>;
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

  private async runExclusive(job: FfmpegJob): Promise<Uint8Array> {
    const ffmpeg = await this.ensureLoaded();
    try {
      for (const input of job.inputs) await ffmpeg.writeFile(input.name, input.bytes);
      const exitCode = await ffmpeg.exec(job.args);
      if (exitCode !== 0) throw new Error(`ffmpeg exited with ${exitCode}`);
      const output = await ffmpeg.readFile(job.outputName);
      const bytes = output instanceof Uint8Array ? output : new TextEncoder().encode(String(output));
      return new Uint8Array(bytes);
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
      for (const input of job.inputs) await ffmpeg.deleteFile(input.name).catch(() => undefined);
      await ffmpeg.deleteFile(job.outputName).catch(() => undefined);
    }
  }
}
