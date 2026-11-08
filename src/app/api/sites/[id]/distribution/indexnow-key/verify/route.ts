import { handle, json, notFound } from "@/lib/http";
import { getIndexNowKey, verifyKeyFile } from "@/lib/distribution/indexnow";
import { getSiteOrThrow } from "@/lib/services/sites";

type Ctx = { params: Promise<{ id: string }> };

/** Fetches the published key file from the site and checks its content. */
export const POST = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const site = await getSiteOrThrow(id);
  const key = getIndexNowKey(site);
  if (!key) throw notFound("IndexNow key");
  return json(await verifyKeyFile(site, key));
});
