/**
 * Writable Emscripten filesystem that streams FFmpeg output into an OPFS file.
 *
 * FFmpeg (libav) writes its output through synchronous file operations, so the backing store
 * must be synchronous too. In a dedicated worker that is exactly what
 * `FileSystemSyncAccessHandle` provides: libav's `write`/`seek`/`truncate` calls go straight to
 * the OPFS file instead of growing a MEMFS buffer. The device exposes a single output file;
 * any other path is refused.
 *
 * The Emscripten filesystem interface mirrors the shipped WORKERFS implementation: `mount`,
 * `createNode`, `node_ops` and `stream_ops`. Only the stream operations differ — this one is
 * writable, seeks through `getSize()` and flushes on close.
 */

/** Subset of `FileSystemSyncAccessHandle` the device needs (also implementable in tests). */
export interface SyncAccessHandleLike {
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/** Minimal Emscripten FS surface used by the device. */
export interface EmscriptenFsLike {
  ErrnoError: new (errno: number) => Error;
  createNode(parent: unknown, name: string, mode: number): DeviceNode;
  isFile(mode: number): boolean;
}

interface DeviceNode {
  id: number;
  mode: number;
  parent?: DeviceNode;
  contents?: Record<string, DeviceNode>;
  node_ops?: unknown;
  stream_ops?: unknown;
}

interface DeviceStream {
  node: DeviceNode;
  flags: number;
  position: number;
}

export interface DeviceFilesystem {
  DIR_MODE: number;
  FILE_MODE: number;
  mount(): DeviceNode;
  createNode(parent: DeviceNode | null, name: string, mode: number, _dev?: number): DeviceNode;
  node_ops: Record<string, unknown>;
  stream_ops: Record<string, unknown>;
}

const DIR_MODE = 0o040755;
const FILE_MODE = 0o100666;
const ENOENT = 2;
const EPERM = 63;
const EINVAL = 28;
const EBADF = 9;

/** Build a mounted-filesystem object that exposes a single writable file. */
export function createOpfsOutputFilesystem(
  fs: EmscriptenFsLike,
  handle: SyncAccessHandleLike,
  fileName: string,
): DeviceFilesystem {
  let root: DeviceNode | undefined;
  let fileNode: DeviceNode | undefined;

  const filesystem: DeviceFilesystem = {
    DIR_MODE,
    FILE_MODE,
    mount(): DeviceNode {
      root = filesystem.createNode(null, "/", DIR_MODE, 0);
      fileNode = filesystem.createNode(root, fileName, FILE_MODE, 0);
      return root;
    },
    createNode(parent: DeviceNode | null, name: string, mode: number, _dev?: number): DeviceNode {
      const node = fs.createNode(parent, name, mode);
      node.mode = mode;
      node.node_ops = filesystem.node_ops;
      node.stream_ops = filesystem.stream_ops;
      if ((mode & 0o170000) === 0o040000) node.contents = {};
      if (parent) parent.contents![name] = node;
      return node;
    },
    node_ops: {
      getattr(node: DeviceNode): Record<string, unknown> {
        const size = node === fileNode ? handle.getSize() : 0;
        const now = new Date();
        return {
          dev: 1,
          ino: node.id,
          mode: node.mode,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: undefined,
          size,
          atime: now,
          mtime: now,
          ctime: now,
          blksize: 4096,
          blocks: Math.ceil(size / 4096),
        };
      },
      setattr(node: DeviceNode, attr: { mode?: number }): void {
        if (attr.mode !== undefined) node.mode = attr.mode;
      },
      lookup(parent: DeviceNode, name: string): DeviceNode {
        if (parent === root && name === fileName && fileNode) return fileNode;
        throw new fs.ErrnoError(ENOENT);
      },
      mknod(): never {
        throw new fs.ErrnoError(EPERM);
      },
      rename(): never {
        throw new fs.ErrnoError(EPERM);
      },
      unlink(): never {
        throw new fs.ErrnoError(EPERM);
      },
      rmdir(): never {
        throw new fs.ErrnoError(EPERM);
      },
      readdir(node: DeviceNode): string[] {
        return node === root ? [".", "..", fileName] : [".", ".."];
      },
      symlink(): never {
        throw new fs.ErrnoError(EPERM);
      },
    },
    stream_ops: {
      // FS.open handles most flag logic; O_TRUNC is applied by the generic layer through
      // stream_ops.truncate when it exists, so `open` only needs to reject wrong nodes.
      open(stream: DeviceStream): void {
        if (stream.node !== fileNode) throw new fs.ErrnoError(EBADF);
      },
      close(): void {
        handle.flush();
      },
      read(stream: DeviceStream, buffer: Int8Array, offset: number, length: number, position?: number): number {
        if (stream.node !== fileNode) throw new fs.ErrnoError(EBADF);
        const at = position ?? stream.position;
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
        return handle.read(view, { at });
      },
      write(stream: DeviceStream, buffer: Int8Array, offset: number, length: number, position?: number): number {
        if (stream.node !== fileNode) throw new fs.ErrnoError(EBADF);
        const at = position ?? stream.position;
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
        return handle.write(view, { at });
      },
      llseek(stream: DeviceStream, offset: number, whence: number): number {
        let position = offset;
        if (whence === 1) position += stream.position;
        else if (whence === 2) position += handle.getSize();
        if (position < 0) throw new fs.ErrnoError(EINVAL);
        return position;
      },
      fstat(_stream: DeviceStream, stat: { size: number }): void {
        stat.size = handle.getSize();
      },
      truncate(_stream: DeviceStream, length: number): void {
        handle.truncate(length);
      },
      fsync(): number {
        handle.flush();
        return 0;
      },
    },
  };
  return filesystem;
}
