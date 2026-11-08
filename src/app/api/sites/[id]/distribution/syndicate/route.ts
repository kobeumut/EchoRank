import { handle, json, parseBody } from "@/lib/http";
import { loadRotation, publishSyndication } from "@/lib/distribution/syndication";
import { syndicateSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Preview of the current period's rotation. */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const { period, items } = await loadRotation(id);
  return json({ period, items });
});

/** Pushes the current rotation to configured webhooks (once per period unless `force`). */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  const { force } = await parseBody(request, syndicateSchema);
  return json(await publishSyndication(id, { force }));
});
