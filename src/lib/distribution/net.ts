import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { HttpError } from "../http";

export const OUTBOUND_TIMEOUT_MS = 15_000;

const blocked = new BlockList();
// IANA special-purpose ranges that must never be reachable from user-supplied URLs (SSRF).
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96]] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

/** Extracts the embedded IPv4 address of an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:7f00:1`). */
function mappedIPv4(ip: string): string | null {
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) return dotted[1];
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for loopback, private, link-local, CGNAT, documentation, multicast, reserved and unspecified addresses (or non-IPs). */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (!version) return true;
  if (version === 6) {
    const mapped = mappedIPv4(address);
    if (mapped) return isPrivateAddress(mapped);
  }
  return blocked.check(address, version === 6 ? "ipv6" : "ipv4");
}

/** Host names that are internal by convention, whatever DNS says. */
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

/** Synchronous check on a URL hostname: `localhost`, internal-looking suffixes and private IP literals. */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isIP(host) ? isPrivateAddress(host) : false;
}

/**
 * Rejects user-supplied outbound targets (webhooks, key-file checks, crawled sites) that resolve to internal
 * networks. Set ALLOW_PRIVATE_NETWORK_TARGETS=true for local development.
 *
 * Residual risk: the name is resolved here and again by `fetch` (DNS rebinding). Use `publicRequest`
 * (reports/outbound.ts) where the connection must be pinned to the checked address.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, `Only http(s) targets are allowed: ${raw}`);
  }
  if (url.username || url.password) throw new HttpError(400, "URLs with embedded credentials are not allowed");
  if (process.env.ALLOW_PRIVATE_NETWORK_TARGETS === "true") return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHostname(host)) throw new HttpError(400, `Target resolves to a private network: ${url.hostname}`);
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new HttpError(400, `Target resolves to a private network: ${url.hostname}`);
  }
  return url;
}

const MAX_REDIRECTS = 5;

/**
 * `fetch` that follows redirects manually and re-validates every hop with `assertPublicHttpUrl`, so a public
 * URL cannot bounce the request to an internal address. Throws `HttpError` (400) for blocked hops and
 * `Error("Too many redirects")` after 5 hops.
 */
export async function fetchPublic(input: string, init: RequestInit = {}): Promise<Response> {
  let current = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, current).href;
      continue;
    }
    // `Response.url` of a manual fetch is the requested URL; keep it pointing at the final hop.
    return Object.defineProperty(res, "url", { value: current });
  }
  throw new Error("Too many redirects");
}

/** Reads at most `limit` characters of a response body (for logging remote errors). */
export async function readSnippet(res: Response, limit = 500): Promise<string> {
  try {
    return (await res.text()).slice(0, limit);
  } catch {
    return "";
  }
}
