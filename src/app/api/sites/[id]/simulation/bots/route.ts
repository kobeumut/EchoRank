import { handle, json, parseBody, parseQuery } from "@/lib/http";
import { localeFromRequest } from "@/lib/i18n/request";
import {
  botSimulationInputSchema, botSimulationQuerySchema, listBotSimulations, runBotSimulation,
} from "@/lib/services/bot-simulations";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 120;

/** Latest (or ?runId=) simulation run: per-bot summary + records, filter with ?bot=GPTBot&blocked=true */
export const GET = handle<Ctx>(async (request, { params }) =>
  json(await listBotSimulations((await params).id, parseQuery(request, botSimulationQuerySchema))),
);

/**
 * Live fetch of site URLs as AI crawlers: { "urls"?: [...], "bots"?: ["GPTBot", ...], "includeBaseline"?: true }.
 * Request-level error text stored in the records is written in the request's language.
 */
export const POST = handle<Ctx>(async (request, { params }) =>
  json(await runBotSimulation((await params).id, await parseBody(request, botSimulationInputSchema), localeFromRequest(request)), 201),
);
