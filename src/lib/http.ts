import { Prisma } from "@prisma/client";
import { ZodError, type ZodType } from "zod";

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
    if (err.code === "P2002") return json({ error: "Resource already exists", details: err.meta }, 409);
    if (err.code === "P2025") return json({ error: "Resource not found" }, 404);
  }
  console.error(err);
  return json({ error: "Internal server error" }, 500);
}
