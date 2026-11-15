// API_TOKEN guard shared by the proxy and route handlers.
//
// Machine clients send `Authorization: Bearer <API_TOKEN>`. The dashboard (a browser) cannot hold the
// token in JS safely, so POST /api/auth exchanges it for an httpOnly, SameSite=Strict session cookie
// holding a SHA-256 digest of the token (never the token itself). Cookie-authenticated unsafe requests
// must also be same-origin, so a cross-site form/fetch cannot ride the cookie (CSRF).
// Web Crypto only: runs in the proxy and in route handlers alike.

export const SESSION_COOKIE = "aiv_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function apiToken(): string | null {
  const token = process.env.API_TOKEN;
  return token ? token : null;
}

/** Hex SHA-256 of `aiv-session:v1:<token>` — the session cookie value. */
export async function sessionValue(token: string): Promise<string> {
  const data = new TextEncoder().encode(`aiv-session:v1:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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

export async function hasValidSession(request: Request, token: string): Promise<boolean> {
  const cookie = readCookie(request, SESSION_COOKIE);
  return !!cookie && safeEqual(cookie, await sessionValue(token));
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
