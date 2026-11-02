import type { DownloadPlan } from "../core/types.js";
import type { HeaderPair } from "../discovery/engine.js";
import { buildDnrRule, sanitizeReplayHeaders } from "../transfer/fetch.js";
import type { NetworkGateway } from "./gateways.js";

const HEADER_REPLAY_TTL_MS = 10 * 60 * 1000;
/** Expired entries are swept at most this often; the entry cap is still enforced on insert. */
const HEADER_REPLAY_PRUNE_INTERVAL_MS = 60_000;
const HEADER_REPLAY_CAP = 300;
const MAX_CAPTURED_URL_LENGTH = 8192;
const MAX_CAPTURED_HEADER_LENGTH = 8192;
const MAX_CAPTURED_HEADERS = 60;
const MAX_ACTIVE_DNR_RULES = 700;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const VOLATILE_QUERY_PARAMS = new Set([
  "range", "rn", "rbuf", "bytestart", "byteend",
  "mx", "mh", "mm", "mn", "ms", "mv", "mvi", "pl", "initcwndbps", "met", "cps", "xpc", "c",
]);

interface CapturedHeaders {
  headers: HeaderPair[];
  at: number;
  scheme: string;
  tabId?: number;
  frameId?: number;
  initiator?: string;
}

/**
 * Normalise a URL for header replay while preserving the media asset identity.
 *
 * This runs for every sniffed request, so it must not rewrite the query unless a volatile
 * parameter is actually present: every `searchParams.delete` re-serialises the URL, and doing
 * that twenty times per request dominated the webRequest handler.
 */
export function normalizeHeaderReplayUrl(
  raw: string | URL,
): { href: string; scheme: string; assetKey?: string } {
  try {
    const url = typeof raw === "string" ? new URL(raw) : raw;
    let volatile = false;
    for (const key of url.searchParams.keys()) {
      if (!VOLATILE_QUERY_PARAMS.has(key)) continue;
      volatile = true;
      break;
    }
    let normalized = url;
    if (volatile) {
      // Work on a copy: rewrite the query without touching a URL the caller may still use.
      normalized = new URL(url.href);
      for (const param of VOLATILE_QUERY_PARAMS) normalized.searchParams.delete(param);
    }
    const id = normalized.searchParams.get("id");
    const itag = normalized.searchParams.get("itag");
    return {
      href: normalized.href,
      scheme: normalized.protocol,
      ...(id && itag ? { assetKey: `${normalized.protocol}//${normalized.host}${normalized.pathname}|${id}|${itag}` } : {}),
    };
  } catch {
    return { href: typeof raw === "string" ? raw : String(raw), scheme: "" };
  }
}

