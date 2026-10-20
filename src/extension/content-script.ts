/**
 * ISOLATED-world content script: bridges the page-world hook and the service worker.
 *
 * Evidence: 01-messaging-runtime.md §1-2 — the shipped isolated scripts speak to the MAIN-world
 * scripts over a per-page `BroadcastChannel("injected-<cyrb53(location.href)>")` (channels 4/5)
 * and to the service worker over `chrome.runtime.sendMessage` with channel 0. This is the
 * rebuilt reference adapter: it turns page hints into media items and posts them as `on_media`.
 *
 * Hint kinds map onto the same item types the network sniffer produces, so the service worker's
 * manifest enrichment, planning and transfer layers work unchanged:
 *   hls  -> `m3u8` candidate (enriched into `m3u8_playlist` by the service)
 *   dash -> `mpd_playlist`
 *   file -> `http_playlist` with a single direct entry
 */
import { Channel, cyrb53 } from "../protocol/channels.js";
import { MSG } from "../protocol/messages.js";
import { REBUILD_MESSAGES, RELAY_MESSAGES } from "../protocol/rebuild-messages.js";
import { encode } from "../protocol/serde.js";
import type { MediaItem, PlaylistEntry } from "../core/types.js";
import {
  PAGE_ON_MEDIA_HINTS,
  PAGE_REQUEST_MEDIA_HINTS,
  classifyHintUrl,
  fileHintRank,
  fileIdentity,
  instagramAssetKey,
  type HintVariant,
  type PageMediaHint,
} from "./media-hint.js";
import type { Envelope } from "./gateways.js";

export { PAGE_REQUEST_MEDIA_HINTS, PAGE_ON_MEDIA_HINTS };
export type { PageMediaHint };

/**
 * Stable identity for YouTube media: page video id + video/audio itags.
 *
 * Every InnerTube response signs the same tracks with a new `expire`/`sig`/`id=o-...` query, so
 * URL-based hashes would create a duplicate panel row every time the page is re-queried.
 */
export function youtubeMediaIdentity(initiator: URL): string | undefined {
  try {
    if (!/(^|\.)youtube\.com$/u.test(initiator.hostname) && !/(^|\.)youtu\.be$/u.test(initiator.hostname)) {
      return undefined;
    }
    let videoId = initiator.searchParams.get("v") ?? undefined;
    if (videoId === undefined) {
      const shorts = /\/shorts\/([\w-]{6,})/u.exec(initiator.pathname);
      if (shorts?.[1] !== undefined) videoId = shorts[1];
      else if (/(^|\.)youtu\.be$/u.test(initiator.hostname)) videoId = initiator.pathname.split("/")[1];
    }
    if (videoId === undefined || videoId.length === 0) return undefined;
    // One panel row per video; quality selection happens on the item's playlist entries.
    return `yt:${videoId}`;
  } catch {
    return undefined;
  }
}

