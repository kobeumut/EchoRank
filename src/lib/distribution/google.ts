import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Site } from "@prisma/client";
import { getDistributionSettings, getIntegration, INTEGRATION_KEYS } from "./config";
import { OUTBOUND_TIMEOUT_MS, pinnedFetch, readSnippet } from "./net";

// Google has no IndexNow support and retired the anonymous sitemap "ping" endpoint in 2023.
// What remains (and feeds the index Gemini grounds on):
//  - Search Console API sitemaps.submit: tells Google a sitemap changed (site-level).
//  - Indexing API urlNotifications.publish: per-URL, officially only for JobPosting /
//    BroadcastEvent pages, so it is opt-in.
// Both authenticate with a service account (OAuth2 JWT bearer flow, RS256) that must be added
// as an Owner of the Search Console property.

export const GOOGLE_SCOPES = {
  webmasters: "https://www.googleapis.com/auth/webmasters",
  indexing: "https://www.googleapis.com/auth/indexing",
} as const;
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

/**
 * The service-account JSON is user supplied, and its `token_uri` receives a signed JWT. Only Google's own
 * HTTPS token endpoints are honoured; anything else falls back to the default (prevents SSRF / assertion leaks).
 */
export function tokenUriFor(sa: ServiceAccount): string {
  try {
    const url = new URL(sa.token_uri ?? DEFAULT_TOKEN_URI);
    const googleHost = url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com") || url.hostname === "accounts.google.com";
    return url.protocol === "https:" && googleHost && !url.username && !url.password ? url.href : DEFAULT_TOKEN_URI;
  } catch {
    return DEFAULT_TOKEN_URI;
  }
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** Site integration first, then GOOGLE_SERVICE_ACCOUNT_JSON, then GOOGLE_SERVICE_ACCOUNT_FILE. */
export function getServiceAccount(site: Site): ServiceAccount | undefined {
  let raw = getIntegration(site, INTEGRATION_KEYS.googleServiceAccount) ?? process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw && process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    try {
      raw = readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, "utf8");
    } catch {
      return undefined;
    }
  }
  if (!raw) return undefined;
  try {
    const sa = JSON.parse(raw) as Partial<ServiceAccount>;
    return sa.client_email && sa.private_key ? (sa as ServiceAccount) : undefined;
  } catch {
    return undefined;
  }
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** Signed JWT assertion for the OAuth2 jwt-bearer grant. */
export function buildJwtAssertion(sa: ServiceAccount, scope: string, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope, aud: tokenUriFor(sa), iat: now, exp: now + 3600 }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key, "base64url");
  return `${header}.${claims}.${signature}`;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function clearGoogleTokenCache() {
  tokenCache.clear();
}

export async function getAccessToken(sa: ServiceAccount, scope: string): Promise<string> {
  const cacheKey = `${sa.client_email}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  // token_uri comes from a user-supplied service-account file: allow-listed host, validated + DNS-pinned connection
  const res = await pinnedFetch(tokenUriFor(sa), {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: buildJwtAssertion(sa, scope),
    }),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google OAuth token request failed (HTTP ${res.status}): ${await readSnippet(res, 300)}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

export interface GoogleCallResult {
  target: string;
  ok: boolean;
  status: number | null;
  retryable: boolean;
  message: string;
}

const retryableStatus = (status: number) => status === 429 || status >= 500;

/** Re-submits the configured sitemaps to Search Console. */
export async function submitSitemaps(site: Site, sa: ServiceAccount): Promise<GoogleCallResult[]> {
  const { google } = getDistributionSettings(site);
  const property = google.property ?? `${site.url}/`;
  const sitemaps = google.sitemaps?.length ? google.sitemaps : [`${site.url}/sitemap.xml`];
  const token = await getAccessToken(sa, GOOGLE_SCOPES.webmasters);
  const results: GoogleCallResult[] = [];
  for (const feed of sitemaps) {
    const endpoint =
      "https://www.googleapis.com/webmasters/v3/sites/" +
      `${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(feed)}`;
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
      results.push({
        target: feed,
        ok: res.ok,
        status: res.status,
        retryable: retryableStatus(res.status),
        message: res.ok ? "Sitemap submitted" : await readSnippet(res, 300),
      });
    } catch (err) {
      results.push({ target: feed, ok: false, status: null, retryable: true, message: (err as Error).message });
    }
  }
  return results;
}

/** Indexing API publish for one URL. */
export async function publishUrlNotification(
  sa: ServiceAccount,
  url: string,
  type: "URL_UPDATED" | "URL_DELETED",
): Promise<GoogleCallResult> {
  try {
    const token = await getAccessToken(sa, GOOGLE_SCOPES.indexing);
    const res = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url, type }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
    return {
      target: url,
      ok: res.ok,
      status: res.status,
      retryable: retryableStatus(res.status),
      message: res.ok ? "Notification published" : await readSnippet(res, 300),
    };
  } catch (err) {
    return { target: url, ok: false, status: null, retryable: true, message: (err as Error).message };
  }
}
