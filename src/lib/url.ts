import { isPrivateHostname } from "./distribution/net";

/**
 * Normalizes a user-entered site URL to its origin (scheme + host [+ port]).
 * "Example.com/shop?x=1" -> "https://example.com"
 * Throws on invalid / non-http(s) input and on internal hosts (localhost, private IP literals, `.internal` …),
 * because the crawler and the live simulators fetch whatever site URL is stored here (SSRF). Hostnames that
 * only *resolve* to private addresses are re-checked at fetch time. Set ALLOW_PRIVATE_NETWORK_TARGETS=true
 * for local development.
 */
export function normalizeSiteUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("URL is required");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported");
  }
  if (parsed.username || parsed.password) throw new Error("URLs with embedded credentials are not supported");
  const allowPrivate = process.env.ALLOW_PRIVATE_NETWORK_TARGETS === "true";
  if (!allowPrivate && isPrivateHostname(parsed.hostname)) throw new Error("Private and local network addresses are not allowed");
  if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") {
    throw new Error("URL must contain a valid domain");
  }
  return parsed.origin.toLowerCase();
}
