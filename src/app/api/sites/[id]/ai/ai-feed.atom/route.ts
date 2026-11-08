import { handle, text } from "@/lib/http";
import { buildAtom, loadRotation } from "@/lib/distribution/syndication";

type Ctx = { params: Promise<{ id: string }> };

/** Atom feed of the current rotation. Serve it from the site root as /ai-feed.atom. */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const { catalog, period, items } = await loadRotation(id);
  return text(buildAtom(catalog, period, items), "application/atom+xml; charset=utf-8");
});