/** Build the media item the adapter reports for one page hint. */
export function itemFromHint(hint: PageMediaHint, pageUrl: string): MediaItem | undefined {
  let initiator: URL;
  try {
    initiator = new URL(pageUrl);
  } catch {
    return undefined;
  }
  let classified: ReturnType<typeof classifyHintUrl>;
  if (hint.allow_segment === true && hint.kind === "file") {
    try {
      const parsed = new URL(hint.url, pageUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") classified = { url: parsed.href, kind: "file" };
    } catch {
      /* fall through to the normal classifier */
    }
  }
  classified ??= classifyHintUrl(hint.url, pageUrl);
  if (!classified) return undefined;
  const url = new URL(classified.url);

  const headers = new Headers();
  // The page URL is the natural referer for CDN fetches; YouTube/Instagram require it in places.
  // Treat every page-controlled header value as untrusted: no control characters, no throw.
  const referer =
    typeof hint.referer === "string" && hint.referer.length > 0 && !/[\r\n\0]/u.test(hint.referer)
      ? hint.referer
      : initiator.href;
  try {
    headers.set("referer", referer);
  } catch {
    headers.set("referer", initiator.href);
  }
  if (typeof hint.referer === "string") {
    try {
      const parsed = new URL(hint.referer, initiator.href);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin !== "null") {
        headers.set("origin", parsed.origin);
      }
    } catch {
      /* malformed page referer: keep the page referer only */
    }
  }

  // Label single-track candidates so a silent/audio download is not surprising.
  const rank = fileHintRank(url);
  const trackLabel = rank === 3 ? "single track" : rank === 2 ? "audio only" : undefined;
  const displayTitle =
    hint.title !== undefined && trackLabel !== undefined ? `${hint.title} (${trackLabel})` : hint.title;

  let previewUrl: URL | undefined;
  if (hint.preview !== undefined) {
    try {
      const candidate = new URL(hint.preview, pageUrl);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") previewUrl = candidate;
    } catch {
      /* ignore malformed previews */
    }
  }

  let hlsUrl: URL | undefined;
  if (hint.hls_url !== undefined) {
    try {
      const candidate = new URL(hint.hls_url, pageUrl);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") hlsUrl = candidate;
    } catch {
      /* ignore malformed alternatives */
    }
  }

  let thumbnailUrl: URL | undefined;
  if (hint.thumbnail !== undefined) {
    try {
      const candidate = new URL(hint.thumbnail, pageUrl);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") thumbnailUrl = candidate;
    } catch {
      /* ignore malformed thumbnails */
    }
  }

  const instagramIdentity = (() => {
    if (/(^|\.)instagram\.com$/u.test(initiator.hostname) === false) return undefined;
    const asset = instagramAssetKey(url.href);
    if (asset !== undefined) return `ig:asset:${asset}`;
    // No efg tag: the CDN path is stable while the signed query rotates. Do not use the post
    // shortcode here; a carousel/feed post can contain several distinct direct assets.
    return `ig:path:${url.origin}${url.pathname}`;
  })();
  const stableIdentity =
    youtubeMediaIdentity(initiator) ??
    (typeof hint.identity === "string" && hint.identity.length > 0 ? hint.identity : undefined) ??
    instagramIdentity;
  const base: MediaItem = {
    type: "http_playlist",
    // YouTube signs every player response differently; identity is video + track itags, not URL.
    hash: `media_hash_${cyrb53(stableIdentity ?? url.href)}`,
    is_youtube: /(^|\.)youtube\.com$/u.test(initiator.hostname) || /(^|\.)youtu\.be$/u.test(initiator.hostname),
    sent_headers: headers,
    initiator,
    ...(thumbnailUrl !== undefined ? { thumbnail_url: thumbnailUrl } : {}),
    ...(previewUrl !== undefined ? { preview_url: previewUrl } : {}),
    ...(hlsUrl !== undefined ? { hls_url: hlsUrl } : {}),
    discovery_timestamp_ms: Date.now(),
    cache: "default",
    ...(hint.durationSeconds !== undefined && Number.isFinite(hint.durationSeconds)
      ? { duration: hint.durationSeconds }
      : {}),
    ...(displayTitle !== undefined ? { title: displayTitle } : {}),
    ...(hint.rendered_width !== undefined ? { rendered_width: hint.rendered_width } : {}),
    ...(hint.rendered_height !== undefined ? { rendered_height: hint.rendered_height } : {}),
    ...(hint.estimated_bitrate !== undefined ? { estimated_bitrate: hint.estimated_bitrate } : {}),
  };

  if (classified.kind === "hls") {
    return {
      ...base,
      type: "m3u8",
      master_url: url,
      url,
      demuxer: "mp4",
    };
  }
  if (classified.kind === "dash") {
    return {
      ...base,
      type: "mpd_playlist",
      master_url: url,
    };
  }

  const identity = fileIdentity(url);
  const pairSources =
    hint.variants !== undefined && hint.variants.length > 0
      ? hint.variants
      : hint.audio_url !== undefined
        ? [{ url: url.href, audio_url: hint.audio_url }]
        : [];
  if (pairSources.length > 0) {
    const entries: PlaylistEntry[] = [];
    for (const variant of pairSources) {
      let videoUrl: URL;
      try {
        videoUrl = new URL(variant.url, pageUrl);
      } catch {
        continue;
      }
      if (videoUrl.protocol !== "http:" && videoUrl.protocol !== "https:") continue;
      let audioUrl: URL | false = false;
      if (variant.audio_url !== undefined) {
        try {
          const parsed = new URL(variant.audio_url, pageUrl);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") audioUrl = parsed;
        } catch {
          audioUrl = false;
        }
      }
      const demuxer =
        variant.demuxer ?? (typeof variant.mime === "string" && /webm/iu.test(variant.mime) ? "webm" : "mp4");
      entries.push({
        demuxer,
        quality: {
          ...(variant.height !== undefined
            ? { size: { height: variant.height, ...(variant.width !== undefined ? { width: variant.width } : {}) } }
            : {}),
          ...(variant.bitrate !== undefined ? { bitrate: variant.bitrate } : {}),
        },
        ...(variant.size !== undefined ? { size: variant.size } : {}),
        av: { video: videoUrl, audio: audioUrl },
      });
    }
    if (entries.length === 0) return undefined;
    // Native container of the default rendition; per-entry demuxers drive the plan container.
    const nativeDemuxer = entries[0]?.demuxer ?? "mp4";
    return {
      ...base,
      type: "http_playlist",
      libav_demuxer: nativeDemuxer,
      extension: nativeDemuxer === "webm" ? "webm" : "mp4",
      supports_byte_ranges: true,
      playlist: entries,
    };
  }
  return {
    ...base,
    type: "http_playlist",
    playlist: [
      {
        demuxer: identity.demuxer,
        quality: {},
        av: { video: url, audio: false },
      },
    ],
    extension: identity.extension,
    libav_demuxer: identity.demuxer,
    supports_byte_ranges: false,
  };
}

