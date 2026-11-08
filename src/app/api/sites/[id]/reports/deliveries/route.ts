import { z } from "zod";
import { handle, json, parseQuery } from "@/lib/http";
import { listDeliveries } from "@/lib/reports/dispatch";

type Ctx = { params: Promise<{ id: string }> };
const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

/** Report / alert delivery log (e-mail + webhooks), newest first. */
export const GET = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json({ items: await listDeliveries(id, parseQuery(request, query).limit) });
});
