import { Prisma } from "@prisma/client";
import { ZodError, type ZodType } from "zod";
import { apiToken, isAuthorized, isSameOrigin, safeEqual } from "./auth";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`);

/** Required even in development for endpoints enabling paid/outbound background work. */
export function requireApiToken(request: Request) {
  const token = process.env.API_TOKEN;
  if (!token) throw new HttpError(503, "Configure API_TOKEN before using scheduled reports");
  if (!safeEqual(request.headers.get("authorization") ?? "", `Bearer ${token}`)) throw new HttpError(401, "Unauthorized");
}

/**
 * Model calls (visibility checks, site assistant). With API_TOKEN: bearer or dashboard session, as everywhere.
 * Without it the server is an open local install: calls billed to an API key are refused, while key-less CLI
 * calls (subscription quota) are allowed, but only from the dashboard itself so another site cannot trigger them.
 */
export async function authorizeModelCalls(request: Request, paid: () => string[], what: string) {
  const token = apiToken();
  if (token) {
    if (!(await isAuthorized(request, token))) throw new HttpError(401, "Unauthorized");
    return;
  }
  const billed = paid();
  if (billed.length) throw new HttpError(503, `Configure API_TOKEN before ${what} with API keys (${billed.join(", ")}); select the CLI transport to run without a token`, { code: "api_token_required" });
  if (!isSameOrigin(request)) throw new HttpError(403, "Without API_TOKEN, CLI model calls are only accepted from the dashboard", { code: "same_origin_required" });
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

/** Parses a JSON body (empty body -> undefined) and validates it. */
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const text = await request.text();
  let body: unknown = undefined;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Request body must be valid JSON");
    }
  }
  return schema.parse(body);
}

export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  return schema.parse(params);
}

/** Wraps a route handler with uniform error -> JSON response mapping. */
export function handle<C>(fn: (request: Request, ctx: C) => Promise<Response>) {
  return async (request: Request, ctx: C): Promise<Response> => {
    try {
      return await fn(request, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message, details: err.details }, err.status);
  }
  if (err instanceof ZodError) {
    return json({ error: "Validation failed", details: err.issues }, 400);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Never echo `err.meta` or log the full error: Prisma messages embed the query arguments (may hold secrets).
    if (err.code === "P2002") return json({ error: "Resource already exists" }, 409);
    if (err.code === "P2025") return json({ error: "Resource not found" }, 404);
    console.error(`Prisma error ${err.code}`);
    return json({ error: "Internal server error" }, 500);
  }
  console.error(err);
  return json({ error: "Internal server error" }, 500);
}

/** Plain-text / XML response (llms.txt, sitemaps, feeds). */
export function text(body: string, contentType: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "cache-control": "public, max-age=300" },
  });
}
