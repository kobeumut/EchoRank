import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";
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

export function privateTargetsAllowed(): boolean {
  return process.env.ALLOW_PRIVATE_NETWORK_TARGETS === "true";
}

const privateTarget = (hostname: string) => new HttpError(400, `Target resolves to a private network: ${hostname}`);

/** URL syntax / scheme / credential checks plus the DNS-free host checks (names like `localhost`, IP literals). */
function checkHttpUrl(raw: string): URL {
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
  if (!privateTargetsAllowed() && isPrivateHostname(url.hostname)) throw privateTarget(url.hostname);
  return url;
}

/** Resolves a host name and fails (HttpError 400) unless every address it resolves to is public. */
export async function resolvePublicAddresses(hostname: string, isBlocked = isPrivateAddress): Promise<LookupAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHostname(host) && isBlocked === isPrivateAddress) throw privateTarget(hostname);
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isBlocked(a.address))) throw privateTarget(hostname);
  return addresses;
}

/**
 * Rejects user-supplied outbound targets (webhooks, key-file checks, crawled sites) that resolve to internal
 * networks. Set ALLOW_PRIVATE_NETWORK_TARGETS=true for local development.
 *
 * This is a pre-check (early, readable errors). To actually send a request use `pinnedFetch` / `fetchPublic`,
 * which validate the addresses at connect time and dial exactly the address that was checked.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const url = checkHttpUrl(raw);
  if (!privateTargetsAllowed()) await resolvePublicAddresses(url.hostname);
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * `net.connect` / `tls.connect` lookup hook: resolves the name once, refuses the connection unless every address
 * is public, and hands the socket exactly those checked addresses. Because the check and the connection share one
 * resolution, a DNS-rebinding answer cannot slip in between them. The original host name is kept for the `Host`
 * header and TLS SNI / certificate verification.
 */
export function createGuardedLookup(isBlocked: (address: string) => boolean = isPrivateAddress) {
  return (hostname: string, options: { all?: boolean; family?: number | string }, callback: LookupCallback): void => {
    resolveAndPick(hostname, options, callback, isBlocked);
  };
}

export const guardedLookup = createGuardedLookup();

function resolveAndPick(
  hostname: string,
  options: { all?: boolean; family?: number | string },
  callback: LookupCallback,
  isBlocked: (address: string) => boolean,
): void {
  resolvePublicAddresses(hostname, isBlocked).then((addresses) => {
    const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : Number(options.family) || 0;
    const usable = family ? addresses.filter((a) => a.family === family) : addresses;
    if (!usable.length) {
      callback(Object.assign(new Error(`No IPv${family} address for ${hostname}`), { code: "ENOTFOUND" }), []);
    } else if (options.all) {
      callback(null, usable);
    } else {
      callback(null, usable[0].address, usable[0].family);
    }
  }, (err: NodeJS.ErrnoException) => callback(err, []));
}

let guardedAgent: Agent | undefined;

/** Undici dispatcher whose connections go through `guardedLookup`; undefined when private targets are allowed. */
export function publicDispatcher(): Dispatcher | undefined {
  if (privateTargetsAllowed()) return undefined;
  return (guardedAgent ??= new Agent({ connect: { lookup: guardedLookup as never } }));
}

/**
 * One `fetch` to a user-supplied URL, pinned to validated addresses (see `guardedLookup`). Redirects are not
 * re-validated here: pass `redirect: "manual"` or `"error"`, or use `fetchPublic` to follow them safely.
 * Blocked targets reject with `HttpError` (400).
 */
export async function pinnedFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  checkHttpUrl(raw);
  if (init.redirect === undefined || init.redirect === "follow") init = { ...init, redirect: "manual" };
  const dispatcher = publicDispatcher();
  try {
    return await fetch(raw, dispatcher ? ({ ...init, dispatcher } as RequestInit) : init);
  } catch (err) {
    // undici reports connect failures as `TypeError: fetch failed` with the lookup error as the cause
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof HttpError) throw cause;
    throw err;
  }
}

const MAX_REDIRECTS = 5;

/**
 * `fetch` that follows redirects manually and sends every hop through `pinnedFetch`, so a public URL cannot
 * bounce the request (or rebind its DNS name) to an internal address. Throws `HttpError` (400) for blocked hops
 * and `Error("Too many redirects")` after 5 hops.
 */
export async function fetchPublic(input: string, init: RequestInit = {}): Promise<Response> {
  let current = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await pinnedFetch(current, { ...init, redirect: "manual" });
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
