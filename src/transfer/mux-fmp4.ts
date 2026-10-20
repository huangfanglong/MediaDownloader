/**
 * Minimal fragmented-MP4 (fMP4) audio+video muxer.
 *
 * Evidence / need: YouTube's HLS (visionOS client) exposes separate video and audio playlists.
 * Each track is ISO BMFF: an init segment (`ftyp`+`moov`, with `mvex`/`trex`) followed by
 * `moof`+`mdat` fragment pairs. To save one playable file we merge the two init segments into one
 * `moov` with two `trak` boxes and interleave the fragments by decode time, rewriting track ids and
 * sequence numbers. Only the boxes needed for fragmented playback are touched; media payloads are
 * copied verbatim.
 *
 * The rebuild deliberately does not include FFmpeg, so this is the original implementation of the
 * `-c copy` mux step for fMP4 inputs (analysis/evidence/04-download-transfer.md E21/E25).
 */

export interface Box {
  type: string;
  start: number;
  end: number;
  /** First payload byte (after the 8/16-byte header). */
  payloadStart: number;
}

const textDecoder = new TextDecoder();

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

/** Parse the top-level boxes in `[start, end)`. Throws on malformed sizes. */
export function readBoxes(bytes: Uint8Array, start = 0, end = bytes.byteLength): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = readUint32(bytes, offset);
    const type = textDecoder.decode(bytes.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new Error("truncated box header");
      const high = readUint32(bytes, offset + 8);
      const low = readUint32(bytes, offset + 12);
      size = high * 0x100000000 + low;
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) throw new Error(`malformed box ${type}`);
    boxes.push({ type, start: offset, end: offset + size, payloadStart: offset + header });
    offset += size;
  }
  return boxes;
}

function findBox(bytes: Uint8Array, boxes: readonly Box[], type: string): Box | undefined {
  void bytes;
  return boxes.find((box) => box.type === type);
}

function childBoxes(bytes: Uint8Array, box: Box): Box[] {
  return readBoxes(bytes, box.payloadStart, box.end);
}

function copyBox(bytes: Uint8Array, box: Box): Uint8Array {
  return bytes.slice(box.start, box.end);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function replaceChildBox(
  bytes: Uint8Array,
  parent: Box,
  childType: string,
  replacement: (child: Box) => Uint8Array,
): Uint8Array {
  const parts = childBoxes(bytes, parent).map((child) =>
    child.type === childType ? replacement(child) : copyBox(bytes, child),
  );
  return makeBox(parent.type, concat(parts));
}

function makeBox(type: string, payload: Uint8Array): Uint8Array {
  const output = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, output.byteLength);
  for (let index = 0; index < 4; index += 1) output[4 + index] = type.charCodeAt(index);
  output.set(payload, 8);
  return output;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

/** Track id of a `tkhd`/`tfhd`/`trex` box (version dependent for tkhd). */
function patchTrackId(bytes: Uint8Array, box: Box, trackId: number): Uint8Array {
  const copy = copyBox(bytes, box);
  const version = copy[8] ?? 0;
  if (box.type === "tkhd") {
    // payload: fullbox(4) + creation/modification(8 or 16) + track_ID(4)
    const offset = 8 + (version === 1 ? 20 : 12);
    writeUint32(copy, offset, trackId);
  } else if (box.type === "tfhd" || box.type === "trex") {
    writeUint32(copy, 8 + 4, trackId);
  }
  return copy;
}

interface Fragment {
  moof: Uint8Array;
  mdat: Uint8Array;
  decodeTime: number;
  trackId: number;
}

/** Extract `moof`+`mdat` pairs from a fragmented file/track. */
function readFragments(bytes: Uint8Array, boxes: readonly Box[]): Fragment[] {
  const fragments: Fragment[] = [];
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (box === undefined || box.type !== "moof") continue;
    const next = boxes[index + 1];
    const mdatBox = next && next.type === "mdat" ? next : undefined;
    const moof = copyBox(bytes, box);
    const mdat = mdatBox ? copyBox(bytes, mdatBox) : new Uint8Array(0);
    let trackId = 1;
    let decodeTime = 0;
    for (const traf of childBoxes(bytes, box)) {
      if (traf.type !== "traf") continue;
      const trafChildren = childBoxes(bytes, traf);
      const tfhd = findBox(bytes, trafChildren, "tfhd");
      if (tfhd) trackId = readUint32(bytes, tfhd.payloadStart + 4);
      const tfdt = findBox(bytes, trafChildren, "tfdt");
      if (tfdt) {
        const version = bytes[tfdt.payloadStart] ?? 0;
        if (version === 1) {
          decodeTime = readUint32(bytes, tfdt.payloadStart + 4) * 0x100000000 + readUint32(bytes, tfdt.payloadStart + 8);
        } else {
          decodeTime = readUint32(bytes, tfdt.payloadStart + 4);
        }
      }
    }
    fragments.push({ moof, mdat, decodeTime, trackId });
  }
  return fragments;
}

