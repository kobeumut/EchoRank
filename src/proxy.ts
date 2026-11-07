import { NextResponse, type NextRequest } from "next/server";

/** Optional bearer-token guard for /api/* (enabled when API_TOKEN is set). /api/health stays public. */
export function proxy(request: NextRequest) {
  const token = process.env.API_TOKEN;
  if (!token || request.nextUrl.pathname === "/api/health") return NextResponse.next();
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
