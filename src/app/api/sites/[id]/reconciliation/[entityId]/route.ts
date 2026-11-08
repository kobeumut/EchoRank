import { handle, json, parseBody } from "@/lib/http";
import { applyReconciliationAction, reconciliationActionSchema } from "@/lib/services/wikidata";

type Ctx = { params: Promise<{ id: string; entityId: string }> };
export const maxDuration = 60;

/**
 * { "action": "verify", "qid": "Q42" } — pin a match (confidence 1, kept across re-crawls)
 * { "action": "reject" }               — drop the match / suggestion; that QID is never auto-matched again
 * { "action": "requery", "query"?: "...", "lang"?: "tr" } — search Wikidata again and re-score
 */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id, entityId } = await params;
  return json(await applyReconciliationAction(id, entityId, await parseBody(request, reconciliationActionSchema)));
});
