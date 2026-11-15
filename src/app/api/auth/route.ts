import { z } from "zod";
import { apiToken, hasValidSession, isSameOrigin, safeEqual, SESSION_COOKIE, SESSION_MAX_AGE, sessionValue } from "@/lib/auth";
import { handle, HttpError, json, parseBody } from "@/lib/http";
import { clientKey, globalLoginLimiter, loginLimiter } from "@/lib/rate-limit";

const loginSchema = z.object({ token: z.string().min(1).max(1_000) });

function cookie(value: string, maxAge: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/** Dashboard session state: whether a token is required and whether this browser has a session. */
export const GET = handle(async (request) => {
  const token = apiToken();
  return json({ required: !!token, authenticated: token ? await hasValidSession(request, token) : true });
});

/** Exchanges API_TOKEN for an httpOnly session cookie. */
export const POST = handle(async (request) => {
  const token = apiToken();
  if (!token) return json({ required: false, authenticated: true });
  if (!isSameOrigin(request)) throw new HttpError(403, "Cross-origin login is not allowed");
  const client = clientKey(request);
  const wait = Math.max(loginLimiter.retryAfter(client), globalLoginLimiter.retryAfter("*"));
  if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
  const body = await parseBody(request, loginSchema);
  if (!safeEqual(body.token, token)) {
    loginLimiter.fail(client);
    globalLoginLimiter.fail("*");
    throw new HttpError(401, "Invalid token");
  }
  loginLimiter.reset(client);
  const res = json({ required: true, authenticated: true });
  res.headers.append("set-cookie", cookie(await sessionValue(token), SESSION_MAX_AGE));
  return res;
});

/** Logs out (clears the session cookie). */
export const DELETE = handle(async () => {
  const res = new Response(null, { status: 204 });
  res.headers.append("set-cookie", cookie("", 0));
  return res;
});
