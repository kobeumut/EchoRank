import { handle, json, parseBody, parseQuery } from "@/lib/http";
import { enqueueUrls, listQueue } from "@/lib/distribution/queue";
import { enqueueUrlsSchema, queueQuerySchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Queue rows: ?status=pending&channel=indexnow&limit=100 */
export const GET = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json({ items: await listQueue(id, parseQuery(request, queueQuerySchema)) });
});

/** Explicit change notification, e.g. from a CMS "product saved" hook. 202: sent on next dispatch. */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json(await enqueueUrls(id, await parseBody(request, enqueueUrlsSchema)), 202);
});
