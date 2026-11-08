import { handle, json, parseBody } from "@/lib/http";
import { syncFromCrawl } from "@/lib/distribution/queue";
import { syncSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Diffs the latest crawl against the queue and enqueues created / updated / deleted URLs. */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  const { mode } = await parseBody(request, syncSchema);
  return json(await syncFromCrawl(id, { mode }));
});