/** Rewrite the `mfhd` sequence number in a moof. */
function setSequenceNumber(moof: Uint8Array, sequence: number): void {
  const moofBox = readBoxes(moof)[0];
  if (!moofBox || moofBox.type !== "moof") return;
  const mfhd = readBoxes(moof, moofBox.payloadStart, moofBox.end).find((box) => box.type === "mfhd");
  if (mfhd) writeUint32(moof, mfhd.payloadStart + 4, sequence);
}

/** Rewrite every `traf`/`tfhd` track id in a moof. */
function setMoofTrackId(moof: Uint8Array, trackId: number): void {
  const boxes = readBoxes(moof);
  for (const box of boxes) {
    if (box.type !== "moof") continue;
    for (const traf of readBoxes(moof, box.payloadStart, box.end)) {
      if (traf.type !== "traf") continue;
      for (const header of readBoxes(moof, traf.payloadStart, traf.end)) {
        if (header.type === "tfhd") writeUint32(moof, header.payloadStart + 4, trackId);
      }
    }
  }
}

/** Patch `mvhd.next_track_ID` (offset depends on the version). */
function patchNextTrackId(mvhd: Uint8Array): void {
  const boxes = readBoxes(mvhd);
  const box = boxes[0];
  if (!box) return;
  const version = mvhd[box.payloadStart] ?? 0;
  // payload: fullbox(4), creation/mod(8|16), timescale, duration, rate, volume(2), reserved,
  // matrix(36), pre_defined(24), next_track_ID(4)
  const offset = box.payloadStart + (version === 1 ? 104 : 96);
  if (offset + 4 <= mvhd.byteLength) writeUint32(mvhd, offset, 3);
}

/**
 * Merge a fragmented video file and a fragmented audio file into one playable fMP4.
 * Returns undefined when the inputs are not fragmented fMP4 (e.g. MPEG-TS HLS).
 */
export function muxFragmentedMp4(video: Uint8Array, audio: Uint8Array): Uint8Array | undefined {
  let videoBoxes: Box[];
  let audioBoxes: Box[];
  try {
    videoBoxes = readBoxes(video);
    audioBoxes = readBoxes(audio);
  } catch {
    return undefined;
  }
  const videoFtyp = findBox(video, videoBoxes, "ftyp");
  const videoMoov = findBox(video, videoBoxes, "moov");
  const audioMoov = findBox(audio, audioBoxes, "moov");
  if (!videoMoov || !audioMoov) return undefined;

  const videoMoovChildren = childBoxes(video, videoMoov);
  const audioMoovChildren = childBoxes(audio, audioMoov);
  const mvhd = findBox(video, videoMoovChildren, "mvhd");
  const videoTrak = findBox(video, videoMoovChildren, "trak");
  const audioTrak = findBox(audio, audioMoovChildren, "trak");
  const videoMvex = findBox(video, videoMoovChildren, "mvex");
  const audioMvex = findBox(audio, audioMoovChildren, "mvex");
  if (!mvhd || !videoTrak || !audioTrak || !videoMvex) return undefined;

  const mvhdBytes = copyBox(video, mvhd);
  patchNextTrackId(mvhdBytes);
  const videoTrakBytes = copyBox(video, videoTrak);
  const audioTrakChildren = childBoxes(audio, audioTrak);
  const audioTkhd = findBox(audio, audioTrakChildren, "tkhd");
  const audioTrakBytes = audioTkhd
    ? replaceChildBox(audio, audioTrak, "tkhd", (child) => patchTrackId(audio, child, 2))
    : copyBox(audio, audioTrak);

  const mvexChildren = childBoxes(video, videoMvex);
  const trexParts: Uint8Array[] = [];
  for (const child of mvexChildren) {
    if (child.type === "trex") trexParts.push(patchTrackId(video, child, 1));
  }
  const audioTrex = audioMvex ? findBox(audio, childBoxes(audio, audioMvex), "trex") : undefined;
  if (audioTrex) trexParts.push(patchTrackId(audio, audioTrex, 2));
  if (trexParts.length < 2) return undefined;
  const mvex = makeBox("mvex", concat(trexParts));

  const videoFragments = readFragments(video, videoBoxes);
  const audioFragments = readFragments(audio, audioBoxes);
  if (videoFragments.length === 0 || audioFragments.length === 0) return undefined;

  const merged: Fragment[] = [
    ...videoFragments.map((fragment) => ({ ...fragment, trackId: 1 })),
    ...audioFragments.map((fragment) => ({ ...fragment, trackId: 2 })),
  ].sort((left, right) => left.decodeTime - right.decodeTime || left.trackId - right.trackId);

  const output: Uint8Array[] = [];
  if (videoFtyp) output.push(copyBox(video, videoFtyp));
  output.push(makeBox("moov", concat([mvhdBytes, videoTrakBytes, audioTrakBytes, mvex])));

  let sequence = 1;
  for (const fragment of merged) {
    if (fragment.trackId === 2) setMoofTrackId(fragment.moof, 2);
    setSequenceNumber(fragment.moof, sequence);
    sequence += 1;
    output.push(fragment.moof);
    if (fragment.mdat.byteLength > 0) output.push(fragment.mdat);
  }
  return concat(output);
}