/** Bytes -> base64 without blowing the call stack on large chunks. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

/**
 * Fetch media in the page's own context and stream it to the service worker.
 *
 * Runs in the ISOLATED world, so the request carries the page's origin/credentials/CORS
 * allowances — exactly the context whose requests the CDN already accepts.
 */
export async function handleMediaStreamRequest(
  runtime: RuntimeLike,
  data: { request_id: string; url: string },
): Promise<void> {
  /** Bounded ranges: googlevideo rejects plain GETs and open-ended ranges. */
  const RANGE_BYTES = 2 * 1024 * 1024;
  const MESSAGE_CHUNK_BYTES = 512 * 1024;
  /** Relays must stop cleanly when the extension was reloaded mid-transfer. */
  const sendRelay = async (message: Envelope): Promise<boolean> => {
    try {
      await runtime.sendMessage(message);
      return true;
    } catch {
      return false;
    }
  };
  try {
    let offset = 0;
    let seq = 0;
    let total = 0;
    for (let attempt = 0; attempt < 20000; attempt += 1) {
      const end = offset + RANGE_BYTES - 1;
      const response = await fetch(data.url, {
        credentials: "include",
        cache: "no-store",
        headers: { Range: `bytes=${offset}-${end}` },
      });
      // 416 means the previous chunk ended at the object size.
      if (response.status === 416 && offset > 0) break;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = new Uint8Array(await response.arrayBuffer());
      if (value.length === 0) break;
      for (let inner = 0; inner < value.length; inner += MESSAGE_CHUNK_BYTES) {
        const slice = value.subarray(inner, Math.min(inner + MESSAGE_CHUNK_BYTES, value.length));
        const sent = await sendRelay({
          msg: {
            name: RELAY_MESSAGES.MediaStreamChunk,
            data: { request_id: data.request_id, seq: seq++, data: bytesToBase64(slice) },
          },
          channel: Channel.FromInjectedToService,
        });
        if (!sent) return;
      }
      offset += value.length;
      total += value.length;
      // A short chunk means we reached the end of the object.
      if (value.length < RANGE_BYTES) break;
    }
    await sendRelay({
      msg: { name: RELAY_MESSAGES.MediaStreamEnd, data: { request_id: data.request_id, total } },
      channel: Channel.FromInjectedToService,
    });
  } catch (error) {
    await sendRelay({
      msg: {
        name: RELAY_MESSAGES.MediaStreamError,
        data: { request_id: data.request_id, error: String(error) },
      },
      channel: Channel.FromInjectedToService,
    });
  }
}

interface RuntimeLike {
  sendMessage(message: Envelope): Promise<unknown>;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
}

