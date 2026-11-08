import { handle } from "@/lib/http";
import { buildJsonFeed, loadRotation } from "@/lib/distribution/syndication";

type Ctx = { params: Promise<{ id: string }> };

/** JSON Feed 1.1 of the current rotation, schema.org JSON-LD under `_schema_org`. Serve as /ai-feed.json. */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const { catalog, period, items } = await loadRotation(id);
  return new Response(JSON.stringify(buildJsonFeed(catalog, period, items)), {
    headers: { "content-type": "application/feed+json; charset=utf-8", "cache-control": "public, max-age=300" },
  });
});
