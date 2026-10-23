import type { OpfsDirectory, OpfsRoot } from "../../src/extension/staging.js";
import type { FetchLike, FetchResponseLike } from "../../src/transfer/fetch.js";

const encoder = new TextEncoder();

function bodyResponse(status: number, data?: Uint8Array): FetchResponseLike {
  if (data === undefined) return { status, ok: false, body: null };
  let sent = false;
  return {
    status,
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: data };
        },
        cancel: async () => undefined,
      }),
    },
  };
}

/** Serve complete response bodies from a URL map. */
export function createFetch(entries: Map<string, string | Uint8Array>): FetchLike {
  return async (url) => {
    const found = entries.get(url);
    if (found === undefined) return bodyResponse(404);
    return bodyResponse(200, typeof found === "string" ? encoder.encode(found) : found);
  };
}

/** Serve bounded byte ranges from a URL map or one payload for every URL. */
export function createRangedFetch(payloads: Map<string, Uint8Array> | Uint8Array): FetchLike {
  return async (url, init) => {
    const payload = payloads instanceof Map ? payloads.get(url) : payloads;
    if (payload === undefined) return bodyResponse(404);
    const range = new Headers(init?.headers).get("range");
    const match = range === null ? null : /^bytes=(\d+)-(\d+)$/u.exec(range);
    if (!match) return bodyResponse(403);
    const start = Number(match[1]);
    if (start >= payload.length) return bodyResponse(416);
    const end = Math.min(Number(match[2]), payload.length - 1);
    return bodyResponse(206, payload.slice(start, end + 1));
  };
}

/** In-memory OPFS with sync access handles and deletion snapshots. */
export function createFakeOpfs(files = new Map<string, Uint8Array[]>()): {
  root: OpfsRoot;
  files: Map<string, Uint8Array[]>;
  removed: Map<string, Uint8Array[]>;
} {
  const removed = new Map<string, Uint8Array[]>();
  const directory: OpfsDirectory = {
    getFileHandleWithSyncAccess: async (name) => ({
      handle: {
        write: async (data) => {
          const chunks = files.get(name) ?? [];
          chunks.push(new Uint8Array(data));
          files.set(name, chunks);
          return { written: data.byteLength };
        },
        close: async () => undefined,
        truncate: async () => undefined,
      },
    }),
    getFileHandle: async (name) => ({
      name,
      getFile: async () =>
        new Blob((files.get(name) ?? []).map((chunk) => new Blob([chunk as unknown as BlobPart]))) as File,
    }),
    removeEntry: async (name) => {
      const chunks = files.get(name);
      if (chunks) removed.set(name, chunks.map((chunk) => new Uint8Array(chunk)));
      files.delete(name);
    },
    keys: async function* () {
      yield* files.keys();
    },
  };
  return {
    root: { getDirectoryHandle: async () => directory },
    files,
    removed,
  };
}
