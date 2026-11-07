import { handle, json, parseQuery } from "@/lib/http";
import { getSiteGraph } from "@/lib/services/graph";
import { graphQuerySchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Knowledge graph: ?types=Product,Category&limit=500 */
export const GET = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json(await getSiteGraph(id, parseQuery(request, graphQuerySchema)));
});
