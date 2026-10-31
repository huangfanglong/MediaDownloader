/**
 * FFmpeg worker with an OPFS output path.
 *
 * Adapted from `@ffmpeg/ffmpeg@0.12.15`'s worker (MIT); the load/exec/file protocol is
 * unchanged so the normal `FFmpeg` client keeps working. Two additions make large outputs
 * safe:
 *
 *  - When the output argument starts with {@link OUTPUT_PREFIX}, FFmpeg writes through a
 *    custom Emscripten filesystem backed by an OPFS `FileSystemSyncAccessHandle`
 *    (`src/ffmpeg/opfs-output-fs.ts`). Nothing accumulates in MEMFS.
 *  - If mounting that filesystem fails but OPFS itself works, FFmpeg writes to MEMFS and the
 *    output is copied to OPFS in bounded chunks (still one MEMFS copy, no second JS copy).
 *  - If OPFS is unavailable the output stays in MEMFS at `/<fileName>` and the caller falls
 *    back to the old whole-file read.
 */
import {
  createOpfsOutputFilesystem,
  type EmscriptenFsLike,
  type SyncAccessHandleLike,
} from "./opfs-output-fs.js";

const FF = {
  LOAD: "LOAD",
  EXEC: "EXEC",
  FFPROBE: "FFPROBE",
  WRITE_FILE: "WRITE_FILE",
  READ_FILE: "READ_FILE",
  DELETE_FILE: "DELETE_FILE",
  RENAME: "RENAME",
  CREATE_DIR: "CREATE_DIR",
  LIST_DIR: "LIST_DIR",
  DELETE_DIR: "DELETE_DIR",
  ERROR: "ERROR",
  DOWNLOAD: "DOWNLOAD",
  PROGRESS: "PROGRESS",
  LOG: "LOG",
  MOUNT: "MOUNT",
  UNMOUNT: "UNMOUNT",
} as const;

/** Marker the runner puts in the output argument; format: prefix + dir + "/" + file. */
export const OUTPUT_PREFIX = "/media-downloader-out/";
const OPFS_MOUNT = "/media-downloader-opfs";
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

interface FfmpegCore {
  FS: {
    ErrnoError: new (errno: number) => Error;
    createNode(parent: unknown, name: string, mode: number): unknown;
    isFile(mode: number): boolean;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string, options?: { encoding?: string }): Uint8Array | string;
    unlink(path: string): void;
    rename(oldPath: string, newPath: string): void;
    mkdir(path: string): void;
    rmdir(path: string): void;
    readdir(path: string): string[];
    stat(path: string): { mode: number };
    isDir(mode: number): boolean;
    mount(fs: unknown, options: unknown, mountPoint: string): void;
    unmount(mountPoint: string): void;
    open(path: string, flags: string): { fd: number };
    read(stream: unknown, buffer: Uint8Array, offset: number, length: number, position?: number): number;
    close(stream: unknown): void;
    filesystems: Record<string, unknown>;
  };
  setLogger(cb: (data: unknown) => void): void;
  setProgress(cb: (data: unknown) => void): void;
  setTimeout(timeout: number): void;
  exec(...args: string[]): void;
  ffprobe(...args: string[]): void;
  ret: number;
  reset(): void;
}

let core: FfmpegCore | undefined;

