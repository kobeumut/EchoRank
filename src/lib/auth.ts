// API_TOKEN guard shared by the proxy and route handlers.
//
// Machine clients send `Authorization: Bearer <API_TOKEN>`. The dashboard (a browser) cannot hold the
// token in JS safely, so POST /api/auth exchanges it for an httpOnly, SameSite=Strict session cookie:
// `v2.<expiry unix seconds>.<HMAC-SHA-256 signature>`. The signature key is derived from API_TOKEN (and the
// optional SESSION_SECRET), so the token itself never leaves the server, cookies expire server-side, and
// rotating either secret revokes every session. Cookie-authenticated unsafe requests must also be
// same-origin, so a cross-site form/fetch cannot ride the cookie (CSRF).
// Web Crypto only: runs in the proxy and in route handlers alike.

export const SESSION_COOKIE = "aiv_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function apiToken(): string | null {
  const token = process.env.API_TOKEN;
  return token ? token : null;
}

const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

async function sign(token: string, payload: string): Promise<string> {
  // SESSION_SECRET (optional, high entropy) hardens cookies against offline guessing of a weak API_TOKEN.
  const keyMaterial = `${process.env.SESSION_SECRET ?? ""}:${token}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyMaterial), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`aiv-session:v2:${payload}`)));
}

/** A fresh signed session cookie value that expires `SESSION_MAX_AGE` seconds after `now`. */
export async function sessionValue(token: string, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_MAX_AGE;
  return `v2.${expires}.${await sign(token, String(expires))}`;
}

/** Constant-time string comparison (leaks only the longer length, never the position of a mismatch). */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null; // malformed percent-encoding must read as "no session", not crash the proxy
      }
    }
  }
  return null;
}

/** True when the request's Origin (or Referer) matches its own host. */
export function isSameOrigin(request: Request): boolean {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

export async function hasValidSession(request: Request, token: string, now = Date.now()): Promise<boolean> {
  const cookie = readCookie(request, SESSION_COOKIE);
  const match = cookie?.match(/^v2\.(\d{1,12})\.([0-9a-f]{64})$/);
  if (!match) return false;
  const [, expires, signature] = match;
  if (Number(expires) * 1000 <= now) return false;
  return safeEqual(signature, await sign(token, expires));
}

/**
 * Authorizes a request against `token`: a matching bearer header, or a valid session cookie
 * (same-origin required for unsafe methods).
 */
export async function isAuthorized(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get("authorization");
  if (header) return safeEqual(header, `Bearer ${token}`);
  if (!(await hasValidSession(request, token))) return false;
  return SAFE_METHODS.has(request.method.toUpperCase()) || isSameOrigin(request);
}
