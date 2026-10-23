import type { PageMediaHint } from "./media-hint.js";

interface YouTubePlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: {
    hlsManifestUrl?: string;
    formats?: Array<{ url?: string; mimeType?: string; itag?: number }>;
    adaptiveFormats?: Array<{
      url?: string;
      mimeType?: string;
      itag?: number;
      width?: number;
      height?: number;
      bitrate?: number;
      contentLength?: string | number;
    }>;
  };
}

interface YouTubeClient {
  name: string;
  headerName: string;
  clientVersion: string;
  context: Record<string, unknown>;
}

const YOUTUBE_CLIENTS: readonly YouTubeClient[] = [
  {
    name: "VISIONOS",
    headerName: "101",
    clientVersion: "1.02",
    context: {
      clientName: "VISIONOS",
      clientVersion: "1.02",
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      osName: "visionOS",
      osVersion: "26.5.23O471",
    },
  },
  {
    name: "ANDROID_VR",
    headerName: "28",
    clientVersion: "1.62.27",
    context: {
      clientName: "ANDROID_VR",
      clientVersion: "1.62.27",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12",
      androidSdkVersion: 32,
      userAgent: "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en-US; Quest 3 Build/SQ3A.220605.009.A1) gzip",
    },
  },
  {
    name: "IOS",
    headerName: "5",
    clientVersion: "20.10.4",
    context: {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
      userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    },
  },
];

interface YtConfigLike {
  get?: (key: string) => unknown;
  data_?: Record<string, unknown>;
}

export function youtubeHostname(pageUrl: string): boolean {
  try {
    const host = new URL(pageUrl).hostname;
    return /(^|\.)youtube\.com$/iu.test(host) || /(^|\.)youtu\.be$/iu.test(host);
  } catch {
    return false;
  }
}

export function youtubeVideoId(pageUrl: string): string | undefined {
  if (!youtubeHostname(pageUrl)) return undefined;
  try {
    const url = new URL(pageUrl);
    if (/youtu\.be$/iu.test(url.hostname)) return url.pathname.split("/")[1];
    const fromQuery = url.searchParams.get("v");
    if (fromQuery) return fromQuery;
    const shorts = /\/shorts\/([\w-]{6,})/u.exec(url.pathname);
    return shorts?.[1];
  } catch {
    return undefined;
  }
}

function youtubeConfig(): { apiKey?: string; clientVersion?: string; visitorData?: string } {
  const scope = globalThis as unknown as { ytcfg?: YtConfigLike };
  const config = scope.ytcfg;
  const read = (key: string): unknown => {
    try {
      if (typeof config?.get === "function") return config.get(key);
    } catch {
      // Ignore malformed page configuration.
    }
    return config?.data_?.[key];
  };
  const apiKey = read("INNERTUBE_API_KEY");
  const clientVersion = read("INNERTUBE_CLIENT_VERSION");
  const visitorData = read("VISITOR_DATA");
  return {
    ...(typeof apiKey === "string" ? { apiKey } : {}),
    ...(typeof clientVersion === "string" ? { clientVersion } : {}),
    ...(typeof visitorData === "string" ? { visitorData } : {}),
  };
}

const declaredTrackSize = (format: { url?: string }): number => {
  if (format.url === undefined) return 0;
  try {
    const value = new URL(format.url).searchParams.get("clen");
    return value === null ? 0 : Number.parseInt(value, 10) || 0;
  } catch {
    return 0;
  }
};

function formatCounts(json: YouTubePlayerResponse): {
  adaptive: number;
  direct: number;
  ciphered: number;
  progressive: number;
  hls: boolean;
  sabr: boolean;
} {
  const adaptive = json.streamingData?.adaptiveFormats ?? [];
  const direct = adaptive.filter((format) => typeof format.url === "string");
  const ciphered = adaptive.filter((format) => {
    const candidate = format as { signatureCipher?: unknown; cipher?: unknown };
    return typeof candidate.signatureCipher === "string" || typeof candidate.cipher === "string";
  });
  return {
    adaptive: adaptive.length,
    direct: direct.length,
    ciphered: ciphered.length,
    progressive: (json.streamingData?.formats ?? []).length,
    hls: typeof json.streamingData?.hlsManifestUrl === "string",
    sabr: typeof (json.streamingData as { serverAbrStreamingUrl?: string })?.serverAbrStreamingUrl === "string",
  };
}

const MAX_ADAPTIVE_TRACK_BYTES = 512 * 1024 * 1024;

