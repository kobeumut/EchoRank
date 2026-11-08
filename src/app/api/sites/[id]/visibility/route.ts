import { handle, HttpError, json, parseBody, parseQuery } from "@/lib/http";
import { listVisibility, runVisibility, visibilityInput, visibilityQuery } from "@/lib/services/visibility";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 450;

export const GET = handle<Ctx>(async (request, { params }) =>
  json(await listVisibility((await params).id, parseQuery(request, visibilityQuery))),
);

/** Paid external calls require an explicitly configured token, even in development. */
export const POST = handle<Ctx>(async (request, { params }) => {
  const token = process.env.API_TOKEN;
  if (!token) throw new HttpError(503, "Configure API_TOKEN before running paid visibility checks");
  if (request.headers.get("authorization") !== `Bearer ${token}`) throw new HttpError(401, "Unauthorized");
  const input = await parseBody(request, visibilityInput);
  return json(await runVisibility((await params).id, input));
});
