import type { MediaItem, PlaylistEntry, SubtitleTrack } from "../core/types.js";
import type { DiscoveryEngine } from "../discovery/engine.js";
import { parsePlaylist } from "../manifests/hls.js";
import { parseMpd } from "../manifests/dash.js";
import { probeMpegTsVideoSize } from "../manifests/ts-probe.js";
import { fetchBytes, headersForPlan, type FetchLike } from "../transfer/fetch.js";
import { isSafeManifestUrl } from "../transfer/url-safety.js";
import { BoundedCache } from "./bounded-cache.js";
import { debugInfo } from "./log.js";

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PROBE_BYTES = 2 * 1024 * 1024;

interface VariantProbe {
  duration?: MediaItem["duration"];
  extension?: "m2ts" | "mp4";
  hasDrm: boolean;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Fetches manifests and attaches playlist and quality information to discovered media. */
export class ManifestEnrichment {
  private readonly hlsQualityCache: BoundedCache<
    string,
    { size?: { width: number; height: number }; bitrate?: number }
  >;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly engine: DiscoveryEngine,
    now: () => number,
  ) {
    this.hlsQualityCache = new BoundedCache(100, 300_000, undefined, now);
  }

  async enrichHls(item: MediaItem, tabId: number): Promise<void> {
    const manifestUrl = item.master_url ?? item.url;
    if (!manifestUrl) return;
    const fetched = await fetchBytes(
      this.fetchImpl,
      manifestUrl.href,
      { headers: headersForPlan(item.sent_headers) },
      { maxBytes: MAX_MANIFEST_BYTES },
    );
    if (fetched.tag === "Err") return;
    const text = new TextDecoder().decode(fetched.value.bytes);
    const parsed = parsePlaylist(text, manifestUrl);
    if (parsed.kind === "invalid" || parsed.kind === "subtitle") return;

    if (parsed.kind === "media") {
      const quality = await this.probeHlsMediaQuality(parsed.segments[0], item);
      const entry: PlaylistEntry = {
        demuxer: item.demuxer ?? "mp4",
        quality,
        av: { video: manifestUrl, audio: false },
      };
      this.engine.attachPlaylist(tabId, item.hash, [entry], {
        type: "m3u8",
        duration: parsed.duration,
        extension: parsed.segments.some((segment) => segment.map !== undefined) ? "mp4" : "m2ts",
        has_drm: parsed.hasDrm,
        manifestText: text,
        ...(item.demuxer ? { demuxer: item.demuxer } : {}),
      });
      return;
    }

    const firstVariant = parsed.variants[0];
    const probeController = new AbortController();
    const probe = firstVariant
      ? await withTimeout(
          this.fetchVariantProbe(firstVariant.uri, item.sent_headers, probeController.signal),
          5000,
          { hasDrm: false } as VariantProbe,
          () => probeController.abort(),
        )
      : ({ hasDrm: false } as VariantProbe);
    const entries: PlaylistEntry[] = parsed.variants.map((variant) => {
      const rendition = parsed.audioRenditions.find(
        (candidate) => candidate.group === variant.audioGroup && candidate.uri !== undefined,
      );
      const audioUri = rendition?.uri ?? false;
      return {
        demuxer: variant.demuxer ?? "mp4",
        quality: {
          ...(variant.resolution ? { size: variant.resolution } : {}),
          ...(variant.bandwidth !== undefined ? { bitrate: variant.bandwidth } : {}),
        },
        av: { video: variant.uri, audio: audioUri },
        ...(rendition?.language ? { audio_language: rendition.language } : {}),
      };
    });
    const subtitles: SubtitleTrack[] = parsed.subtitleRenditions
      .filter((rendition) => rendition.url !== undefined)
      .map((rendition) => ({
        language: rendition.language ?? "und",
        type: "http" as const,
        url: rendition.url as URL,
      }));
    this.engine.attachPlaylist(tabId, item.hash, entries, {
      type: "m3u8_playlist",
      ...(probe.duration !== undefined ? { duration: probe.duration } : {}),
      ...(probe.extension !== undefined ? { extension: probe.extension } : {}),
      has_drm: probe.hasDrm,
      manifestText: text,
      ...(subtitles.length > 0 ? { subtitles } : {}),
    });
  }