/** Attach the bridge. Returns a disposer. */
export function installContentBridge(
  runtime: RuntimeLike,
  pageUrl: string,
  channel: BroadcastChannel,
): () => void {
  /** Hash → last report time. Re-reporting keeps the service in sync after a worker eviction. */
  const lastSentAt = new Map<string, number>();
  const lastSentVariants = new Map<string, number>();
  const REPORT_REFRESH_MS = 15_000;
  let seenHref = globalThis.location?.href ?? "";
  let lastFocusedSignature = "";
  /** The old content script outlives an extension reload; its runtime calls then throw. */
  let invalidated = false;
  // Consumed by the service worker's healing probe after an extension reload.
  (globalThis as { __mediaDownloaderBridgePing?: () => boolean }).__mediaDownloaderBridgePing = () => !invalidated;
  const sendToService = (message: Envelope): void => {
    if (invalidated) return;
    try {
      const result = runtime.sendMessage(message) as unknown;
      if (result !== null && typeof result === "object" && typeof (result as Promise<unknown>).catch === "function") {
        void (result as Promise<unknown>).catch(() => {
          invalidated = true;
        });
      }
    } catch {
      invalidated = true;
    }
  };
  /** Page-supplied hints are untrusted input: bound the array, reject malformed entries. */
  const sanitizeHints = (value: unknown): PageMediaHint[] => {
    if (!Array.isArray(value)) return [];
    const hints: PageMediaHint[] = [];
    for (const candidate of value.slice(0, 200)) {
      if (candidate === null || typeof candidate !== "object") continue;
      const hint = candidate as Record<string, unknown>;
      if (typeof hint.url !== "string" || hint.url.length === 0 || hint.url.length > 8192) continue;
      const kind = hint.kind === "hls" || hint.kind === "dash" || hint.kind === "file" ? hint.kind : "file";
      const source = typeof hint.source === "string" ? hint.source : "player-response";
      const rawVariants = Array.isArray(hint.variants) ? hint.variants.slice(0, 40) : [];
      const variants: HintVariant[] = [];
      for (const candidate of rawVariants) {
        if (candidate === null || typeof candidate !== "object") continue;
        const variant = candidate as Record<string, unknown>;
        if (typeof variant.url !== "string" || variant.url.length === 0 || variant.url.length > 8192) continue;
        const number = (value: unknown): number | undefined =>
          typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
        variants.push({
          url: variant.url,
          ...(typeof variant.audio_url === "string" && variant.audio_url.length <= 8192
            ? { audio_url: variant.audio_url }
            : {}),
          ...(typeof variant.mime === "string" ? { mime: variant.mime.slice(0, 64) } : {}),
          ...(variant.demuxer === "mp4" || variant.demuxer === "webm" ? { demuxer: variant.demuxer } : {}),
          ...(typeof variant.itag === "number" ? { itag: variant.itag } : {}),
          ...(number(variant.width) !== undefined ? { width: number(variant.width) } : {}),
          ...(number(variant.height) !== undefined ? { height: number(variant.height) } : {}),
          ...(number(variant.bitrate) !== undefined ? { bitrate: number(variant.bitrate) } : {}),
          ...(number(variant.size) !== undefined ? { size: number(variant.size) } : {}),
        });
      }
      hints.push({
        url: hint.url,
        ...(variants.length > 0 ? { variants } : {}),
        ...(typeof hint.audio_url === "string" && hint.audio_url.length <= 8192
          ? { audio_url: hint.audio_url }
          : {}),
        ...(typeof hint.thumbnail === "string" && hint.thumbnail.length <= 2048
          ? { thumbnail: hint.thumbnail }
          : {}),
        ...(typeof hint.preview === "string" && hint.preview.length <= 8192
          ? { preview: hint.preview }
          : {}),
        ...(hint.focused === true ? { focused: true } : {}),
        kind,
        source: source as PageMediaHint["source"],
        ...(typeof hint.durationSeconds === "number" && Number.isFinite(hint.durationSeconds)
          ? { durationSeconds: hint.durationSeconds }
          : {}),
        ...(typeof hint.title === "string" ? { title: hint.title.slice(0, 300) } : {}),
        ...(typeof hint.identity === "string" ? { identity: hint.identity.slice(0, 200) } : {}),
        ...(hint.allow_segment === true ? { allow_segment: true } : {}),
        ...(typeof hint.hls_url === "string" && hint.hls_url.length <= 8192 ? { hls_url: hint.hls_url } : {}),
        ...(typeof hint.rendered_width === "number" && Number.isFinite(hint.rendered_width) && hint.rendered_width > 0
          ? { rendered_width: hint.rendered_width }
          : {}),
        ...(typeof hint.rendered_height === "number" && Number.isFinite(hint.rendered_height) && hint.rendered_height > 0
          ? { rendered_height: hint.rendered_height }
          : {}),
        ...(typeof hint.estimated_bitrate === "number" && Number.isFinite(hint.estimated_bitrate) && hint.estimated_bitrate > 0
          ? { estimated_bitrate: hint.estimated_bitrate }
          : {}),
        ...(typeof hint.referer === "string" && hint.referer.length <= 8192
          ? { referer: hint.referer }
          : {}),
      });
    }
    return hints;
  };

  const onPageMessage = (event: MessageEvent): void => {
    const envelope = event.data as { msg?: { name?: string; data?: unknown }; channel?: number };
    if (envelope?.channel !== Channel.FromUntrustedInjectedToTrusted) return;
    if (envelope.msg?.name !== PAGE_ON_MEDIA_HINTS) return;
    // The service clears a tab's media on navigation; re-arm playback of the same URL after it.
    const currentHref = globalThis.location?.href ?? "";
    if (currentHref !== seenHref) {
      seenHref = currentHref;
      lastSentAt.clear();
      lastSentVariants.clear();
    }
    if (envelope.msg.data === null || typeof envelope.msg.data !== "object") return;
    const data = envelope.msg.data as {
      hints?: PageMediaHint[];
      referer?: string;
      title?: string;
      focus_active?: boolean;
      focused_urls?: unknown;
    };
    const focusedUrls = Array.isArray(data.focused_urls)
      ? data.focused_urls
          .filter((value): value is string => typeof value === "string" && value.length <= 8192)
          .slice(0, 20)
      : [];
    if (data.focus_active === true && focusedUrls.length > 0) {
      const signature = focusedUrls.join("\n");
      if (signature !== lastFocusedSignature) {
        lastFocusedSignature = signature;
        sendToService({
          msg: { name: REBUILD_MESSAGES.MediaFocus, data: { urls: focusedUrls } },
          channel: Channel.FromContentToService,
        });
      }
    }
    const allHints = sanitizeHints(data.hints);
    const focusedHints = allHints.filter((hint) => hint.focused === true);
    const hintsToMap = data.focus_active === true && focusedHints.length > 0 ? focusedHints : allHints;
    for (const hint of hintsToMap) {
      const item = itemFromHint(
        {
          ...hint,
          ...(hint.referer === undefined && data.referer !== undefined ? { referer: data.referer } : {}),
          ...(hint.title === undefined && data.title !== undefined ? { title: data.title } : {}),
        },
        pageUrl,
      );
      if (!item) continue;
      const now = Date.now();
      const lastSent = lastSentAt.get(item.hash);
      const variantCount = item.playlist?.length ?? 0;
      const richer = variantCount > (lastSentVariants.get(item.hash) ?? 0);
      // Let a richer adapter answer replace a one-URL row immediately; otherwise keep the poll
      // deduplicated. Multi-quality items must not bypass dedupe on every 2s refresh.
      if (lastSent !== undefined && now - lastSent < REPORT_REFRESH_MS && !richer) continue;
      lastSentAt.set(item.hash, now);
      lastSentVariants.set(item.hash, variantCount);
      if (lastSentAt.size > 1000) {
        lastSentAt.clear();
        lastSentVariants.clear();
      }
      sendToService({
        msg: { name: MSG.injectedToService.OnMedia, data: { media: encode(item), tab_id: null } },
        channel: Channel.FromInjectedToService,
      });
    }
  };

  const onServiceMessage = (message: unknown): void => {
    const envelope = message as Envelope;
    if (envelope?.channel !== Channel.FromServiceToInjected) return;
    if (envelope.msg?.name === RELAY_MESSAGES.MediaStreamRequest) {
      void handleMediaStreamRequest(runtime, envelope.msg.data as { request_id: string; url: string });
      return;
    }
    // Forward service→injected traffic to the page world over the trusted→untrusted channel.
    channel.postMessage({ msg: envelope.msg, channel: Channel.FromTrustedInjectedToUntrusted });
  };

  channel.addEventListener("message", onPageMessage as EventListener);
  runtime.onMessage.addListener(onServiceMessage);

  const request = (): void => {
    if (invalidated) return;
    channel.postMessage({
      msg: { name: PAGE_REQUEST_MEDIA_HINTS, data: null },
      channel: Channel.FromTrustedInjectedToUntrusted,
    });
  };
  // The page hook is injected at document_start, so player data may appear later: poll for a
  // while, and re-ask whenever an SPA navigation changes the URL (YouTube/Instagram are SPAs).
  let lastHref = globalThis.location.href;
  let fastAttempts = 0;
  const fastTimer = setInterval(() => {
    fastAttempts += 1;
    if (fastAttempts > 20) {
      clearInterval(fastTimer);
      return;
    }
    request();
  }, 1500);
  // Long-lived slow refresh: after a service-worker eviction the page must not need a reload.
  const slowTimer = setInterval(() => {
    if (globalThis.document?.visibilityState === "visible") request();
  }, 10_000);
  let requestSoonTimer: ReturnType<typeof setTimeout> | undefined;
  const requestSoon = (): void => {
    if (requestSoonTimer !== undefined) return;
    requestSoonTimer = setTimeout(() => {
      requestSoonTimer = undefined;
      request();
    }, 400);
  };
  const navigationTimer = setInterval(() => {
    const href = globalThis.location.href;
    if (href === lastHref) return;
    lastHref = href;
    request();
  }, 1000);
  request();
  globalThis.document?.addEventListener("DOMContentLoaded", request, { once: true });
  globalThis.document?.addEventListener("visibilitychange", () => {
    if (globalThis.document.visibilityState === "visible") request();
  });
  // Playback/focus is the strongest "user is back" signal (alt-tab + replay).
  globalThis.document?.addEventListener("play", requestSoon, true);
  globalThis.document?.addEventListener("playing", requestSoon, true);
  globalThis.document?.addEventListener("focusin", requestSoon, true);
  globalThis.addEventListener?.("focus", requestSoon);

  return () => {
    clearInterval(fastTimer);
    clearInterval(navigationTimer);
    clearInterval(slowTimer);
    if (requestSoonTimer !== undefined) clearTimeout(requestSoonTimer);
    channel.removeEventListener("message", onPageMessage as EventListener);
    runtime.onMessage.removeListener(onServiceMessage);
  };
}

