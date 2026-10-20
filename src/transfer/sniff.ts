/**
 * Best-effort container sniffing for the bytes a transfer actually produced.
 *
 * CDNs frequently serve video with a misleading `text/plain`/`.txt` name or no extension at all.
 * The download must not be saved as `.txt`; sniff the common containers from their magic bytes and
 * use that extension when the plan's extension is missing or non-media.
 */

/** Media output extensions this rebuild can safely name. */
const MEDIA_OUTPUT_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4",
  "m4v",
  "mkv",
  "webm",
  "mov",
  "flv",
  "ts",
  "mp3",
  "m4a",
  "ogg",
  "opus",
  "wav",
  "m2ts",
]);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let value = "";
  for (let index = start; index < start + length && index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte < 0x20 || byte > 0x7e) return "";
    value += String.fromCharCode(byte);
  }
  return value;
}

function hasMp4Box(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 8) return false;
  const box = ascii(bytes, offset + 4, 4);
  return box === "ftyp" || box === "moov" || box === "mdat" || box === "free" || box === "skip";
}

/** Sniff one of the containers the browser/worker can produce. */
export function sniffMediaExtension(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;

  // ISO BMFF / fragmented MP4.
  if (hasMp4Box(bytes, 0)) return "mp4";

  // Ebml (WebM and Matroska share the magic; DocType distinguishes them).
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const head = new TextDecoder().decode(bytes.slice(0, 128));
    return /matroska/iu.test(head) ? "mkv" : "webm";
  }

  // MPEG transport stream: 0x47 sync at 188-byte packet boundaries.
  if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return "ts";

  // FLV / Ogg / WAV / MP3.
  if (ascii(bytes, 0, 3) === "FLV") return "flv";
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (ascii(bytes, 0, 3) === "ID3") return "mp3";
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "mp3";

  return undefined;
}

/** Whether an extension is a media container the downloader can name. */
export function isMediaOutputExtension(extension: string): boolean {
  return MEDIA_OUTPUT_EXTENSIONS.has(extension.toLowerCase());
}

/** Replace a missing/non-media extension with the sniffed container (falling back to mp4). */
export function normalizeMediaOutputExtension(
  extension: string,
  bytes: Uint8Array,
  preferSniffed = false,
): string {
  const normalized = extension.toLowerCase();
  if (!preferSniffed && isMediaOutputExtension(normalized)) return normalized;
  const sniffed = sniffMediaExtension(bytes);
  if (sniffed !== undefined && isMediaOutputExtension(sniffed)) {
    // Keep the explicit transport-stream spelling; sniffing only knows "ts".
    if (normalized === "m2ts" && sniffed === "ts") return normalized;
    return sniffed;
  }
  return isMediaOutputExtension(normalized) ? normalized : "mp4";
}
