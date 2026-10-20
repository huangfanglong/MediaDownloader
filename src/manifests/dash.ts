/**
 * Minimal, original MPD (DASH) parser for the rebuild.
 *
 * Evidence: analysis/evidence/03-manifest-resolution.md
 *  - F25: MPD resolution IS implemented in JavaScript (the shipped bundle vendors mpd-parser
 *    1.3.1, banner svc:23240-23241). Representations become playlist entries with
 *    `{quality:{bitrate,size}, demuxer, index, audio_id, audio_language}`; representations
 *    without CODECS are skipped; unknown codecs are skipped; entries sorted by height then
 *    bandwidth (svc:11212-11255).
 *  - F25/F37: DRM = a ContentProtection scheme in the Widevine / PlayReady / FairPlay key set
 *    (`kv` svc:8339-8342). The schemeIdUri→name map used by the bundled parser is at
 *    svc:10973-10979; clear-key / mp4protection are not treated as DRM by the shipped code.
 *  - F26: the download itself is delegated to libav's FFmpeg dash demuxer (`-mpd_video_idx
 *    <entry>`), so this parser only needs the manifest's *resolution* facts — no segment
 *    template expansion, no SegmentBase/SegmentList math, no timeline.
 *  - F28: subtitles are in-manifest renditions referenced by id (`type:"id"`); wvtt is skipped
 *    (svc:11257-11279).
 *
 * Deliberately small: a hand-written XML scanner (no DOM, works in Node and an MV3 worker),
 * ISO-8601 duration parsing, adaptation/base-URL inheritance, and typed errors for anything the
 * proven semantics do not cover. Text content is only captured for BaseURL.
 */
import { err, ok, type Result } from "../core/option.js";
import type { MediaDuration, SubtitleTrack } from "../core/types.js";
import { videoDemuxerForCodecs } from "./hls.js";

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

/**
 * One DASH representation resolved to a playlist entry.
 *
 * `url` is the representation's resolved BaseURL. It is informational for the rebuild: the
 * transfer path hands `master_url` + `index` to libav (`-mpd_video_idx`), exactly like the
 * shipped plan (F22/F26).
 */
export interface DashEntry {
  url: URL;
  /** Representation ordinal within its adaptation kind, document order, 0-based (F25). */
  index: number;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  demuxer: string;
  /**
   * On video entries: id of the selected default audio representation (the shipped
   * `audio_id`/`-map 0:a:m:id:<NAME>` source, F25). Audio entries expose their own
   * representation id through the extension field `id`.
   */
  audioId?: string;
  language?: string;
  /** Extension beyond the frozen contract: the Representation `id` attribute. */
  id?: string;
}

export interface MpdManifest {
  /** `"unknown"` when mediaPresentationDuration is absent/unparsable (mirrors `Df`). */
  duration?: MediaDuration;
  video: DashEntry[];
  audio: DashEntry[];
  subtitles: SubtitleTrack[];
  hasDrm: boolean;
}

export type DashParseErrorKind = "invalid_xml" | "invalid_manifest" | "unsupported";

/** Typed parse failure; discovery maps these to "not usable media" like the shipped `Df` err. */
export interface DashParseError {
  kind: DashParseErrorKind;
  message: string;
}

const fail = (kind: DashParseErrorKind, message: string): Result<never, DashParseError> => err({ kind, message });

/** Audio codec table (`Mm`, svc:7298-7303): `[regex, demuxer]` in first-match order. */
const AUDIO_CODECS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(aac|mp4a\.40).*/i, "m4a"],
  [/(\.?mp3|mp4a\.69|mp4a\.6b).*/i, "mp3"],
  [/(opus|(mp4a\.ad.*))/i, "ogg"],
  [/vorbis/i, "ogg"],
];

function audioDemuxerForCodecs(codecs: string): string | undefined {
  for (const [expression, demuxer] of AUDIO_CODECS) if (expression.test(codecs)) return demuxer;
  return undefined;
}

