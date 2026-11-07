/**
 * Normalizes a user-entered site URL to its origin (scheme + host [+ port]).
 * "Example.com/shop?x=1" -> "https://example.com"
 * Throws on invalid / non-http(s) input.
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
  if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") {
    throw new Error("URL must contain a valid domain");
  }
  return parsed.origin.toLowerCase();
}
