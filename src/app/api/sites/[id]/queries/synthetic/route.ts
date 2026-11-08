import { handle, json, parseBody, parseQuery } from "@/lib/http";
import {
  createSyntheticQueries, listSyntheticQueries, syntheticQueryInputSchema, syntheticQueryListSchema,
} from "@/lib/services/synthetic-queries";

type Ctx = { params: Promise<{ id: string }> };

/** Stored test prompts: ?intent=comparative,reputation&language=tr&status=active&source=template */
export const GET = handle<Ctx>(async (request, { params }) =>
  json(await listSyntheticQueries((await params).id, parseQuery(request, syntheticQueryListSchema))),
);

/**
 * { "mode": "generate", "languages"?, "intents"?, "maxPerIntent"?, "save"? } (default) — template expansion over the graph
 * { "mode": "manual", "queries": [{ "query", "intent", "language" }] }             — store hand-written prompts
 * { "mode": "archive", "ids": [...] }                                              — retire prompts
 */
export const POST = handle<Ctx>(async (request, { params }) =>
  json(await createSyntheticQueries((await params).id, await parseBody(request, syntheticQueryInputSchema))),
);
