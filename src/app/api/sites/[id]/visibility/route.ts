import { apiToken, isAuthorized } from "@/lib/auth";
import { handle, HttpError, json, parseBody, parseQuery } from "@/lib/http";
import { localeFromRequest } from "@/lib/i18n/request";
import { listVisibility, runVisibility, visibilityInput, visibilityQuery } from "@/lib/services/visibility";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 450;

export const GET = handle<Ctx>(async (request, { params }) =>
  json(await listVisibility((await params).id, parseQuery(request, visibilityQuery), localeFromRequest(request))),
);

/** Paid external calls require an explicitly configured token (bearer or dashboard session), even in development. */
export const POST = handle<Ctx>(async (request, { params }) => {
  const token = apiToken();
  if (!token) throw new HttpError(503, "Configure API_TOKEN before running paid visibility checks");
  if (!(await isAuthorized(request, token))) throw new HttpError(401, "Unauthorized");
  const input = await parseBody(request, visibilityInput);
  return json(await runVisibility((await params).id, input));
});