export function hintsFromYouTubePlayerResponse(json: YouTubePlayerResponse): PageMediaHint[] {
  const streaming = json.streamingData;
  const direct = <Format extends { url?: string }>(formats: Format[] | undefined): Format[] =>
    (formats ?? []).filter((format) => typeof format.url === "string" && !format.url.includes("sabr=1"));
  const adaptive = direct(streaming?.adaptiveFormats);
  const bestAudio = (mimePattern: RegExp) =>
    adaptive
      .filter((format) => mimePattern.test(format.mimeType ?? "") && typeof format.url === "string")
      .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0))[0];
  const mp4Audio = bestAudio(/^audio\/mp4/iu);
  const webmAudio = bestAudio(/^audio\/webm/iu);
  const families = [
    { demuxer: "mp4", video: /^video\/mp4/iu, codec: /avc1/iu, audio: mp4Audio },
    { demuxer: "mp4", video: /^video\/mp4/iu, codec: /av01|av1/iu, audio: mp4Audio },
    { demuxer: "mp4", video: /^video\/mp4/iu, codec: /hvc1|hev1|hevc/iu, audio: mp4Audio },
    { demuxer: "webm", video: /^video\/webm/iu, codec: /vp9|vp8/iu, audio: webmAudio },
  ];
  const candidates = families.flatMap((family) =>
    adaptive
      .filter((format) => family.video.test(format.mimeType ?? "") && family.codec.test(format.mimeType ?? ""))
      .filter((format) => {
        const size = declaredTrackSize(format);
        return size === 0 || size <= MAX_ADAPTIVE_TRACK_BYTES;
      })
      .map((format) => ({ format, demuxer: family.demuxer, audio: family.audio })),
  );
  candidates.sort(
    (left, right) =>
      (right.format.height ?? 0) - (left.format.height ?? 0) || (right.format.bitrate ?? 0) - (left.format.bitrate ?? 0),
  );
  const variants = candidates.map((candidate) => {
    const format = candidate.format;
    return {
      url: format.url as string,
      ...(candidate.audio?.url !== undefined ? { audio_url: candidate.audio.url } : {}),
      demuxer: candidate.demuxer,
      ...(format.mimeType !== undefined ? { mime: format.mimeType } : {}),
      ...(format.itag !== undefined ? { itag: format.itag } : {}),
      ...(format.width !== undefined ? { width: format.width } : {}),
      ...(format.height !== undefined ? { height: format.height } : {}),
      ...(format.bitrate !== undefined ? { bitrate: format.bitrate } : {}),
      ...(declaredTrackSize(format) > 0 ? { size: declaredTrackSize(format) } : {}),
    };
  });
  const best = variants[0];
  if (best !== undefined) {
    return [
      {
        url: best.url,
        ...(best.audio_url !== undefined ? { audio_url: best.audio_url } : {}),
        variants,
        kind: "file",
        source: "player-response",
        ...(streaming?.hlsManifestUrl !== undefined ? { hls_url: streaming.hlsManifestUrl } : {}),
      },
    ];
  }
  if (streaming?.hlsManifestUrl !== undefined) {
    return [{ url: streaming.hlsManifestUrl, kind: "hls", source: "player-response" }];
  }
  return [];
}

function pageYouTubePlayerResponses(): YouTubePlayerResponse[] {
  const responses: YouTubePlayerResponse[] = [];
  const push = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const candidate = value as YouTubePlayerResponse;
    if (candidate.streamingData !== undefined || candidate.playabilityStatus !== undefined) responses.push(candidate);
  };
  const scope = globalThis as {
    ytInitialPlayerResponse?: unknown;
    ytplayer?: { config?: { args?: { player_response?: unknown } } };
  };
  push(scope.ytInitialPlayerResponse);
  try {
    const player = document.querySelector("#movie_player") as { getPlayerResponse?: () => unknown } | null;
    push(player?.getPlayerResponse?.());
  } catch {
    // The player API is unavailable on non-watch pages.
  }
  const raw = scope.ytplayer?.config?.args?.player_response;
  if (typeof raw === "string") {
    try {
      push(JSON.parse(raw));
    } catch {
      // Ignore malformed legacy payloads.
    }
  } else {
    push(raw);
  }
  return responses;
}

