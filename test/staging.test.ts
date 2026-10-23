import { afterEach, describe, expect, it, vi } from "vitest";
import { createStagedFile } from "../src/extension/staging.js";
import { createFakeOpfs } from "./helpers/transfer-fakes.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

    const staged = await createStagedFile(createFakeOpfs().root, name);
    await staged.append(new Uint8Array([0, 1, 2]));
    await staged.finish();

    expect(exposed?.type).toBe(expectedType);
  });
});
