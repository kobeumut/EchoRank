import { handle, json, parseBody, parseQuery } from "@/lib/http";
import {
  entityEnrichmentQuerySchema, entityReconcileBodySchema, listEnrichments, reconcileEntity,
} from "@/lib/services/entity-enrichment";

type Ctx = { params: Promise<{ id: string }> };
export const maxDuration = 60;

/** Wikidata enrichments + verified sameAs list: ?status=matched,review&type=Organization&verified=true&minConfidence=0.8 */
export const GET = handle<Ctx>(async (request, { params }) =>
  json(await listEnrichments((await params).id, parseQuery(request, entityEnrichmentQuerySchema))),
);

/**
 * { "action": "sync" } (default)                              — rebuild enrichments from the knowledge graph
 * { "action": "verify", "entityId": "...", "qid": "Q42" }     — pin a match
 * { "action": "reject", "entityId": "..." }                   — drop the match
 * { "action": "requery", "entityId": "...", "query"?, "lang"? } — search Wikidata again
 */
export const POST = handle<Ctx>(async (request, { params }) =>
  json(await reconcileEntity((await params).id, await parseBody(request, entityReconcileBodySchema))),
);
