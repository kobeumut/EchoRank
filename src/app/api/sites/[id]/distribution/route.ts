import { handle, json, parseBody } from "@/lib/http";
import { distributionPatchSchema, updateDistributionSettings } from "@/lib/distribution/config";
import { getDistributionOverview } from "@/lib/distribution";
import { getSiteOrThrow } from "@/lib/services/sites";

type Ctx = { params: Promise<{ id: string }> };

/** Distribution settings, channel readiness, queue counters and recent submissions. */
export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return json(await getDistributionOverview(id));
});

/** Partial settings update; nested objects (channels, indexnow, google, llms, syndication) are merged. */
export const PATCH = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  const patch = await parseBody(request, distributionPatchSchema);
  const site = await getSiteOrThrow(id);
  return json({ settings: await updateDistributionSettings(site, patch) });
});
