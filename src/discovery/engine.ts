/**
 * Discovery engine: the chrome-free core of the background sniffing pipeline.
 *
 * Reproduces the serviced-worker path `webRequest.onSendHeaders` → `webRequest.onResponseStarted`
 * → `NS` → (`Ef` | `IS` | `OS`) → `on_media` → per-tab `discovered` registry, recovered in
 * `analysis/evidence/02-detection-pipeline.md` (claims D1-D36). The engine deliberately does not
 * fetch manifests or send messages: the host wires the two `webRequest` listeners to
 * `onSendHeaders` / `onResponseStarted`, and the manifest layer calls `attachPlaylist` once it has
 * parsed a playlist body.
 *
 * Deviations from the original (all documented in the evidence doc):
 * - D7 (`Ef`/`IS`) in the original fetches and parses the manifest itself, then emits
 *   `m3u8_playlist` / `mpd_playlist`. Here the engine emits an `m3u8` / `mpd_playlist`
 *   *candidate* item (URL-derived provisional hash) and `attachPlaylist` enriches it with the
 *   parsed renditions; when `manifestText` is supplied the canonical body-seeded hash is
 *   recomputed and the registry entry re-keyed (D27).
 * - The original suppresses direct media from an initiator after a **successful** DASH parse
 *   (D16). Since parsing happens outside the engine, the initiator-seen entry is written by
 *   `attachPlaylist`, i.e. after the manifest layer succeeds.
 * - The original forwards `player.vimeo.com/config` and `intl-api.iq.com/dash` payloads to the
 *   injected site adapter (D9 step 4); site adapters are out of rebuild scope, so those requests
 *   are dropped here (they are both in the blocked-initiator set anyway).
 * - `tabId <= 0` items are produced but not registered: the original emits `tab_id: None` and
 *   resolves the owning tab from the initiator in the service layer (D29).
 */

import type {
  MediaDuration,
  MediaItem,
  MediaType,
  PlaylistEntry,
  SubtitleTrack,
} from "../core/types.js";
// bus-analyst owns src/settings/flags.ts. Import the shared union so the gate seam is typed once.
// (If the file is not yet present the import is still correct; it resolves as soon as it lands.)
import type { BehaviourFlag } from "../settings/flags.js";
import { cyrb53 } from "../protocol/channels.js";
import { canonicalHlsManifestUrl } from "../manifests/hls.js";
import {
  isBlockedInitiatorHost,
  mimeToDemuxer,
  resolveMediaDescriptor,
  SEGMENT_PATH_PATTERN,
  tryUrl,
} from "./classify.js";

// ---------------------------------------------------------------------------
// Constants (evidence D5/D6/D9/D10/D16/D17; original byte offsets in comments)
// ---------------------------------------------------------------------------

/** Resource types whose responses are sniffed for playlists (original `n`, D2). */
export const SNIFF_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "xmlhttprequest",
  "media",
  "main_frame",
  "sub_frame",
  "other",
]);

/** Types that reach the playlist-sniff branch of `NS` (D10). */
export const PLAYLIST_SNIFF_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "xmlhttprequest",
  "other",
  "main_frame",
  "media",
]);

/** Recorded request-header TTL (original `s = 600 * 1e3`, D6; byte 244,147). */
export const SEND_HEADERS_TTL_MS = 600 * 1e3;

/** Files smaller than this are rejected unless the site allows small-file detection (D17). */
export const SMALL_FILE_THRESHOLD_BYTES = 5e5;

/**
 * Direct-response size below which an already-seen DASH initiator suppresses the item
 * (original `2e7`, D16/D17; byte 241,435).
 */
export const INITIATOR_SUPPRESSION_THRESHOLD_BYTES = 2e7;

/** Reject a further item once the tab already holds more than this many of the same type (D30). */
export const SAME_TYPE_ITEM_CAP = 10;

/** FIFO bounded-registry size for `FIFO_DISCOVERED_WEBSITES` sites (original `bs(30)`, D29). */
export const FIFO_DISCOVERED_ITEM_CAP = 30;

