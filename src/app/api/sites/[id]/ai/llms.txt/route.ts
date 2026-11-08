import { handle, text } from "@/lib/http";
import { loadSiteCatalog } from "@/lib/distribution/content";
import { buildLlmsTxt } from "@/lib/distribution/llms";

type Ctx = { params: Promise<{ id: string }> };

/** llms.txt index (https://llmstxt.org). Serve it from the site root as /llms.txt. */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return text(buildLlmsTxt(await loadSiteCatalog(id)), "text/markdown; charset=utf-8");
});
