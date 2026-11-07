import { handle, json, parseBody } from "@/lib/http";
import { deleteSite, getSiteOrThrow, serializeSite, updateSite } from "@/lib/services/sites";
import { updateSiteSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  return json(serializeSite(await getSiteOrThrow(id)));
});

export const PATCH = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return json(await updateSite(id, await parseBody(request, updateSiteSchema)));
});

export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  await deleteSite(id);
  return new Response(null, { status: 204 });
});
