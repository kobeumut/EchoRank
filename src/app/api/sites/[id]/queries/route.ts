import { z } from "zod";
import { handle, json, parseQuery } from "@/lib/http";
import { generateSiteQueries, QUERY_INTENTS, QUERY_LANGUAGES } from "@/lib/services/query-generator";

type Ctx = { params: Promise<{ id: string }> };

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z.string().optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(values)).min(1).max(values.length).optional());

const querySchema = z.object({
  intents: csv(QUERY_INTENTS),
  languages: csv(QUERY_LANGUAGES),
  perIntent: z.coerce.number().int().min(1).max(20).default(5),
  expand: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
});

/**
 * Synthetic multi-intent test prompts with intent / language / target / difficulty / volume labels.
 * ?intents=comparative,reputation&languages=tr&perIntent=5&expand=false
 * No external calls: generation is template-based and deterministic.
 */
export const GET = handle<Ctx>(async (request, { params }) => {
  const { id } = await params;
  const opts = parseQuery(request, querySchema);
  const items = await generateSiteQueries(id, opts);
  const byIntent = Object.fromEntries(QUERY_INTENTS.map((i) => [i, items.filter((q) => q.intent === i).length]));
  return json({ items, total: items.length, byIntent });
});