/** HLS signal patterns (D10; pretty 11616-11618). */
export const HLS_CONTENT_TYPE_PATTERN = /mpegurl/i;
/** A manifest URL ends in .m3u8; plain `/hls/` paths are usually segments. */
export const HLS_URL_PATTERN = /\.m3u8(?:$|[?#])/i;
export const HLS_MASTER_API_PATTERN = /\/api\/playlist\/master\//;

/** DASH signal patterns (D10; pretty 11624-11625). */
export const DASH_CONTENT_TYPE_PATTERN = /dash/i;
export const DASH_URL_PATTERN = /\.mpd/i;

/** MPD→M3U8 conversion match (D10; pretty 9492). */
export const MPD_EXTENSION_PATTERN = /\.mpd/i;

/** Initiator schemes that are never page players (D9 step 2). */
export const EXTENSION_INITIATOR_PATTERN = /^(moz|chrome)-extension/;

/** Prefix of the per-tab identity (D27; pretty 11368/11400/11453/11538). */
export const MEDIA_HASH_PREFIX = "media_hash_";

/** `media_hash_<cyrb53>` for a direct response URL (original `OS`, byte 241,757). */
export function directMediaHash(url: URL): string {
  return `${MEDIA_HASH_PREFIX}${cyrb53(url.href)}`;
}

/** `media_hash_<cyrb53(text + url.href)>` for an HLS playlist (original `Ef`, bytes 238,800/239,204). */
export function hlsPlaylistHash(playlistText: string, url: URL): string {
  return `${MEDIA_HASH_PREFIX}${cyrb53(playlistText + url.href)}`;
}

/** `media_hash_<cyrb53(mpdText)>` for a DASH manifest (original `IS`, byte 240,014; URL excluded). */
export function dashPlaylistHash(mpdText: string): string {
  return `${MEDIA_HASH_PREFIX}${cyrb53(mpdText)}`;
}

// ---------------------------------------------------------------------------
// Event and dependency seams (chrome-free; the host adapts chrome.webRequest details)
// ---------------------------------------------------------------------------

/** `chrome.webRequest.HttpHeader`-shaped header pair. */
export interface HeaderPair {
  name: string;
  value?: string;
}

/** Payload of `webRequest.onSendHeaders` that the engine consumes. */
export interface SendHeadersEvent {
  requestId: string;
  url: string;
  tabId: number;
  frameId: number;
  /** Resource type such as `"media"`, `"xmlhttprequest"`, `"main_frame"`. */
  type: string;
  initiator?: string;
  timeStamp: number;
  requestHeaders?: HeaderPair[];
}

/** Payload of `webRequest.onResponseStarted` that the engine consumes. */
export interface ResponseStartedEvent {
  requestId: string;
  url: string;
  tabId: number;
  frameId: number;
  type: string;
  initiator?: string;
  statusCode: number;
  timeStamp: number;
  responseHeaders: HeaderPair[];
}

/** Feature-gate seam: the remote-behaviour table (`remote_behaviours.websites`, D26). */
export interface BehaviourGate {
  enabled(flag: BehaviourFlag, host: string): boolean;
}

/** Engine dependencies. `now` lets tests pin `discovery_timestamp_ms` and TTL pruning. */
export interface DiscoveryDeps {
  flags: BehaviourGate;
  now(): number;
}

/** Extra information the manifest layer can attach to a playlist candidate. */
export interface AttachPlaylistExtra {
  /** Playlist kind, when parsing discovers it (e.g. candidate `m3u8` turns out to be a master). */
  type?: MediaType;
  duration?: MediaDuration;
  has_drm?: boolean;
  subtitles?: SubtitleTrack[];
  /** Demuxer for `m3u8` media playlists (`"mp4"` by default, `"mp3"` audio-only sites). */
  demuxer?: string;
  /**
   * Raw manifest text. When present the engine recomputes the original body-seeded hash
   * (D27) and re-keys the registry entry; without it the candidate URL-seeded hash is kept.
   */
  manifestText?: string;
}

interface SendHeadersRecord {
  timeStamp: number;
  headers: HeaderPair[];
}

interface TabRegistry {
  media: Map<string, MediaItem>;
  fifo: boolean;
}

const EMPTY_MEDIA_MAP: ReadonlyMap<string, MediaItem> = new Map();

/** Build a `Headers` object from chrome-style header pairs; invalid pairs are skipped (D8). */
function headersFromPairs(pairs: readonly HeaderPair[] | undefined): Headers {
  const headers = new Headers();
  if (!pairs) return headers;
  for (const pair of pairs) {
    if (!pair.value) continue; // original `if (c)` (D8)
    try {
      headers.append(pair.name, pair.value);
    } catch {
      // Original logs "Failed to add header. Invalid header?" and continues (D8).
    }
  }
  return headers;
}

/** Render a printable URL from a parsed URL for use in hashes/keys. */
function hrefOf(url: URL | undefined): string | undefined {
  return url ? url.href : undefined;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Stateful, per-service-worker discovery engine.
 *
 * The engine is pure aside from its own registries: all side effects (network, storage, messages)
 * belong to the host. Call `onSendHeaders` for every matching request, then `onResponseStarted`
 * for the response; a non-null return is the detected item (which is also inserted into the
 * per-tab registry unless the dedupe/filter rules say otherwise).
 */
export class DiscoveryEngine {
  private readonly deps: DiscoveryDeps;
  private readonly sendHeaders = new Map<string, SendHeadersRecord>();
  /** Initiator URLs already claimed by a DASH playlist (D16); value = timestamp for TTL pruning. */
  private readonly initiatorSeen = new Map<string, number>();
  private lastPruneTimestamp = 0;
  private readonly tabs = new Map<number, TabRegistry>();

  constructor(deps: DiscoveryDeps) {
    this.deps = deps;
  }

  // -- webRequest: onSendHeaders -------------------------------------------------------------

  /**
   * Record `requestId → [timeStamp, requestHeaders]` (D6). The TTL cleanup is lazy: it runs only
   * when an event arrives more than 600 s after the previous cleanup, exactly like the original
   * (`d.timeStamp - u > s`).
   */
  onSendHeaders(event: SendHeadersEvent): void {
    if (event.timeStamp - this.lastPruneTimestamp > SEND_HEADERS_TTL_MS) {
      this.lastPruneTimestamp = event.timeStamp;
      this.prune(event.timeStamp);
    }
    if (event.requestHeaders) {
      this.sendHeaders.set(event.requestId, {
        timeStamp: event.timeStamp,
        headers: event.requestHeaders,
      });
    }
  }

  private prune(referenceTime: number): void {
    for (const [requestId, record] of this.sendHeaders) {
      if (referenceTime - record.timeStamp > SEND_HEADERS_TTL_MS)
        this.sendHeaders.delete(requestId);
    }
    for (const [initiatorHref, seenAt] of this.initiatorSeen) {
      if (referenceTime - seenAt > SEND_HEADERS_TTL_MS)
        this.initiatorSeen.delete(initiatorHref);
    }
  }

  // -- webRequest: onResponseStarted ---------------------------------------------------------

  /**
   * `NS` + branch dispatch (D9/D10) followed by `OS` (D17) when no playlist signal matched.
   * Returns `null` when the response is rejected at any stage.
   */
  onResponseStarted(event: ResponseStartedEvent): MediaItem | null {
    if (event.statusCode < 200 || event.statusCode > 299) return null; // D9 step 1

    const initiator = tryUrl(event.initiator);
    if (initiator) {
      if (this.flag("BLOCK_MEDIA_DETECTION", initiator.hostname)) return null; // D9 step 2
      if (EXTENSION_INITIATOR_PATTERN.test(initiator.href)) return null;
      if (!initiator.href.startsWith("http")) return null;
    }

    const responseHeaders = headersFromPairs(event.responseHeaders);
    const mediaUrl = tryUrl(event.url);

    if (mediaUrl) {
      if (SEGMENT_PATH_PATTERN.test(mediaUrl.pathname)) return null; // D9 step 3
      // D9 step 4: the original forwards Vimeo/IQ config payloads to site adapters and stops.
      // Adapters are out of scope; both hosts are in the blocked set below, so drop normally.
    }

    if (initiator && isBlockedInitiatorHost(initiator.hostname)) return null; // D9 step 5

    // D9 step 6: non-tab requests are ignored unless an http(s) page initiated them.
    if (event.tabId <= 0 && (!initiator || !initiator.href.startsWith("http")))
      return null;

    const contentType = responseHeaders.get("content-type") ?? undefined;

    if (PLAYLIST_SNIFF_RESOURCE_TYPES.has(event.type)) {
      const hlsSignal =
        HLS_CONTENT_TYPE_PATTERN.test(contentType ?? "") ||
        HLS_URL_PATTERN.test(event.url) ||
        HLS_MASTER_API_PATTERN.test(event.url);
      if (hlsSignal) {
        const hls = this.createHlsCandidate(event, initiator, mediaUrl);
        if (hls) return hls;
      }

      // CONVERT_MPD_URL_TO_M3U8: rewrite the first `.mpd` occurrence and treat as HLS (D10).
      if (
        initiator &&
        this.flag("CONVERT_MPD_URL_TO_M3U8", initiator.host) &&
        MPD_EXTENSION_PATTERN.test(event.url)
      ) {
        const rewritten = tryUrl(event.url.replace(".mpd", ".m3u8"));
        const converted = this.createHlsCandidate(event, initiator, rewritten);
        if (converted) return converted;
      }

      const dashSignal =
        DASH_CONTENT_TYPE_PATTERN.test(contentType ?? "") ||
        DASH_URL_PATTERN.test(event.url);
      if (dashSignal) {
        const dash = this.createDashCandidate(event, initiator, mediaUrl);
        if (dash) return dash;
      }
    }

    // D10 tail: direct media-file branch.
    const demuxer = mimeToDemuxer(contentType);
    if (event.type === "media" || demuxer !== undefined) {
      return this.createDirectItem(
        event,
        initiator,
        responseHeaders,
        mediaUrl,
        demuxer,
      );
    }
    return null;
  }

  // -- branch builders -----------------------------------------------------------------------

  /** HLS candidate (`Ef` stand-in): the manifest body is parsed by the manifest layer. */
  private createHlsCandidate(
    event: ResponseStartedEvent,
    initiator: URL | undefined,
    mediaUrl: URL | undefined,
  ): MediaItem | null {
    if (!mediaUrl) return null; // original `Ef` returns false when `de(i)` is None (D12)
    const audioOnly =
      initiator !== undefined &&
      this.flag("AUDIO_ONLY_WEBSITES", initiator.hostname);
    const canonicalUrl = canonicalHlsManifestUrl(mediaUrl);
    const item: MediaItem = {
      type: "m3u8",
      hash: directMediaHash(canonicalUrl), // provisional; replaced when manifestText is attached (D27)
      is_youtube: false,
      sent_headers: this.replayHeaders(event.requestId),
      initiator,
      url: canonicalUrl,
      demuxer: audioOnly ? "mp3" : "mp4",
      duration: "unknown",
      has_drm: false,
      cache: "default",
      discovery_timestamp_ms: this.deps.now(),
    };
    this.register(item, event.tabId);
    return item;
  }

  /** DASH candidate (`IS` stand-in): the MPD body is parsed by the manifest layer. */
  private createDashCandidate(
    event: ResponseStartedEvent,
    initiator: URL | undefined,
    mediaUrl: URL | undefined,
  ): MediaItem | null {
    if (!mediaUrl) return null; // original `IS` returns false when `de(n)` is None (D13)
    const item: MediaItem = {
      type: "mpd_playlist",
      hash: directMediaHash(mediaUrl), // provisional; replaced when manifestText is attached (D27)
      is_youtube: false,
      sent_headers: this.replayHeaders(event.requestId),
      initiator,
      master_url: mediaUrl,
      playlist: [],
      duration: "unknown",
      has_drm: false,
      cache: "default",
      discovery_timestamp_ms: this.deps.now(),
    };
    this.register(item, event.tabId);
    return item;
  }

  /** `OS` (D17): accept/reject decision for a direct media response, then build the item (D14). */
  private createDirectItem(
    event: ResponseStartedEvent,
    initiator: URL | undefined,
    responseHeaders: Headers,
    mediaUrl: URL | undefined,
    mimeDemuxer: string | undefined,
  ): MediaItem | null {
    if (!mediaUrl) return null; // original `OS` returns false when `de(n.url)` is None

    // Size: content-length, overridden by the total of `content-range: bytes a-b/total` (D17).
    let rawSize: string | null = responseHeaders.get("content-length");
    const contentRange = responseHeaders.get("content-range");
    if (typeof contentRange === "string")
      rawSize = contentRange.split("/")[1] || rawSize;

    let size: number | undefined;
    if (rawSize) {
      const parsed = Number.parseInt(rawSize, 10);
      if (!Number.isNaN(parsed)) {
        size = parsed;
        if (
          parsed < SMALL_FILE_THRESHOLD_BYTES &&
          !this.flag("ALLOW_SMALL_FILE_DETECTION", mediaUrl.hostname)
        ) {
          return null; // small-file noise filter (D17)
        }
      }
    }

    // D16: a DASH playlist already accepted for this initiator claims its remaining responses
    // unless the direct response is large (>= 20 MB).
    if (initiator && this.initiatorSeen.has(initiator.href)) {
      if (size === undefined || size < INITIATOR_SUPPRESSION_THRESHOLD_BYTES)
        return null;
    }

    const supportsByteRanges =
      responseHeaders.get("accept-ranges") === "bytes" ||
      responseHeaders.has("content-range");
    const descriptor = resolveMediaDescriptor(
      responseHeaders.get("content-disposition") ?? undefined,
      responseHeaders.get("content-type") ?? undefined,
      mediaUrl,
    );

    const entry: PlaylistEntry = {
      quality: {},
      demuxer: mimeDemuxer ?? "mp4", // original `m.unwrapOr("mp4")` (D14)
      av: { video: mediaUrl, audio: false },
      ...(size !== undefined ? { size } : {}),
    };
    const item: MediaItem = {
      type: "http_playlist",
      hash: directMediaHash(mediaUrl), // D27
      is_youtube: false,
      sent_headers: this.replayHeaders(event.requestId),
      initiator,
      playlist: [entry],
      libav_demuxer: descriptor.libavDemuxer,
      extension: descriptor.extension,
      filename: descriptor.filename,
      supports_byte_ranges: supportsByteRanges,
      duration: "unknown",
      has_drm: false,
      cache: "default",
      discovery_timestamp_ms: this.deps.now(),
    };
    this.register(item, event.tabId);
    return item;
  }

  // -- manifest enrichment -------------------------------------------------------------------

  /**
   * Enrich an existing playlist candidate with parsed renditions (`Ef`/`IS` stand-in).
   *
   * When `extra.manifestText` is supplied the hash is recomputed with the original seed rule
   * (D27) and the registry entry re-keyed; if the canonical hash is already present the existing
   * entry is kept (original dedupe semantics, D31).
   */
  attachPlaylist(
    tabId: number,
    hash: string,
    playlist: PlaylistEntry[],
    extra: AttachPlaylistExtra = {},
  ): MediaItem | null {
    const tab = this.tabs.get(tabId);
    const item = tab?.media.get(hash);
    if (!tab || !item) return null;

    item.playlist = playlist;
    if (extra.duration !== undefined) item.duration = extra.duration;
    if (extra.has_drm !== undefined) item.has_drm = extra.has_drm;
    if (extra.subtitles !== undefined) item.subtitles = extra.subtitles;
    if (extra.demuxer !== undefined) item.demuxer = extra.demuxer;

    const nextType = extra.type ?? item.type;
    if (nextType === "m3u8_playlist" && item.type !== "m3u8_playlist") {
      // Candidate `m3u8` was actually a master playlist: promote and move `url` to `master_url`.
      item.master_url = item.master_url ?? item.url;
      delete item.url;
    }
    item.type = nextType;

    const canonicalHash = this.canonicalHash(item, extra.manifestText);
    if (canonicalHash !== undefined && canonicalHash !== hash) {
      if (tab.media.has(canonicalHash)) {
        tab.media.delete(hash);
        return tab.media.get(canonicalHash) ?? null;
      }
      tab.media.delete(hash);
      item.hash = canonicalHash;
      tab.media.set(canonicalHash, item);
    }

    // A parsed playlist supersedes weaker items just like a fresh detection would (D31).
    this.supersede(item, tab);
    if (tab.fifo) this.trimFifo(tab.media);

    // D16: mark the initiator only once the DASH manifest actually parsed.
    if (item.type === "mpd_playlist" && item.initiator) {
      this.initiatorSeen.set(item.initiator.href, this.deps.now());
    }
    return item;
  }

  private canonicalHash(
    item: MediaItem,
    manifestText: string | undefined,
  ): string | undefined {
    if (manifestText === undefined) return undefined;
    if (item.type === "mpd_playlist") return dashPlaylistHash(manifestText);
    if (item.type === "m3u8_playlist") {
      const masterUrl = item.master_url ?? item.url;
      return masterUrl ? hlsPlaylistHash(manifestText, masterUrl) : undefined;
    }
    if (item.type === "m3u8") {
      return item.url ? hlsPlaylistHash(manifestText, item.url) : undefined;
    }
    return undefined;
  }

  // -- per-tab registry ----------------------------------------------------------------------

  /** Read-only view of a tab's media map, keyed by item hash (D29). */
  mediaForTab(tabId: number): ReadonlyMap<string, MediaItem> {
    return this.tabs.get(tabId)?.media ?? EMPTY_MEDIA_MAP;
  }

  /** Tabs currently holding a registry entry (D29). */
  tabIds(): number[] {
    return [...this.tabs.keys()];
  }

  /** Navigation/tab-close eviction: drop everything discovered for the tab (D32). */
  clearTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  /** `dismiss_media` / `remove_media` equivalent: drop one item from a tab (D34). */
  removeMedia(tabId: number, hash: string): void {
    this.tabs.get(tabId)?.media.delete(hash);
  }

  /** `Eu` (D15): replay the request headers recorded for `requestId`; empty when unknown. */
  replayHeaders(requestId: string): Headers {
    return headersFromPairs(this.sendHeaders.get(requestId)?.headers);
  }

  private flag(flag: BehaviourFlag, host: string): boolean {
    return this.deps.flags.enabled(flag, host);
  }

  /**
   * Register an item produced by a content-script adapter rather than by webRequest sniffing.
   *
   * This is the rebuilt equivalent of the original's site adapters posting `on_media` messages:
   * the same registry rules apply (dedupe by hash, accept filter, playlist supersede, FIFO trim).
   * Returns the registered item, or null when the tab id is unusable.
   */
  insertExternal(item: MediaItem, tabId: number): MediaItem | null {
    if (tabId <= 0) return null;
    this.register(item, tabId);
    return this.tabs.get(tabId)?.media.get(item.hash) ?? null;
  }

  /**
   * Replace the volatile fields of an already registered item (YouTube rotates the signed URL of
   * the same tracks on every player response, while the adapter hash stays stable).
   */
  refreshExternal(item: MediaItem, tabId: number): boolean {
    const existing = this.tabs.get(tabId)?.media.get(item.hash);
    if (!existing) return false;
    if (item.url !== undefined) existing.url = item.url;
    if (item.master_url !== undefined) existing.master_url = item.master_url;
    // An adapter refresh often carries only a fresh URL; never erase a playlist that the
    // manifest layer already enriched, or every refresh triggers another enrichment/probe.
    if (item.playlist !== undefined) existing.playlist = item.playlist;
    existing.sent_headers = item.sent_headers;
    if (item.thumbnail_url !== undefined) existing.thumbnail_url = item.thumbnail_url;
    if (item.preview_url !== undefined) existing.preview_url = item.preview_url;
    if (item.hls_url !== undefined) existing.hls_url = item.hls_url;
    if (item.rendered_width !== undefined) existing.rendered_width = item.rendered_width;
    if (item.rendered_height !== undefined) existing.rendered_height = item.rendered_height;
    if (item.estimated_bitrate !== undefined) existing.estimated_bitrate = item.estimated_bitrate;
    if (item.duration !== undefined) existing.duration = item.duration;
    if (item.title !== undefined) existing.title = item.title;
    existing.discovery_timestamp_ms = item.discovery_timestamp_ms;
    return true;
  }

  private register(item: MediaItem, tabId: number): void {
    // The original stores tab_id None and resolves the owning tab from the initiator in the
    // service layer (D29); that service-layer lookup is out of scope for this engine.
    if (tabId <= 0) return;
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = {
        media: new Map(),
        fifo:
          item.initiator !== undefined &&
          this.flag("FIFO_DISCOVERED_WEBSITES", item.initiator.hostname),
      };
      this.tabs.set(tabId, tab);
    }
    if (tab.media.has(item.hash)) return; // dedupe by hash is a no-op, no field merge (D31)
    if (!this.accepts(item, tab.media)) return;
    this.insert(item, tab);
  }

  /** `Vy` (D30): cross-item accept-filter evaluated against the tab's live map. */
  private accepts(
    item: MediaItem,
    media: ReadonlyMap<string, MediaItem>,
  ): boolean {
    const initiator = item.initiator;
    if (initiator && this.flag("BLOCK_MEDIA_DETECTION", initiator.hostname))
      return false;

    const isPlaylistish = item.type !== "http_playlist" && item.type !== "m3u8";
    const isFifo =
      initiator !== undefined &&
      this.flag("FIFO_DISCOVERED_WEBSITES", initiator.hostname);
    if (!isPlaylistish && !isFifo) {
      const hasPlaylistItem = [...media.values()].some(
        (existing) =>
          existing.type === "m3u8_playlist" ||
          existing.type === "mpd_playlist" ||
          existing.type === "youtube_format",
      );
      if (
        hasPlaylistItem &&
        initiator &&
        this.flag("FILTER_HTTP_M3U8_MEDIA", initiator.hostname)
      ) {
        return false;
      }
      const sameTypeCount = [...media.values()].filter(
        (existing) => existing.type === item.type,
      ).length;
      if (sameTypeCount > SAME_TYPE_ITEM_CAP) return false;
    }

    // A media-playlist URL already covered by a parsed master playlist cannot come back (D30 #5).
    if (item.type === "m3u8" && item.url) {
      for (const existing of media.values()) {
        if (existing.type !== "m3u8_playlist" || !existing.playlist) continue;
        for (const entry of existing.playlist) {
          if (entry.av?.audio && entry.av.audio.href === item.url.href)
            return false;
          if (entry.av?.video && entry.av.video.href === item.url.href)
            return false;
        }
      }
    }
    return true;
  }

  /** `Vx` (D31): insert plus supersede rules, then FIFO trim for bounded sites. */
  private insert(item: MediaItem, tab: TabRegistry): void {
    tab.media.set(item.hash, item);
    this.supersede(item, tab);
    if (tab.fifo) this.trimFifo(tab.media);
  }

  /** Supersede rules shared by fresh detection (`Vx`) and manifest enrichment (D31). */
  private supersede(item: MediaItem, tab: TabRegistry): void {
    const media = tab.media;

    if (item.type === "m3u8_playlist" && item.playlist) {
      const sources = new Set<string>();
      for (const entry of item.playlist) {
        if (entry.av?.audio) sources.add(entry.av.audio.href);
        if (entry.av?.video) sources.add(entry.av.video.href);
      }
      for (const [hash, existing] of [...media.entries()]) {
        if (
          existing.type === "m3u8" &&
          existing.url &&
          sources.has(existing.url.href)
        ) {
          media.delete(hash);
        }
      }
    }

    if (item.type === "mpd_playlist") {
      const initiatorHref = hrefOf(item.initiator);
      for (const [hash, existing] of [...media.entries()]) {
        if (existing.type !== "http_playlist") continue;
        const sameInitiator =
          initiatorHref !== undefined &&
          existing.initiator?.href === initiatorHref;
        const entrySize = existing.playlist?.[0]?.size;
        const large =
          entrySize !== undefined &&
          entrySize > INITIATOR_SUPPRESSION_THRESHOLD_BYTES;
        if (sameInitiator && !large) media.delete(hash);
      }
    }
  }

  private trimFifo(media: Map<string, MediaItem>): void {
    while (media.size > FIFO_DISCOVERED_ITEM_CAP) {
      const oldest = media.keys().next();
      if (oldest.done) break;
      media.delete(oldest.value);
    }
  }
}
