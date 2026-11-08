import { handle, text } from "@/lib/http";
import { loadSiteCatalog } from "@/lib/distribution/content";
import { buildLlmsFullTxt } from "@/lib/distribution/llms";

type Ctx = { params: Promise<{ id: string }> };

/** llms-full.txt: the llms.txt structure with content inlined. Serve it from the site root as /llms-full.txt. */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return text(buildLlmsFullTxt(await loadSiteCatalog(id)), "text/markdown; charset=utf-8");
});
