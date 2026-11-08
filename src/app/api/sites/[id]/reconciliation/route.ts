import { handle, json, parseQuery } from "@/lib/http";
import { listReconciliations, reconciliationQuerySchema } from "@/lib/services/wikidata";

type Ctx = { params: Promise<{ id: string }> };

/** Wikidata match review queue: ?status=review,unmatched&type=Person&limit=100&offset=0 */
export const GET = handle<Ctx>(async (request, { params }) =>
  json(await listReconciliations((await params).id, parseQuery(request, reconciliationQuerySchema))),
);
