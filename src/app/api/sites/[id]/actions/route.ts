import { handle, json, parseQuery } from "@/lib/http";
import { actionListQuerySchema, listActionItems } from "@/lib/services/audit-results";

type Ctx = { params: Promise<{ id: string }> };

/** Prioritized action cards. ?status=open,in_progress (default) &category=schema &impact=high &limit=100 */
export const GET = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json({ items: await listActionItems(id, parseQuery(request, actionListQuerySchema)) });
});
