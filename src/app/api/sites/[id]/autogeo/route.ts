import { handle, json } from "@/lib/http";
import { getSiteAutoGeo } from "@/lib/services/autogeo";

type Ctx = { params: Promise<{ id: string }> };

/** AutoGEO content report: latest audit's per-page metric summary + open AutoGEO action items with diffs. */
export const GET = handle<Ctx>(async (_request, { params }) => {
  const { id } = await params;
  return json(await getSiteAutoGeo(id));
});