/** Real boot: resolve the extension runtime and connect the per-page channel. */
export function bootContentScript(): () => void {
  const scope = globalThis as {
    chrome?: { runtime: RuntimeLike };
    __mediaDownloaderContentBridgeInstalled?: boolean;
  };
  // Programmatic healing may re-run this file; the existing bridge wins.
  if (scope.__mediaDownloaderContentBridgeInstalled === true) return () => undefined;
  const chromeApi = scope.chrome;
  if (!chromeApi?.runtime) return () => undefined;
  scope.__mediaDownloaderContentBridgeInstalled = true;
  const channel = new BroadcastChannel(`injected-${cyrb53(globalThis.location.href)}`);
  return installContentBridge(chromeApi.runtime, globalThis.location.href, channel);
}

// Auto-boot when injected as a content script. Guarded so unit tests can import the module.
interface ContentRuntime {
  sendMessage?: unknown;
  getURL?: (path: string) => string;
}
const autoRuntime = (globalThis as { chrome?: { runtime?: ContentRuntime } }).chrome?.runtime;

if (autoRuntime && typeof autoRuntime.sendMessage === "function") {
  try {
    // page-hook.js is declared as a MAIN-world content script in the manifest; injecting a
    // second copy via a chrome-extension:// script tag is redundant and can be blocked as a
    // cross-origin resource attempt on sites with strict CSP (e.g. Brave on YouTube).
    bootContentScript();
    console.info("[media-downloader] content bridge active", globalThis.location.href);
  } catch (error) {
    console.error("[media-downloader] content bridge failed", error);
  }
}