export async function collectYouTubeInnerTubeHints(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PageMediaHint[]> {
  const videoId = youtubeVideoId(pageUrl);
  if (videoId === undefined) return [];
  const config = youtubeConfig();
  const reasons: string[] = [];
  const pageVersion = config.clientVersion ?? "2.20250701.01.00";
  const clients = [
    ...YOUTUBE_CLIENTS,
    {
      name: "MWEB",
      headerName: "2",
      clientVersion: pageVersion,
      context: { clientName: "MWEB", clientVersion: pageVersion },
    },
    {
      name: "WEB",
      headerName: "1",
      clientVersion: pageVersion,
      context: { clientName: "WEB", clientVersion: pageVersion },
    },
  ];
  for (const client of clients) {
    const context = {
      ...client.context,
      hl: "en",
      gl: "US",
      utcOffsetMinutes: 0,
      ...(config.visitorData ? { visitorData: config.visitorData } : {}),
    };
    const body = {
      context: { client: context },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    };
    try {
      const endpoint = `https://www.youtube.com/youtubei/v1/player?prettyPrint=false${
        config.apiKey ? `&key=${config.apiKey}` : ""
      }`;
      const response = await fetchImpl(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-youtube-client-name": client.headerName,
          "x-youtube-client-version": client.clientVersion,
          ...(config.visitorData ? { "x-goog-visitor-id": config.visitorData } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        console.info("[media-downloader] innertube", client.name, "HTTP", response.status);
        reasons.push(`${client.name}:HTTP ${response.status}`);
        continue;
      }
      const json = (await response.json()) as YouTubePlayerResponse;
      const hints = hintsFromYouTubePlayerResponse(json);
      const status = json.playabilityStatus?.status;
      const reason = json.playabilityStatus?.reason;
      const counts = formatCounts(json);
      console.info(
        "[media-downloader] innertube",
        client.name,
        status ?? "?",
        ...(reason !== undefined ? [`reason=${reason}`] : []),
        "formats",
        counts,
        "hints",
        hints.length,
      );
      if (hints.length > 0) return hints;
      if (status !== undefined && status !== "OK") {
        reasons.push(`${client.name}:${status}${reason !== undefined ? ` (${reason})` : ""}`);
      } else if (status === undefined) {
        reasons.push(`${client.name}:no player response`);
      }
    } catch (error) {
      console.info("[media-downloader] innertube", client.name, "failed", String(error));
      reasons.push(`${client.name}:${String(error)}`);
    }
  }

  for (const response of pageYouTubePlayerResponses()) {
    console.info("[media-downloader] page player response formats", formatCounts(response));
    const hints = hintsFromYouTubePlayerResponse(response);
    if (hints.length > 0) {
      console.info("[media-downloader] youtube formats from the page player response", hints.length);
      return hints;
    }
    const status = response.playabilityStatus?.status;
    const reason = response.playabilityStatus?.reason;
    if (status !== undefined && status !== "OK") {
      console.info("[media-downloader] youtube page player response unavailable", status, reason ?? "");
      reasons.push(`page:${status}${reason !== undefined ? ` (${reason})` : ""}`);
    } else if ((response.streamingData?.formats ?? []).some((format) => typeof format.url === "string")) {
      console.info("[media-downloader] page player response has only progressive WEB formats (known 403); ignoring");
      reasons.push("page:only progressive WEB formats");
    } else if (status === "OK") {
      console.info("[media-downloader] page player response is OK but SABR-only (no direct adaptive URLs); will retry");
      reasons.push("page:SABR-only (will retry)");
    }
  }
  if (reasons.some((reason) => reason.includes("LOGIN_REQUIRED"))) youtubeLastOutcome = "blocked";
  console.info(
    "[media-downloader] YouTube adaptive formats not ready yet:",
    [...new Set(reasons)].join("; ") || "no player response with adaptive formats",
    "- the adapter retries; if this persists, sign in/complete YouTube's check and refresh the tab.",
  );
  return [];
}

let youTubeHintCache: { url: string; at: number; pending?: Promise<PageMediaHint[]>; hints?: PageMediaHint[] } | undefined;
const YOUTUBE_HINT_TTL_MS = 60_000;
const YOUTUBE_EMPTY_HINT_TTL_MS = 5_000;
const YOUTUBE_BLOCKED_HINT_TTL_MS = 60_000;
let youtubeLastOutcome: "empty" | "blocked" = "empty";

export async function cachedYouTubeHints(pageUrl: string, fetchImpl: typeof fetch): Promise<PageMediaHint[]> {
  const now = Date.now();
  const emptyTtl = youtubeLastOutcome === "blocked" ? YOUTUBE_BLOCKED_HINT_TTL_MS : YOUTUBE_EMPTY_HINT_TTL_MS;
  const ttl = youTubeHintCache?.hints !== undefined && youTubeHintCache.hints.length === 0 ? emptyTtl : YOUTUBE_HINT_TTL_MS;
  if (youTubeHintCache && youTubeHintCache.url === pageUrl && now - youTubeHintCache.at < ttl) {
    return youTubeHintCache.hints ?? (youTubeHintCache.pending ? await youTubeHintCache.pending : []);
  }
  youtubeLastOutcome = "empty";
  const pending = collectYouTubeInnerTubeHints(pageUrl, fetchImpl).catch(() => [] as PageMediaHint[]);
  youTubeHintCache = { url: pageUrl, at: now, pending };
  const hints = await pending;
  youTubeHintCache = { url: pageUrl, at: now, hints };
  return hints;
}
