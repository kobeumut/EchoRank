import { handle, json, parseQuery } from "@/lib/http";
import { anomaliesOf, captureSnapshot, getTrends } from "@/lib/monitoring/trends";
import { trendQuerySchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Score / visibility time series and anomalies: ?days=90&kind=daily|weekly|manual */
export const GET = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json(await getTrends(id, parseQuery(request, trendQuerySchema)));
});

/** Records a manual snapshot now (no external calls) and returns it with detected anomalies. */
export const POST = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const snapshot = await captureSnapshot(id, { kind: "manual" });
  return json({ ...snapshot, anomalies: anomaliesOf(snapshot) }, 201);
});
