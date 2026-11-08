import { handle, text } from "@/lib/http";
import { buildRss, loadRotation } from "@/lib/distribution/syndication";

type Ctx = { params: Promise<{ id: string }> };

/** RSS 2.0 feed of the current rotation. Serve it from the site root as /ai-feed.xml. */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const { catalog, period, items } = await loadRotation(id);
  return text(buildRss(catalog, period, items), "application/rss+xml; charset=utf-8");
});
