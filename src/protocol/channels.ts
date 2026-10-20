/**
 * Cross-context channel identifiers and channel naming.
 *
 * Evidence: service worker `bt` enum (analysis/pretty/service__main.js.pretty.js lines
 * 7199-7209) and `injected/*_untrusted.js` (per-URL BroadcastChannel names). Values are a wire
 * contract shared by every context, so they are reproduced exactly.
 */

/** Message envelope channel numbers. Every inter-context message carries one of these. */
export const Channel = {
  FromInjectedToService: 0,
  FromContentToService: 1,
  FromServiceToWorker: 2,
  FromWorkerToService: 3,
  FromUntrustedInjectedToTrusted: 4,
  FromTrustedInjectedToUntrusted: 5,
  FromServiceToContent: 6,
  FromServiceToInjected: 7,
  FromServiceToService: 8,
} as const;

export type ChannelValue = (typeof Channel)[keyof typeof Channel];

/** BroadcastChannel shared by the service worker and the download worker. */
export const WORKER_SERVICE_CHANNEL = "worker_service";

/** Prefix for the per-page channel that joins the isolated and page worlds. */
export const INJECTED_CHANNEL_PREFIX = "injected-";

/**
 * cyrb53, the 53-bit string hash used by the page-world bridge scripts.
 *
 * The shipped scripts derive the per-URL channel name as
 * `injected-${cyrb53(window.location.href)}`. Reproduced so both worlds agree on the channel
 * name and so behaviour/domain/media hashes match the shipped ruleset; numeric parity is
 * asserted in test/protocol.test.ts.
 *
 * IMPORTANT: the artifact uses seed constants `3735928559` (0xDEADBEEF) and `1103547991`
 * (0x41C6CE57), not the published cyrb53 second seed 0x41C64E6D. Verified against the shipped
 * `be()` function and against known-good hashes from the embedded default ruleset
 * (`behaviour_hash_2168192316009402` = BLOCK_MEDIA_DETECTION, `experiment_hash_1986546207779496`
 * = ALLOW_BRAVE_YT_DL, and the detection evidence's `be("hello") = 4625896200565286`).
 */
export const CYRB53_SEED_1 = 0xdeadbeef;
export const CYRB53_SEED_2 = 0x41c6ce57;

export function cyrb53(input: string, seed = 0): number {
  let h1 = CYRB53_SEED_1 ^ seed;
  let h2 = CYRB53_SEED_2 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Channel name joining the isolated-world script and page-world script for one page URL. */
export function injectedHrefChannel(href: string): string {
  return `${INJECTED_CHANNEL_PREFIX}${cyrb53(href)}`;
}
