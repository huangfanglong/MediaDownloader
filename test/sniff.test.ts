import { describe, expect, it } from "vitest";
import {
  isMediaOutputExtension,
  normalizeMediaOutputExtension,
  sniffMediaExtension,
} from "../src/transfer/sniff.js";

const text = new TextEncoder().encode("this is not a media file");

describe("media container sniffing", () => {
  it("recognises fragmented MP4/ISO BMFF bytes", () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(sniffMediaExtension(bytes)).toBe("mp4");
  });

  it("recognises EBML WebM and Matroska", () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode("...webm...")]);
    const mkv = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode("...matroska...")]);
    expect(sniffMediaExtension(webm)).toBe("webm");
    expect(sniffMediaExtension(mkv)).toBe("mkv");
  });

  it("recognises TS, FLV, Ogg and standalone audio", () => {
    expect(sniffMediaExtension(new Uint8Array([0x47, 0, 0, 0]))).toBe("ts");
    expect(sniffMediaExtension(new TextEncoder().encode("FLV\u0001"))).toBe("flv");
    expect(sniffMediaExtension(new TextEncoder().encode("OggS..."))).toBe("ogg");
    expect(sniffMediaExtension(new TextEncoder().encode("ID3..."))).toBe("mp3");
    expect(sniffMediaExtension(new TextEncoder().encode("RIFF....WAVE"))).toBe("wav");
    expect(sniffMediaExtension(text)).toBeUndefined();
  });

  it("turns a text/HTML extension on real media bytes into the sniffed container", () => {
    const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(normalizeMediaOutputExtension("txt", mp4)).toBe("mp4");
    expect(normalizeMediaOutputExtension("mp4", mp4)).toBe("mp4");
    expect(normalizeMediaOutputExtension("txt", text)).toBe("mp4");
    expect(isMediaOutputExtension("txt")).toBe(false);
  });

  it("keeps an explicit valid output format unless Auto asks for sniffing", () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode("webm")]);
    expect(normalizeMediaOutputExtension("mp4", webm)).toBe("mp4");
    expect(normalizeMediaOutputExtension("mp4", webm, true)).toBe("webm");
    expect(normalizeMediaOutputExtension("m2ts", new Uint8Array([0x47, 0, 0, 0]), true)).toBe("m2ts");
  });
});