function originOf(raw: string): string | undefined {
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/** Captured request headers and the session rules used to replay them. */
export class HeaderReplay {
  private readonly capturedHeaders = new Map<string, CapturedHeaders>();
  private readonly activeRuleIds = new Set<number>();
  private lastPruneAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly network: NetworkGateway,
    private readonly now: () => number,
  ) {}

  remember(
    rawUrl: string | URL,
    headers: HeaderPair[],
    context: { tabId?: number; frameId?: number; initiator?: string } = {},
  ): void {
    const href = typeof rawUrl === "string" ? rawUrl : rawUrl.href;
    if (href.length > MAX_CAPTURED_URL_LENGTH) return;
    const now = this.now();
    // Expired captures do not need to be swept on every request: the cap bounds memory and a
    // periodic sweep keeps the replay window close to the TTL.
    if (now - this.lastPruneAt >= HEADER_REPLAY_PRUNE_INTERVAL_MS) {
      this.lastPruneAt = now;
      this.prune(now);
    }
    const normalized = normalizeHeaderReplayUrl(rawUrl);
    const safe = headers
      .filter((header) => header.value !== undefined)
      .filter((header) => HEADER_NAME.test(header.name))
      .filter((header) => (header.value as string).length <= MAX_CAPTURED_HEADER_LENGTH)
      .filter((header) => !/[\r\n\0]/.test(header.value as string))
      .slice(0, MAX_CAPTURED_HEADERS);
    if (safe.length === 0) return;
    const entry = {
      headers: safe,
      at: now,
      scheme: normalized.scheme,
      ...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
      ...(context.frameId !== undefined ? { frameId: context.frameId } : {}),
      ...(context.initiator !== undefined ? { initiator: context.initiator } : {}),
    };
    this.capturedHeaders.set(normalized.href, entry);
    if (normalized.assetKey !== undefined) this.capturedHeaders.set(normalized.assetKey, entry);
    // The cap is the hard memory bound, so it is enforced per insert; it rarely fires.
    if (this.capturedHeaders.size > HEADER_REPLAY_CAP) this.prune(now);
  }

  async apply(plan: DownloadPlan, context: { tabId?: number; initiator?: string } = {}): Promise<number[]> {
    // Signed googlevideo URLs authorise themselves. Replaying page context can make them fail.
    if (plan.is_youtube && /(^|\.)googlevideo\.com$/iu.test(plan.url.hostname)) return [];
    const merged = sanitizeReplayHeaders(plan.headers);
    this.prune(this.now());
    const normalized = normalizeHeaderReplayUrl(plan.url.href);
    const candidate =
      this.capturedHeaders.get(normalized.href) ??
      (normalized.assetKey !== undefined ? this.capturedHeaders.get(normalized.assetKey) : undefined);
    const captured =
      candidate !== undefined &&
      candidate.scheme === plan.url.protocol &&
      context.tabId !== undefined &&
      candidate.tabId === context.tabId &&
      (context.initiator === undefined ||
        candidate.initiator === undefined ||
        originOf(candidate.initiator) === context.initiator)
        ? candidate
        : undefined;
    if (captured) {
      const pairs = captured.headers.map((header) => [header.name, header.value ?? ""] as [string, string]);
      for (const [name, value] of sanitizeReplayHeaders(pairs)) merged.set(name, value);
    }
    // Extension-worker requests have no tab id, so browser-wide rules must not replay cookies.
    const hadCookie = merged.has("cookie");
    merged.delete("cookie");
    if (hadCookie) {
      console.info("[media-downloader] skipped Cookie DNR replay (worker requests cannot be tab-scoped)");
    }
    const replayedHeaderCount = [...merged.keys()].length;
    if (replayedHeaderCount === 0) return [];
    if (this.activeRuleIds.size >= MAX_ACTIVE_DNR_RULES) {
      console.warn("[media-downloader] DNR rule budget exhausted; skipping header replay");
      return [];
    }
    const rule = buildDnrRule({
      id: Math.ceil(Math.random() * 1e8),
      exactUrl: `${plan.url.origin}${plan.url.pathname}${plan.url.search}`,
      headers: merged,
    });
    try {
      await this.network.updateSessionRules({ addRules: [rule] });
      this.activeRuleIds.add(rule.id);
      console.info(
        "[media-downloader] replayed",
        replayedHeaderCount,
        "captured headers for",
        plan.url.hostname,
        "[",
        [...merged.keys()].join(","),
        "]",
      );
      return [rule.id];
    } catch (error) {
      console.warn("[media-downloader] header replay failed", error);
      return [];
    }
  }

  async remove(ruleIds: number[]): Promise<void> {
    if (ruleIds.length === 0) return;
    for (const id of ruleIds) this.activeRuleIds.delete(id);
    await this.network.updateSessionRules({ removeRuleIds: ruleIds }).catch(() => undefined);
  }

  async clearStaleRules(): Promise<void> {
    try {
      const rules = await this.network.getSessionRules();
      const ids = rules.map((rule) => rule.id);
      if (ids.length === 0) return;
      await this.network.updateSessionRules({ removeRuleIds: ids });
      console.info("[media-downloader] cleared", ids.length, "stale header rule(s)");
    } catch (error) {
      console.warn("[media-downloader] stale rule cleanup failed", error);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.capturedHeaders) {
      if (now - entry.at > HEADER_REPLAY_TTL_MS) this.capturedHeaders.delete(key);
    }
    while (this.capturedHeaders.size > HEADER_REPLAY_CAP) {
      const oldest = this.capturedHeaders.keys().next();
      if (oldest.done) break;
      this.capturedHeaders.delete(oldest.value);
    }
  }
}
