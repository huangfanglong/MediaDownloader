import type { HintVariant, PageMediaHint } from "./media-hint.js";

interface BilibiliDashVideo {
  id?: number;
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  bandwidth?: number;
  mimeType?: string;
  mime_type?: string;
  width?: number;
  height?: number;
}

interface BilibiliDashAudio {
  baseUrl?: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  bandwidth?: number;
  mimeType?: string;
  mime_type?: string;
}

interface BilibiliPlayInfo {
  data?: {
    dash?: {
      video?: BilibiliDashVideo[];
      audio?: BilibiliDashAudio[];
    };
  };
}

function bilibiliHostname(pageUrl: string): boolean {
  try {
    return /(^|\.)bilibili\.com$/iu.test(new URL(pageUrl).hostname);
  } catch {
    return false;
  }
}

function bilibiliMediaUrl(entry: { baseUrl?: string; base_url?: string; backupUrl?: string[]; backup_url?: string[] }): string | undefined {
  const candidates = [entry.baseUrl, entry.base_url, ...(entry.backupUrl ?? []), ...(entry.backup_url ?? [])];
  return candidates.find((value): value is string => typeof value === "string" && /^https?:\/\//iu.test(value));
}

function bilibiliPlayInfo(): BilibiliPlayInfo | undefined {
  const value = (globalThis as { __playinfo__?: unknown }).__playinfo__;
  return value !== null && typeof value === "object" ? (value as BilibiliPlayInfo) : undefined;
}

function bilibiliHintsFromData(data: BilibiliPlayInfo["data"], pageUrl: string, document: Document): PageMediaHint[] {
  if (!bilibiliHostname(pageUrl)) return [];
  const dash = data?.dash;
  if (dash === undefined) return [];
  const audio = [...(dash.audio ?? [])]
    .filter((entry) => bilibiliMediaUrl(entry) !== undefined)
    .sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0];
  const audioUrl = audio === undefined ? undefined : bilibiliMediaUrl(audio);
  const variants: HintVariant[] = [];
  const seen = new Set<string>();
  for (const entry of dash.video ?? []) {
    const url = bilibiliMediaUrl(entry);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    const mime = entry.mimeType ?? entry.mime_type ?? "";
    const demuxer = /webm/iu.test(mime) ? "webm" : "mp4";
    variants.push({
      url,
      ...(entry.width !== undefined && entry.width > 0 ? { width: entry.width } : {}),
      ...(entry.height !== undefined && entry.height > 0 ? { height: entry.height } : {}),
      ...(entry.bandwidth !== undefined && entry.bandwidth > 0 ? { bitrate: entry.bandwidth } : {}),
      demuxer,
      ...(mime.length > 0 ? { mime } : {}),
      ...(audioUrl !== undefined ? { audio_url: audioUrl } : {}),
    });
    if (variants.length >= 32) break;
  }
  if (variants.length === 0) return [];
  variants.sort((left, right) => (right.height ?? 0) - (left.height ?? 0) || (right.bitrate ?? 0) - (left.bitrate ?? 0));
  const bvid = bilibiliVideoId(pageUrl);
  const thumbnail =
    document.querySelector("meta[property='og:image']")?.getAttribute("content") ??
    document.querySelector("meta[name='og:image']")?.getAttribute("content");
  return [
    {
      url: variants[0]?.url ?? "",
      variants,
      kind: "file",
      source: "player-response",
      allow_segment: true,
      focused: true,
      ...(bvid !== undefined ? { identity: `bili:${bvid}` } : {}),
      ...(document.title.length > 0 ? { title: document.title } : {}),
      ...(thumbnail !== null && thumbnail !== undefined && thumbnail.length > 0 ? { thumbnail } : {}),
    },
  ];
}

export function bilibiliDashHints(pageUrl: string, document: Document): PageMediaHint[] {
  return bilibiliHintsFromData(bilibiliPlayInfo()?.data, pageUrl, document);
}

function bilibiliCid(pageUrl: string): number | undefined {
  const scope = globalThis as { __INITIAL_STATE__?: unknown };
  const state = scope.__INITIAL_STATE__;
  if (state === null || typeof state !== "object") return undefined;
  const videoData = (state as { videoData?: { cid?: unknown; pages?: Array<{ cid?: unknown }> } }).videoData;
  const requestedPage = Number.parseInt(new URL(pageUrl).searchParams.get("p") ?? "1", 10);
  const index = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage - 1 : 0;
  const cid = videoData?.pages?.[index]?.cid ?? videoData?.cid ?? videoData?.pages?.[0]?.cid;
  return typeof cid === "number" && cid > 0 ? cid : undefined;
}

const bilibiliHintsCache = new Map<string, { at: number; hints: PageMediaHint[] }>();
const BILIBILI_HINTS_TTL_MS = 60_000;

export async function collectBilibiliApiHints(
  pageUrl: string,
  document: Document,
  fetchImpl: typeof fetch,
): Promise<PageMediaHint[]> {
  if (!bilibiliHostname(pageUrl)) return [];
  const bvid = bilibiliVideoId(pageUrl);
  const cid = bilibiliCid(pageUrl);
  if (bvid === undefined || cid === undefined) return [];
  const cacheKey = `${bvid}:${cid}`;
  const cached = bilibiliHintsCache.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.at < BILIBILI_HINTS_TTL_MS) return cached.hints;
  try {
    const response = await fetchImpl(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=127&fnval=4048&fourk=1`,
      { credentials: "include" },
    );
    if (!response.ok) return [];
    const json = (await response.json()) as { data?: BilibiliPlayInfo["data"] };
    const hints = bilibiliHintsFromData(json.data, pageUrl, document);
    if (bilibiliHintsCache.size >= 50 && !bilibiliHintsCache.has(cacheKey)) {
      const oldest = [...bilibiliHintsCache.entries()].sort((left, right) => left[1].at - right[1].at)[0]?.[0];
      if (oldest !== undefined) bilibiliHintsCache.delete(oldest);
    }
    bilibiliHintsCache.set(cacheKey, { at: Date.now(), hints });
    return hints;
  } catch {
    return [];
  }
}

function bilibiliVideoId(pageUrl: string): string | undefined {
  try {
    const match = /\/video\/(BV[0-9A-Za-z]+)/u.exec(new URL(pageUrl).pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}