/** Demuxer for a Representation: video table first, then audio (mirrors `Zn` then `Mm`). */
export function demuxerForCodecs(codecs: string): string | undefined {
  return videoDemuxerForCodecs(codecs) ?? audioDemuxerForCodecs(codecs);
}

// ---------------------------------------------------------------------------
// DRM schemes (`kv` svc:8339-8342; uuid map svc:10973-10979)
// ---------------------------------------------------------------------------

const PROTECTION_UUIDS: Readonly<Record<string, string>> = {
  "urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b": "org.w3.clearkey",
  "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed": "com.widevine.alpha",
  "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95": "com.microsoft.playready",
  "urn:uuid:f239e769-efa3-4850-9c16-a903c6932efb": "com.adobe.primetime",
  "urn:mpeg:dash:mp4protection:2011": "mp4protection",
};

/** Only these schemes are DRM for the shipped code (`kv` svc:8339-8342). */
export const DRM_PROTECTION_SCHEMES: ReadonlySet<string> = new Set([
  "com.microsoft.playready",
  "com.apple.streamingkeydelivery",
  "com.widevine.alpha",
]);

/** Resolve a ContentProtection schemeIdUri to the shipped scheme name (undefined = unknown). */
export function protectionSchemeName(schemeIdUri: string): string | undefined {
  const known = PROTECTION_UUIDS[schemeIdUri];
  if (known !== undefined) return known;
  if (/widevine/i.test(schemeIdUri)) return "com.widevine.alpha";
  if (/playready/i.test(schemeIdUri)) return "com.microsoft.playready";
  if (/streamingkeydelivery|fairplay/i.test(schemeIdUri)) return "com.apple.streamingkeydelivery";
  return undefined;
}

// ---------------------------------------------------------------------------
// ISO-8601 duration (`mediaPresentationDuration`)
// ---------------------------------------------------------------------------

/** Parse `PT1H2M3.5S` / `P1DT2H` style durations into seconds. */
export function parseIso8601Duration(value: string): number | undefined {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    value.trim(),
  );
  if (!match) return undefined;
  // Reject empty designs like "P" / "PT": at least one field must be present.
  if (match[1] === undefined && match[2] === undefined && match[3] === undefined && match[4] === undefined) {
    return undefined;
  }
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const total = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : undefined;
}

// ---------------------------------------------------------------------------
// Tiny XML scanner
// ---------------------------------------------------------------------------

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  /** Concatenated character data (only needed for BaseURL). */
  text: string;
}

function findTagEnd(xml: string, from: number): number {
  let quote: string | undefined;
  for (let index = from; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

/** XML attributes are whitespace-separated `name="value"` pairs (no commas, unlike HLS). */
function parseXmlAttributes(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
    if (index >= input.length) break;
    let keyEnd = index;
    while (keyEnd < input.length && !/[\s=]/.test(input[keyEnd] ?? "")) keyEnd += 1;
    const key = input.slice(index, keyEnd);
    index = keyEnd;
    while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
    if (input[index] !== "=") continue;
    index += 1;
    while (index < input.length && /\s/.test(input[index] ?? "")) index += 1;
    const quote = input[index];
    if (quote !== '"' && quote !== "'") continue;
    index += 1;
    const end = input.indexOf(quote, index);
    const value = end === -1 ? input.slice(index) : input.slice(index, end);
    index = end === -1 ? input.length : end + 1;
    if (key !== "") result[key] = value;
  }
  return result;
}

/** Build a minimal tree from an XML document. Returns the root element, if any. */
function parseXml(xml: string): XmlNode | undefined {
  const documentChildren: XmlNode[] = [];
  const stack: XmlNode[] = [{ name: "#document", attributes: {}, children: documentChildren, text: "" }];
  let index = 0;
  const appendText = (upTo: number): void => {
    if (upTo <= index) return;
    const chunk = xml.slice(index, upTo);
    if (chunk.trim().length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined) top.text += chunk;
    }
    index = upTo;
  };
  while (index < xml.length) {
    const open = xml.indexOf("<", index);
    if (open === -1) {
      appendText(xml.length);
      break;
    }
    appendText(open);
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      index = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      const top = stack[stack.length - 1];
      if (top !== undefined && end !== -1) top.text += xml.slice(open + 9, end);
      index = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      index = end === -1 ? xml.length : end + 2;
      continue;
    }
    if (xml.startsWith("<!", open)) {
      const end = xml.indexOf(">", open + 2);
      index = end === -1 ? xml.length : end + 1;
      continue;
    }
    const close = findTagEnd(xml, open + 1);
    if (close === -1) return undefined;
    const raw = xml.slice(open + 1, close);
    index = close + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]?.name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const content = selfClosing ? raw.slice(0, -1) : raw;
    const space = content.search(/\s/);
    const name = (space === -1 ? content : content.slice(0, space)).trim();
    if (name === "") continue;
    const node: XmlNode = {
      name,
      attributes: parseXmlAttributes(space === -1 ? "" : content.slice(space + 1)),
      children: [],
      text: "",
    };
    stack[stack.length - 1]?.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return documentChildren.find((node) => node.name === "MPD");
}

