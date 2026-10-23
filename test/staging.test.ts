import { afterEach, describe, expect, it, vi } from "vitest";
import { createStagedFile, type OpfsDirectory, type OpfsRoot } from "../src/extension/staging.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeOpfs(): OpfsRoot {
  const chunks: Uint8Array[] = [];
  const directory: OpfsDirectory = {
    getFileHandleWithSyncAccess: async () => ({
      handle: {
        write: async (data) => {
          chunks.push(new Uint8Array(data));
          return { written: data.byteLength };
        },
        close: async () => undefined,
        truncate: async () => undefined,
      },
    }),
    getFileHandle: async (name) => ({
      name,
      getFile: async () => new File(chunks as BlobPart[], name),
    }),
    removeEntry: async () => undefined,
  };
  return { getDirectoryHandle: async () => directory };
}

describe("staged download blob", () => {
  it.each([
    ["clip.mp4", "video/mp4"],
    ["clip.m2ts", "video/mp2t"],
    ["clip.mkv", "video/x-matroska"],
  ])("sets a media MIME type before exposing %s", async (name, expectedType) => {
    let exposed: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      if (blob instanceof Blob) exposed = blob;
      return "blob:fake-download";
    });

    const staged = await createStagedFile(fakeOpfs(), name);
    await staged.append(new Uint8Array([0, 1, 2]));
    await staged.finish();

    expect(exposed?.type).toBe(expectedType);
  });
});