  async enrichDash(item: MediaItem, tabId: number): Promise<void> {
    const manifestUrl = item.master_url ?? item.url;
    if (!manifestUrl) return;
    const fetched = await fetchBytes(
      this.fetchImpl,
      manifestUrl.href,
      { headers: headersForPlan(item.sent_headers) },
      { maxBytes: MAX_MANIFEST_BYTES },
    );
    if (fetched.tag === "Err") return;
    const text = new TextDecoder().decode(fetched.value.bytes);
    const parsed = parseMpd(text, manifestUrl);
    if (parsed.tag === "Err") return;
    const mpd = parsed.value;
    const entries: PlaylistEntry[] = [
      ...mpd.video.map((entry) => ({
        demuxer: entry.demuxer,
        quality: {
          ...(entry.height !== undefined || entry.width !== undefined
            ? {
                size: {
                  height: entry.height ?? 0,
                  ...(entry.width !== undefined ? { width: entry.width } : {}),
                },
              }
            : {}),
          ...(entry.bandwidth !== undefined ? { bitrate: entry.bandwidth } : {}),
        },
        index: entry.index,
        ...(entry.audioId !== undefined ? { audio_id: entry.audioId } : {}),
        ...(entry.language !== undefined ? { audio_language: entry.language } : {}),
      })),
      ...mpd.audio.map((entry) => ({
        demuxer: entry.demuxer,
        quality: { ...(entry.bandwidth !== undefined ? { bitrate: entry.bandwidth } : {}) },
        index: entry.index,
        ...(entry.audioId !== undefined ? { audio_id: entry.audioId } : {}),
        ...(entry.language !== undefined ? { audio_language: entry.language } : {}),
      })),
    ];
    this.engine.attachPlaylist(tabId, item.hash, entries, {
      type: "mpd_playlist",
      ...(mpd.duration !== undefined ? { duration: mpd.duration } : {}),
      has_drm: mpd.hasDrm,
      manifestText: text,
      ...(mpd.subtitles.length > 0 ? { subtitles: mpd.subtitles } : {}),
    });
  }

  private async probeHlsMediaQuality(
    segment: { uri: URL; duration?: number } | undefined,
    item: MediaItem,
  ): Promise<{ size?: { width: number; height: number }; bitrate?: number }> {
    if (segment === undefined) return {};
    if (segment.uri.protocol !== "https:" && segment.uri.protocol !== "http:") return {};
    if (!isSafeManifestUrl(segment.uri)) return {};
    const cacheKey = item.master_url?.href ?? item.url?.href;
    const cached = cacheKey !== undefined ? this.hlsQualityCache.get(cacheKey) : undefined;
    if (cached !== undefined) return cached;
    try {
      const fetched = await fetchBytes(
        this.fetchImpl,
        segment.uri.href,
        { headers: headersForPlan(item.sent_headers) },
        { maxBytes: 8 * 1024 * 1024 },
      );
      if (fetched.tag === "Err") return {};
      const dimensions = probeMpegTsVideoSize(fetched.value.bytes);
      if (dimensions === undefined) {
        if (cacheKey !== undefined) this.hlsQualityCache.set(cacheKey, {});
        return {};
      }
      const duration = segment.duration;
      const bitrate =
        duration !== undefined && Number.isFinite(duration) && duration > 0
          ? Math.round((fetched.value.bytes.byteLength * 8) / duration)
          : undefined;
      debugInfo("probed HLS segment quality", dimensions.width, dimensions.height);
      const quality = {
        size: dimensions,
        ...(bitrate !== undefined && bitrate > 0 ? { bitrate } : {}),
      };
      if (cacheKey !== undefined) this.hlsQualityCache.set(cacheKey, quality);
      return quality;
    } catch {
      return {};
    }
  }

  private async fetchVariantProbe(url: URL, sentHeaders: Headers, signal: AbortSignal): Promise<VariantProbe> {
    const fetched = await fetchBytes(
      this.fetchImpl,
      url.href,
      { headers: headersForPlan(sentHeaders) },
      { maxBytes: MAX_PROBE_BYTES, signal },
    );
    if (fetched.tag === "Err") return { hasDrm: false };
    const parsed = parsePlaylist(new TextDecoder().decode(fetched.value.bytes), url);
    if (parsed.kind !== "media") return { hasDrm: false };
    return {
      duration: parsed.duration,
      extension: parsed.segments.some((segment) => segment.map !== undefined) ? "mp4" : "m2ts",
      hasDrm: parsed.hasDrm,
    };
  }
}