const load = async ({ coreURL: initialCoreURL, wasmURL }: { coreURL: string; wasmURL?: string }): Promise<boolean> => {
  const first = !core;
  const coreURL = initialCoreURL;
  try {
    (self as unknown as { importScripts?: (url: string) => void }).importScripts?.(coreURL);
    if (!(self as unknown as { createFFmpegCore?: unknown }).createFFmpegCore) {
      throw new Error("importScripts did not define createFFmpegCore");
    }
  } catch {
    (self as unknown as { createFFmpegCore?: unknown }).createFFmpegCore = (
      await import(/* @vite-ignore */ coreURL)
    ).default;
  }
  const factory = (self as unknown as { createFFmpegCore?: (options: unknown) => Promise<FfmpegCore> })
    .createFFmpegCore;
  if (!factory) throw new Error("ffmpeg core import failed");
  const wasm = wasmURL ?? coreURL.replace(/\.js$/u, ".wasm");
  core = await factory({
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL: wasm, workerURL: `${coreURL}.worker.js` }))}`,
  });
  core.setLogger((data) => {
    (self as unknown as { postMessage(message: unknown): void }).postMessage({ type: FF.LOG, data });
  });
  core.setProgress((data) => {
    (self as unknown as { postMessage(message: unknown): void }).postMessage({ type: FF.PROGRESS, data });
  });
  return first;
};

const requireCore = (): FfmpegCore => {
  if (!core) throw new Error("ffmpeg core is not loaded");
  return core;
};

interface OutputTarget {
  args: string[];
  cleanup: () => Promise<void>;
}

const memfsPath = (fileName: string): string => `/${fileName}`;

/** Copy a MEMFS file into the OPFS handle in bounded chunks, then delete the MEMFS copy. */
const copyMemfsToHandle = (ffmpeg: FfmpegCore, path: string, handle: SyncAccessHandleLike): void => {
  const stream = ffmpeg.FS.open(path, "r");
  const buffer = new Uint8Array(COPY_CHUNK_BYTES);
  let offset = 0;
  try {
    for (;;) {
      const read = ffmpeg.FS.read(stream, buffer, 0, buffer.byteLength, offset);
      if (read <= 0) break;
      handle.write(buffer.subarray(0, read), { at: offset });
      offset += read;
    }
  } finally {
    ffmpeg.FS.close(stream);
  }
  ffmpeg.FS.unlink(path);
};

/** Rewrite the output argument and prepare the OPFS destination (direct mount or chunked copy). */
const prepareOutput = async (args: string[]): Promise<OutputTarget> => {
  const index = args.findIndex((arg) => arg.startsWith(OUTPUT_PREFIX));
  if (index < 0) return { args, cleanup: async () => undefined };
  const relative = args[index]!.slice(OUTPUT_PREFIX.length);
  const slash = relative.lastIndexOf("/");
  const dirName = slash < 0 ? "downloads" : relative.slice(0, slash);
  const fileName = slash < 0 ? relative : relative.slice(slash + 1);
  const next = [...args];
  const ffmpeg = requireCore();

  const storage = (navigator as unknown as { storage?: { getDirectory?: () => Promise<unknown> } }).storage;
  const hasSyncHandle =
    typeof FileSystemFileHandle !== "undefined" &&
    typeof (FileSystemFileHandle.prototype as unknown as { createSyncAccessHandle?: unknown })
      .createSyncAccessHandle === "function";
  if (!storage?.getDirectory || !hasSyncHandle) {
    next[index] = memfsPath(fileName);
    return { args: next, cleanup: async () => undefined };
  }

  let handle: SyncAccessHandleLike | undefined;
  try {
    const root = (await storage.getDirectory()) as {
      getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<{
        getFileHandle(name: string, options?: { create?: boolean }): Promise<{
          createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
          removeEntry?(name: string): Promise<void>;
        }>;
      }>;
    };
    const dir = await root.getDirectoryHandle(dirName, { create: true });
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    handle = await fileHandle.createSyncAccessHandle();
    // A retried job reuses the same filename; never leave bytes from the previous run behind.
    handle.truncate(0);
    try {
      const filesystem = createOpfsOutputFilesystem(ffmpeg.FS as unknown as EmscriptenFsLike, handle, fileName);
      ffmpeg.FS.mkdir(OPFS_MOUNT);
      ffmpeg.FS.mount(filesystem, {}, OPFS_MOUNT);
      next[index] = `${OPFS_MOUNT}/${fileName}`;
      const mounted = handle;
      return {
        args: next,
        cleanup: async () => {
          try {
            ffmpeg.FS.unmount(OPFS_MOUNT);
          } finally {
            ffmpeg.FS.rmdir(OPFS_MOUNT);
            mounted.flush();
            mounted.close();
          }
        },
      };
    } catch {
      // Mounting is unsupported: keep the handle and copy MEMFS output after exec.
      next[index] = memfsPath(fileName);
      const copyHandle = handle;
      let copied = false;
      return {
        args: next,
        cleanup: async () => {
          try {
            copyMemfsToHandle(ffmpeg, memfsPath(fileName), copyHandle);
            copied = true;
          } finally {
            copyHandle.flush();
            copyHandle.close();
            if (!copied) await fileHandle.removeEntry?.(fileName).catch(() => undefined);
          }
        },
      };
    }
  } catch {
    // OPFS unavailable: leave the output in MEMFS for the caller's fallback path.
    next[index] = memfsPath(fileName);
    return { args: next, cleanup: async () => undefined };
  }
};

const exec = async ({ args, timeout = -1 }: { args: string[]; timeout?: number }): Promise<number> => {
  const ffmpeg = requireCore();
  const prepared = await prepareOutput(args);
  try {
    ffmpeg.setTimeout(timeout);
    ffmpeg.exec(...prepared.args);
    return ffmpeg.ret;
  } finally {
    ffmpeg.reset();
    await prepared.cleanup();
  }
};

const ffprobe = ({ args, timeout = -1 }: { args: string[]; timeout?: number }): number => {
  const ffmpeg = requireCore();
  ffmpeg.setTimeout(timeout);
  ffmpeg.ffprobe(...args);
  const ret = ffmpeg.ret;
  ffmpeg.reset();
  return ret;
};

const writeFile = ({ path, data }: { path: string; data: Uint8Array }): boolean => {
  requireCore().FS.writeFile(path, data);
  return true;
};
const readFile = ({ path, encoding }: { path: string; encoding?: string }): Uint8Array | string =>
  requireCore().FS.readFile(path, { encoding });
const deleteFile = ({ path }: { path: string }): boolean => {
  requireCore().FS.unlink(path);
  return true;
};
const rename = ({ oldPath, newPath }: { oldPath: string; newPath: string }): boolean => {
  requireCore().FS.rename(oldPath, newPath);
  return true;
};
const createDir = ({ path }: { path: string }): boolean => {
  requireCore().FS.mkdir(path);
  return true;
};
const listDir = ({ path }: { path: string }): Array<{ name: string; isDir: boolean }> => {
  const ffmpeg = requireCore();
  return ffmpeg.FS.readdir(path).map((name) => ({
    name,
    isDir: ffmpeg.FS.isDir(ffmpeg.FS.stat(`${path}/${name}`).mode),
  }));
};
const deleteDir = ({ path }: { path: string }): boolean => {
  requireCore().FS.rmdir(path);
  return true;
};
const mount = ({ fsType, options, mountPoint }: { fsType: string; options: unknown; mountPoint: string }): boolean => {
  const ffmpeg = requireCore();
  const filesystem = ffmpeg.FS.filesystems[fsType];
  if (!filesystem) return false;
  ffmpeg.FS.mount(filesystem, options, mountPoint);
  return true;
};
const unmount = ({ mountPoint }: { mountPoint: string }): boolean => {
  requireCore().FS.unmount(mountPoint);
  return true;
};
const dispose = (): boolean => {
  core = undefined;
  return true;
};

self.onmessage = async ({ data }: MessageEvent<{ id: number; type: string; data?: unknown }>): Promise<void> => {
  const { id, type } = data;
  const payload = data.data as never;
  const transfer: Transferable[] = [];
  let result: unknown;
  try {
    switch (type) {
      case FF.LOAD:
        result = await load(payload);
        break;
      case FF.EXEC:
        result = await exec(payload);
        break;
      case FF.FFPROBE:
        result = ffprobe(payload);
        break;
      case FF.WRITE_FILE:
        result = writeFile(payload);
        break;
      case FF.READ_FILE:
        result = readFile(payload);
        break;
      case FF.DELETE_FILE:
        result = deleteFile(payload);
        break;
      case FF.RENAME:
        result = rename(payload);
        break;
      case FF.CREATE_DIR:
        result = createDir(payload);
        break;
      case FF.LIST_DIR:
        result = listDir(payload);
        break;
      case FF.DELETE_DIR:
        result = deleteDir(payload);
        break;
      case FF.MOUNT:
        result = mount(payload);
        break;
      case FF.UNMOUNT:
        result = unmount(payload);
        break;
      case "DISPOSE":
        result = dispose();
        break;
      default:
        throw new Error(`unknown ffmpeg message type: ${type}`);
    }
  } catch (error) {
    (self as unknown as { postMessage(message: unknown): void }).postMessage({ id, type: FF.ERROR, data: String(error) });
    return;
  }
  if (result instanceof Uint8Array) transfer.push(result.buffer);
  (self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void }).postMessage(
    { id, type, data: result },
    transfer,
  );
};
