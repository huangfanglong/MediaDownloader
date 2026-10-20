/**
 * Origin-private file system staging for assembled downloads.
 *
 * Evidence: 04-download-transfer.md §2.3 — the original stages output in OPFS inside the
 * dedicated worker (`createSyncAccessHandle`), finalizes into a `File`, hands a blob URL to the
 * service worker, which saves it with `chrome.downloads` and removes the OPFS entry afterwards.
 * The service worker also purges stale entries at startup.
 *
 * The browser surface is injected (an `OpfsRoot`-shaped object) so the logic is testable in Node.
 */

export interface OpfsFileHandle {
  write(data: Uint8Array): Promise<{ written: number }>;
  close(): Promise<void>;
  truncate(size: number): Promise<void>;
  flush?(): Promise<void>;
}

export interface OpfsDirectory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    name: string;
    getFile(): Promise<File>;
    createWritable?(): Promise<{
      write(data: Uint8Array): Promise<void>;
      close(): Promise<void>;
    }>;
  }>;
  getFileHandleWithSyncAccess?(name: string, options: {
    create?: boolean;
  }): Promise<{ handle: OpfsFileHandle }>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys?(): AsyncIterable<string>;
}

export interface OpfsRoot {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectory>;
}

/** Directory under the OPFS root used for staging. */
export const STAGING_DIRECTORY = "downloads";

/** Sequential writer over one staged file. */
export class StagedFile {
  private pending: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly directory: OpfsDirectory,
    readonly name: string,
    private readonly handle: OpfsFileHandle,
  ) {}

  /** Append bytes. Writes are serialised so callers may fire them without awaiting ordering. */
  append(chunk: Uint8Array): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.closed) throw new Error("staged file is closed");
      await this.handle.write(chunk);
    });
    return this.pending;
  }

  async finish(): Promise<{ filename: string; blobUrl: string }> {
    await this.pending;
    this.closed = true;
    await this.handle.close();
    const entry = await this.directory.getFileHandle(this.name);
    const file = await entry.getFile();
    return { filename: this.name, blobUrl: URL.createObjectURL(file) };
  }

  async abort(): Promise<void> {
    this.closed = true;
    try {
      await this.handle.close();
    } finally {
      await this.directory.removeEntry(this.name).catch(() => undefined);
    }
  }
}

/** Create a staged file inside the staging directory. */
export async function createStagedFile(root: OpfsRoot, name: string): Promise<StagedFile> {
  const directory = await root.getDirectoryHandle(STAGING_DIRECTORY, { create: true });
  if (directory.getFileHandleWithSyncAccess) {
    const { handle } = await directory.getFileHandleWithSyncAccess(name, { create: true });
    return new StagedFile(directory, name, handle);
  }
  // Fallback used outside a dedicated worker: writable stream backed file.
  const entry = await directory.getFileHandle(name, { create: true });
  const writable = await entry.createWritable?.();
  if (!writable) throw new Error("OPFS staging is unavailable in this context");
  const handle: OpfsFileHandle = {
    write: (data) => writable.write(data).then(() => ({ written: data.byteLength })),
    close: () => writable.close(),
    truncate: async () => undefined,
  };
  return new StagedFile(directory, name, handle);
}

/** Remove one staged entry, ignoring "not found" (post-save cleanup is best effort). */
export async function removeStagedFile(root: OpfsRoot, name: string): Promise<void> {
  const directory = await root.getDirectoryHandle(STAGING_DIRECTORY, { create: true });
  await directory.removeEntry(name).catch(() => undefined);
}

/** Remove every entry left behind by a previous service-worker lifetime. */
export async function purgeStaging(root: OpfsRoot): Promise<number> {
  const directory = await root.getDirectoryHandle(STAGING_DIRECTORY, { create: true });
  let removed = 0;
  if (!directory.keys) return removed;
  const names: string[] = [];
  for await (const name of directory.keys()) names.push(name);
  for (const name of names) {
    await directory.removeEntry(name).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

/** Access the OPFS root when the platform supports it. */
export async function openOpfsRoot(): Promise<OpfsRoot | undefined> {
  const storage = globalThis.navigator?.storage as
    | { getDirectory?: () => Promise<OpfsRoot> }
    | undefined;
  if (!storage?.getDirectory) return undefined;
  try {
    return await storage.getDirectory();
  } catch {
    return undefined;
  }
}
