import { handle, json, parseBody } from "@/lib/http";
import { dispatchSite } from "@/lib/distribution/queue";
import { dispatchSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Sends due queue rows now (IndexNow, Google Indexing API, Search Console sitemaps). */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json(await dispatchSite(id, await parseBody(request, dispatchSchema)));
});