function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function firstChildNamed(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

function firstBaseUrl(node: XmlNode, parentBase: URL): URL {
  const baseUrl = firstChildNamed(node, "BaseURL");
  if (baseUrl === undefined) return parentBase;
  const reference = baseUrl.text.trim();
  if (reference === "") return parentBase;
  try {
    return new URL(reference, parentBase);
  } catch {
    return parentBase;
  }
}

function anyDrmProtection(node: XmlNode): boolean {
  for (const child of node.children) {
    if (child.name === "ContentProtection") {
      const schemeUri = child.attributes.schemeIdUri ?? "";
      const scheme = protectionSchemeName(schemeUri);
      if (scheme !== undefined && DRM_PROTECTION_SCHEMES.has(scheme)) return true;
    }
    if (anyDrmProtection(child)) return true;
  }
  return false;
}

interface AdaptationKind {
  kind: "video" | "audio" | "text";
}

function adaptationKind(node: XmlNode, codecsOfFirstRepresentation: string | undefined): AdaptationKind | undefined {
  const contentType = node.attributes.contentType;
  if (contentType === "video" || contentType === "audio" || contentType === "text") return { kind: contentType };
  const mimeType = node.attributes.mimeType ?? "";
  if (mimeType.startsWith("video/")) return { kind: "video" };
  if (mimeType.startsWith("audio/")) return { kind: "audio" };
  if (mimeType.startsWith("text/") || mimeType.includes("ttml")) return { kind: "text" };
  const codecs = codecsOfFirstRepresentation;
  if (codecs === undefined) return undefined;
  if (videoDemuxerForCodecs(codecs) !== undefined) return { kind: "video" };
  if (audioDemuxerForCodecs(codecs) !== undefined) return { kind: "audio" };
  return undefined;
}

/** Height descending, then bandwidth descending (same comparator as HLS `Jn`, F14/F25). */
function compareEntries(left: DashEntry, right: DashEntry): number {
  const leftHeight = left.height ?? 0;
  const rightHeight = right.height ?? 0;
  if (leftHeight !== rightHeight) return rightHeight - leftHeight;
  return (right.bandwidth ?? 0) - (left.bandwidth ?? 0);
}

function numberOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Parse an MPD document.
 *
 * The returned entries already carry the fields resolution needs: demuxer, bitrate/resolution
 * quality, representation index, and audio/subtitle language metadata. Segment/media templates
 * are intentionally not evaluated — the transfer is delegated to libav (F26).
 */
/** Defense-in-depth limit (adversarial review 3.1). */
export const MAX_MPD_BYTES = 8 * 1024 * 1024;
/** Upper bound on parsed representations (defends against hostile MPDs). */
export const MAX_DASH_ENTRIES = 5_000;

export function parseMpd(xml: string, baseUrl: URL): Result<MpdManifest, DashParseError> {
  if (xml.length > MAX_MPD_BYTES) return fail("invalid_xml", "manifest exceeds size limit");
  if (typeof xml !== "string" || xml.trim() === "") return fail("invalid_xml", "empty document");
  const root = parseXml(xml);
  if (root === undefined) return fail("invalid_xml", "document root is not an MPD element");

  const durationText = root.attributes.mediaPresentationDuration;
  const parsedDuration = durationText === undefined ? undefined : parseIso8601Duration(durationText);
  const duration: MediaDuration = parsedDuration === undefined ? "unknown" : parsedDuration;
  const hasDrm = anyDrmProtection(root);

  const periods = childrenNamed(root, "Period");
  if (periods.length === 0) return fail("invalid_manifest", "no Period element");

  const mpdBase = firstBaseUrl(root, baseUrl);
  const video: DashEntry[] = [];
  const audio: DashEntry[] = [];
  const subtitles: SubtitleTrack[] = [];

  for (const period of periods) {
    const periodBase = firstBaseUrl(period, mpdBase);
    for (const adaptation of childrenNamed(period, "AdaptationSet")) {
      const adaptationBase = firstBaseUrl(adaptation, periodBase);
      const representations = childrenNamed(adaptation, "Representation");
      const firstCodecs = representations[0]?.attributes.codecs;
      const kind = adaptationKind(adaptation, firstCodecs);
      if (kind === undefined) continue;
      const language = adaptation.attributes.lang;

      for (const representation of representations) {
        const id = representation.attributes.id;
        if (kind.kind === "text") {
          const codecs = representation.attributes.codecs;
          // F28: the shipped code drops WebVTT-in-MPD renditions ("wvtt").
          if (codecs === "wvtt") continue;
          subtitles.push({
            language: language ?? "und",
            type: "id",
            id: id ?? representation.attributes.NAME ?? "subtitle",
            ...(language === undefined ? {} : { languageName: language }),
          });
          continue;
        }
        const codecs = representation.attributes.codecs;
        // F25: representations without CODECS are skipped by the shipped parser.
        if (codecs === undefined) continue;
        const demuxer = demuxerForCodecs(codecs);
        if (demuxer === undefined) continue;
        const representationBase = firstBaseUrl(representation, adaptationBase);
        const bandwidth = numberOf(representation.attributes.bandwidth);
        const width = numberOf(representation.attributes.width);
        const height = numberOf(representation.attributes.height);
        const isVideo =
          kind.kind === "video" || (kind.kind !== "audio" && videoDemuxerForCodecs(codecs) !== undefined);
        const entry: DashEntry = {
          url: representationBase,
          index: isVideo ? video.length : audio.length,
          demuxer,
          ...(bandwidth === undefined ? {} : { bandwidth }),
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
          ...(codecs === undefined ? {} : { codecs }),
          ...(id === undefined ? {} : { id }),
          ...(language === undefined || isVideo ? {} : { language }),
        };
        if (isVideo) video.push(entry);
        else audio.push(entry);
      }
    }
  }

  if (video.length === 0 && audio.length === 0 && subtitles.length === 0) {
    return fail("unsupported", "manifest has no usable representations");
  }

  // F25: video entries carry the selected default audio rendition id (highest-bandwidth audio).
  const defaultAudio = audio.reduce<DashEntry | undefined>((best, entry) => {
    if (best === undefined) return entry;
    return (entry.bandwidth ?? 0) > (best.bandwidth ?? 0) ? entry : best;
  }, undefined);
  if (defaultAudio?.id !== undefined) {
    for (const entry of video) entry.audioId = defaultAudio.id;
  }

  // F25: the shipped parser sorts the playlist by height descending, then bandwidth descending
  // (`Jn`, svc:11255). `index` keeps the document ordinal assigned above.
  video.sort(compareEntries);
  audio.sort(compareEntries);
  return ok({
    duration,
    video: video.slice(0, MAX_DASH_ENTRIES),
    audio: audio.slice(0, MAX_DASH_ENTRIES),
    subtitles: subtitles.slice(0, MAX_DASH_ENTRIES),
    hasDrm,
  });
}
