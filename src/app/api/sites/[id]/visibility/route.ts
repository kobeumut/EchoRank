import { authorizeModelCalls, handle, json, parseBody, parseQuery } from "@/lib/http";
import { localeFromRequest } from "@/lib/i18n/request";
import { listVisibility, paidModels, runVisibility, visibilityInput, visibilityQuery } from "@/lib/services/visibility";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 450;

export const GET = handle<Ctx>(async (request, { params }) =>
  json(await listVisibility((await params).id, parseQuery(request, visibilityQuery), localeFromRequest(request))),
);

/** Calls billed to an API key require API_TOKEN (bearer or dashboard session), even in development; see authorizeModelCalls. */
export const POST = handle<Ctx>(async (request, { params }) => {
  const input = await parseBody(request, visibilityInput);
  await authorizeModelCalls(request, () => paidModels(input), "running visibility checks");
  return json(await runVisibility((await params).id, input));
});
