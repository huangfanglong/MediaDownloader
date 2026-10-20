/**
 * Minimal MPEG-TS + H.264 probe used for HLS media playlists that carry no
 * RESOLUTION/BANDWIDTH attributes. It only reads the first SPS, so a 1-2 MiB
 * head of the first segment is enough.
 */

export interface TsVideoSize {
  width: number;
  height: number;
}

class BitReader {
  private bit = 0;

  constructor(private readonly data: Uint8Array) {}

  read(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = this.data[this.bit >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit += 1;
    }
    return value;
  }

  skip(count: number): void {
    this.bit += count;
  }

  ue(): number {
    let leadingZeroBits = 0;
    while (this.bit < this.data.length * 8 && this.read(1) === 0) leadingZeroBits += 1;
    if (leadingZeroBits === 0) return 0;
    return (1 << leadingZeroBits) - 1 + this.read(leadingZeroBits);
  }

  se(): number {
    const value = this.ue();
    return value % 2 === 0 ? -(value / 2) : (value + 1) / 2;
  }
}

function withoutEmulationPrevention(nal: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < nal.length; index += 1) {
    if (index >= 2 && nal[index] === 0x03 && nal[index - 1] === 0x00 && nal[index - 2] === 0x00) {
      continue;
    }
    output.push(nal[index] as number);
  }
  return Uint8Array.from(output);
}

