import { z } from "zod";
import { handle, json, parseBody, parseQuery } from "@/lib/http";
import { createSite, listSites } from "@/lib/services/sites";
import { createSiteSchema } from "@/lib/validation";

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = handle(async (request) => json(await listSites(parseQuery(request, listQuery))));

export const POST = handle(async (request) => json(await createSite(await parseBody(request, createSiteSchema)), 201));
