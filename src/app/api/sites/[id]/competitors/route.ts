import { handle, json, parseQuery } from "@/lib/http";
import { localeFromRequest } from "@/lib/i18n/request";
import { competitorQuerySchema, getCompetitorReport } from "@/lib/services/competitors";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Share of Model vs configured competitors (settings.visibilityAnalysis.competitors), citation gaps and per-model
 * shares: ?days=30&gapLimit=50 ; ?refresh=false returns the stored snapshot without recomputing.
 */
export const GET = handle<Ctx>(async (request, { params }) =>
  json(await getCompetitorReport((await params).id, parseQuery(request, competitorQuerySchema), localeFromRequest(request))),
);