function skipScalingList(bits: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let index = 0; index < size; index += 1) {
    if (nextScale !== 0) {
      const deltaScale = bits.se();
      nextScale = (lastScale + deltaScale + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

/** Parse an H.264 seq_parameter_set_rbsp and return its cropped display size. */
export function parseH264SpsDimensions(nal: Uint8Array): TsVideoSize | undefined {
  if (nal.length < 4) return undefined;
  const rbsp = withoutEmulationPrevention(nal);
  if (rbsp.length < 4) return undefined;
  const profile = rbsp[0] as number;
  const bits = new BitReader(rbsp.subarray(3));
  const highProfile = [
    100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
  ].includes(profile);
  let chromaFormatIdc = 1;
  let separateColourPlane = false;
  try {
    bits.ue(); // seq_parameter_set_id
    if (highProfile) {
      chromaFormatIdc = bits.ue();
      if (chromaFormatIdc === 3) separateColourPlane = bits.read(1) === 1;
      bits.ue(); // bit_depth_luma_minus8
      bits.ue(); // bit_depth_chroma_minus8
      bits.read(1); // qpprime_y_zero_transform_bypass_flag
      const scalingMatrixPresent = bits.read(1) === 1;
      if (scalingMatrixPresent) {
        const lists = chromaFormatIdc === 3 ? 12 : 8;
        for (let index = 0; index < lists; index += 1) {
          if (bits.read(1) === 1) skipScalingList(bits, index < 6 ? 16 : 64);
        }
      }
    }
    bits.ue(); // log2_max_frame_num_minus4
    const picOrderCntType = bits.ue();
    if (picOrderCntType === 0) {
      bits.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      bits.read(1); // delta_pic_order_always_zero_flag
      bits.se(); // offset_for_non_ref_pic
      bits.se(); // offset_for_top_to_bottom_field
      const cycleLength = bits.ue();
      for (let index = 0; index < cycleLength; index += 1) bits.se();
    }
    bits.ue(); // max_num_ref_frames
    bits.read(1); // gaps_in_frame_num_value_allowed_flag
    const picWidthInMbsMinus1 = bits.ue();
    const picHeightInMapUnitsMinus1 = bits.ue();
    const frameMbsOnly = bits.read(1) === 1;
    if (!frameMbsOnly) bits.read(1); // mb_adaptive_frame_field_flag
    bits.read(1); // direct_8x8_inference_flag
    const frameCropping = bits.read(1) === 1;
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (frameCropping) {
      cropLeft = bits.ue();
      cropRight = bits.ue();
      cropTop = bits.ue();
      cropBottom = bits.ue();
    }
    const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
    const subWidthC = chromaArrayType === 3 ? 1 : 2;
    const subHeightC = chromaArrayType === 1 ? 2 : 1;
    const cropUnitX = chromaArrayType === 0 ? 1 : subWidthC;
    const cropUnitY =
      chromaArrayType === 0 ? (frameMbsOnly ? 1 : 2) : subHeightC * (frameMbsOnly ? 1 : 2);
    const width = (picWidthInMbsMinus1 + 1) * 16 - cropUnitX * (cropLeft + cropRight);
    const height =
      (frameMbsOnly ? 1 : 2) * (picHeightInMapUnitsMinus1 + 1) * 16 -
      cropUnitY * (cropTop + cropBottom);
    if (width > 0 && height > 0 && width <= 16_384 && height <= 16_384) return { width, height };
    return undefined;
  } catch {
    return undefined;
  }
}

function readSectionLength(data: Uint8Array, start: number): number {
  return ((data[start + 1] as number) & 0x0f) * 256 + (data[start + 2] as number);
}

function findPidForProgram(pat: Uint8Array): number | undefined {
  if (pat[0] !== 0x00) return undefined;
  const sectionLength = readSectionLength(pat, 0);
  const end = Math.min(pat.length, 3 + sectionLength - 4);
  for (let index = 8; index + 4 <= end; index += 4) {
    const program = ((pat[index] as number) << 8) | (pat[index + 1] as number);
    if (program === 0) continue;
    return (((pat[index + 2] as number) & 0x1f) << 8) | (pat[index + 3] as number);
  }
  return undefined;
}

function findVideoPid(pmt: Uint8Array): number | undefined {
  if (pmt[0] !== 0x02) return undefined;
  const sectionLength = readSectionLength(pmt, 0);
  const end = Math.min(pmt.length, 3 + sectionLength - 4);
  const programInfoLength = ((pmt[10] as number) & 0x0f) * 256 + (pmt[11] as number);
  let index = 12 + programInfoLength;
  while (index + 5 <= end) {
    const streamType = pmt[index] as number;
    const pid = (((pmt[index + 1] as number) & 0x1f) << 8) | (pmt[index + 2] as number);
    const esInfoLength = ((pmt[index + 3] as number) & 0x0f) * 256 + (pmt[index + 4] as number);
    if (streamType === 0x1b) return pid; // H.264
    index += 5 + esInfoLength;
  }
  return undefined;
}

/** Extract the first SPS from a concatenated MPEG-TS byte stream. */
export function probeMpegTsVideoSize(bytes: Uint8Array): TsVideoSize | undefined {
  let pmtPid: number | undefined;
  let videoPid: number | undefined;
  const videoPayload: number[] = [];
  for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
    if (bytes[offset] !== 0x47) continue;
    const header = bytes[offset + 1] as number;
    const payloadStart = (header & 0x40) !== 0;
    const pid = (((header & 0x1f) << 8) | (bytes[offset + 2] as number));
    const adaptation = (header & 0x20) !== 0;
    const payloadOffset = offset + 4 + (adaptation ? 1 + (bytes[offset + 4] as number) : 0);
    if (payloadOffset >= offset + 188) continue;
    const payload = bytes.subarray(payloadOffset, offset + 188);
    if (pid === 0 && payloadStart) {
      const pointer = payload[0] as number;
      const section = payload.subarray(1 + pointer);
      const candidate = findPidForProgram(section);
      if (candidate !== undefined) pmtPid = candidate;
    } else if (pmtPid !== undefined && pid === pmtPid && payloadStart) {
      const pointer = payload[0] as number;
      const section = payload.subarray(1 + pointer);
      const candidate = findVideoPid(section);
      if (candidate !== undefined) videoPid = candidate;
    } else if (videoPid !== undefined && pid === videoPid) {
      videoPayload.push(...payload);
    }
  }
  // Also handle the common case where the PMT was missed: scan all payload.
  const payloads = videoPayload.length > 0 ? [Uint8Array.from(videoPayload)] : [bytes];
  for (const data of payloads) {
    for (let index = 0; index + 3 < data.length; index += 1) {
      if (data[index] !== 0x00 || data[index + 1] !== 0x00 || data[index + 2] !== 0x01) continue;
      const nalType = (data[index + 3] as number) & 0x1f;
      if (nalType !== 7) continue;
      let end = index + 4;
      while (end + 3 < data.length) {
        if (data[end] === 0x00 && data[end + 1] === 0x00 && data[end + 2] === 0x01) break;
        end += 1;
      }
      const dimensions = parseH264SpsDimensions(data.subarray(index + 4, end));
      if (dimensions !== undefined) return dimensions;
    }
  }
  return undefined;
}
