import { handle, json, notFound, parseBody } from "@/lib/http";
import { describeKeyFile, ensureIndexNowKey, getIndexNowKey } from "@/lib/distribution/indexnow";
import { getSiteOrThrow } from "@/lib/services/sites";
import { rotateKeySchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** Key + key-file instructions. `?format=txt` returns the file itself, ready to upload. */
export const GET = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  const site = await getSiteOrThrow(id);
  const key = getIndexNowKey(site);
  if (!key) throw notFound("IndexNow key");
  const file = describeKeyFile(site, key);
  if (new URL(request.url).searchParams.get("format") === "txt") {
    return new Response(file.fileContent, {
      headers: { "content-type": file.contentType, "content-disposition": `attachment; filename="${file.fileName}"` },
    });
  }
  return json(file);
});

/** Generates a key if the site has none (`{ "rotate": true }` replaces an existing one). */
export const POST = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  const { rotate } = await parseBody(request, rotateKeySchema);
  const site = await getSiteOrThrow(id);
  const { key, created } = await ensureIndexNowKey(site, { rotate });
  return json({ created, ...describeKeyFile(site, key) }, created ? 201 : 200);
});
