import { handle, json, parseBody, parseQuery } from "@/lib/http";
import { autoGeoQuerySchema, autoGeoRunSchema, getAutoGeoOverview, runAutoGeo } from "@/lib/services/autogeo-suggestions";

type Ctx = { params: Promise<{ id: string }> };

/**
 * AutoGEO content report: latest audit's per-page metric summary + open AutoGEO action items with diffs, plus the
 * persisted suggestions: ?status=pending,applied&ruleType=stats,quotes&pageUrl=...&minGain=5&sort=gain|recent&limit&offset
 */
export const GET = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json(await getAutoGeoOverview(id, parseQuery(request, autoGeoQuerySchema)));
});

/**
 * Runs AutoGEO suggestion extraction.
 * {}                      — rebuild suggestions from the open AutoGEO action items of the latest audits
 * { "report": { ... } }   — ingest a crawler AutoGEO report (`geo-audit --db-records` payload `autogeo`)
 */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json(await runAutoGeo(id, await parseBody(request, autoGeoRunSchema)));
});
