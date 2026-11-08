import { NextResponse, type NextRequest } from "next/server";
import { apiToken, hasValidSession, isAuthorized } from "@/lib/auth";

const PUBLIC_API = new Set(["/api/health", "/api/auth"]);

/**
 * Optional guard (enabled when API_TOKEN is set):
 * - /api/*: bearer token or dashboard session cookie. /api/health and /api/auth stay public.
 * - dashboard pages: redirect to /login without a valid session.
 */
export async function proxy(request: NextRequest) {
  const token = apiToken();
  const { pathname, search } = request.nextUrl;
  if (!token || PUBLIC_API.has(pathname) || pathname === "/login") return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    if (await isAuthorized(request, token)) return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (await hasValidSession(request, token)) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/api/:path*", "/((?!_next/|favicon\\.ico|.*\\.(?:svg|png|ico|txt|webmanifest)$).*)"],
};
