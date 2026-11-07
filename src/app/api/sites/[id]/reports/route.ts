import { handle, json, parseQuery } from "@/lib/http";
import { getSiteReport } from "@/lib/services/reports";
import { reportQuerySchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Score summary, history, LLM visibility and action-item metrics: ?days=30 */
export const GET = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  const { days } = parseQuery(request, reportQuerySchema);
  return json(await getSiteReport(id, days));
});
