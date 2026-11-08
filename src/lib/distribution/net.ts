import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "../http";

export const OUTBOUND_TIMEOUT_MS = 15_000;

/** True for loopback, private, link-local, CGNAT, unique-local and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (v === 6) {
    const ip = address.toLowerCase();
    if (ip === "::" || ip === "::1") return true;
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  }
  return false;
}

/**
 * Rejects user-supplied outbound targets (webhooks, key-file checks) that resolve to internal
 * networks. Set ALLOW_PRIVATE_NETWORK_TARGETS=true for local development.
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
  if (process.env.ALLOW_PRIVATE_NETWORK_TARGETS === "true") return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new HttpError(400, `Target resolves to a private network: ${url.hostname}`);
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) {
    throw new HttpError(400, `Target resolves to a private network: ${url.hostname}`);
  }
  return url;
}

/** Reads at most `limit` characters of a response body (for logging remote errors). */
export async function readSnippet(res: Response, limit = 500): Promise<string> {
  try {
    return (await res.text()).slice(0, limit);
  } catch {
    return "";
  }
}
