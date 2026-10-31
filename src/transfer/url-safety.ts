/**
 * URL trust checks shared by the manifest-enrichment path and the panel.
 *
 * The extension sees URLs supplied by arbitrary page JavaScript (through the page-world hint
 * bridge). Anything fetched automatically without a user gesture must not be able to reach
 * loopback/private/link-local services, and cross-origin manifests should only be fetched when the
 * browser actually observed them in that tab.
 */

/** Parse an IPv6 hostname (without brackets/zone) into 16 bytes. */
function parseIpv6Host(host: string): number[] | undefined {
  const withoutZone = host.split("%")[0] ?? host;
  if (withoutZone.length === 0) return undefined;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part.length === 0) return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(group)) {
        const octets = group.split(".").map((value) => Number.parseInt(value, 10));
        if (octets.some((value) => value > 255)) return undefined;
        groups.push((octets[0] ?? 0) * 256 + (octets[1] ?? 0));
        groups.push((octets[2] ?? 0) * 256 + (octets[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/u.test(group)) return undefined;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const left = parseGroups(halves[0] ?? "");
  const right = parseGroups(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  const total = left.length + right.length;
  if (halves.length === 1 && total !== 8) return undefined;
  if (halves.length === 2 && total > 8) return undefined;
  const words = [...left, ...Array.from({ length: 8 - total }, () => 0), ...right];
  if (words.length !== 8) return undefined;
  return words.flatMap((word) => [Math.floor(word / 256), word % 256]);
}

function isPrivateIpv4Bytes(bytes: readonly number[]): boolean {
  const [a, b] = bytes as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

function isPrivateIpv6Bytes(bytes: readonly number[]): boolean {
  if (bytes.length !== 16) return false;
  const mappedPrefix = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mappedPrefix) return isPrivateIpv4Bytes(bytes.slice(12));
  const compatiblePrefix = bytes.slice(0, 12).every((value) => value === 0);
  if (compatiblePrefix) {
    // ::1/:: unspecified or IPv4-compatible loopback/private forms like ::7f00:1.
    return bytes[15] === 1 || isPrivateIpv4Bytes(bytes.slice(12));
  }
  // NAT64 64:ff9b::/96 embedding a private IPv4 address.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((value) => value === 0)) {
    return isPrivateIpv4Bytes(bytes.slice(12));
  }
  // 6to4 2002::/16 embeds the IPv4 address in bytes 2..5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isPrivateIpv4Bytes(bytes.slice(2, 6));
  if ((bytes[0] ?? 0) === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return true; // fe80::/10
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return true; // fc00::/7
  if ((bytes[0] ?? 0) === 0xff) return true; // multicast
  return false;
}

/** True for literal loopback/private/link-local/unique-local hosts (IPv4, IPv6, common local names). */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.$/u, "");
  if (host.length === 0) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "home.arpa" ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) {
    const octets = host.split(".").map((part) => Number.parseInt(part, 10));
    if (octets.some((part) => part > 255)) return false;
    return isPrivateIpv4Bytes(octets);
  }

  if (host.includes(":")) {
    const bytes = parseIpv6Host(host);
    return bytes === undefined ? false : isPrivateIpv6Bytes(bytes);
  }

  return false;
}

/** Same-origin helper that tolerates undefined inputs. */
export function isSameOrigin(a: URL | undefined, b: URL | undefined): boolean {
  return a !== undefined && b !== undefined && a.origin === b.origin;
}

/** Stable key used to remember URLs the browser actually requested in a tab. */
export function observedRequestKey(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** Whether a manifest URL is safe to fetch at all. */
export function isSafeManifestUrl(url: URL): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && !isPrivateNetworkHost(url.hostname);
}

/**
 * Whether a segment URL resolved from a manifest is safe to fetch.
 *
 * Enforces: http(s) only, no userinfo, and either public network OR same-origin with the manifest
 * (same-origin private network hosts are allowed — the page captured credentials from that origin).
 */
export function isSafeSegmentUrl(segmentUrl: URL, manifestUrl: URL): boolean {
  if (segmentUrl.protocol !== "http:" && segmentUrl.protocol !== "https:") return false;
  if (segmentUrl.username !== "" || segmentUrl.password !== "") return false;
  if (isPrivateNetworkHost(segmentUrl.hostname)) {
    return segmentUrl.origin === manifestUrl.origin;
  }
  return true;
}

/**
 * Auto-enrichment policy: a page-supplied manifest is fetched only when it is safe, and either the
 * browser observed that URL in the same tab or it is same-origin with the page that supplied it.
 */
export function manifestEnrichmentAllowed(
  manifestUrl: URL,
  initiator: URL | undefined,
  observed: boolean,
): boolean {
  if (!isSafeManifestUrl(manifestUrl)) return false;
  return observed || isSameOrigin(manifestUrl, initiator);
}
