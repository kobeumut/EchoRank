import { handle, text } from "@/lib/http";
import { loadSiteCatalog } from "@/lib/distribution/content";
import { buildAiSitemap } from "@/lib/distribution/sitemap";

type Ctx = { params: Promise<{ id: string }> };

/** Prioritized sitemap of indexable URLs. Serve it from the site root as /sitemap-ai.xml. */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return text(buildAiSitemap(await loadSiteCatalog(id)), "application/xml; charset=utf-8");
});
