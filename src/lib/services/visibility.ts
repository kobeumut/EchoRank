import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db";
import { HttpError } from "../http";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { analyzeAnswer, analyzeBrandSentiment, auditBrandClaims, visibilityAnalysisSettings, VISIBILITY_MODELS, type VisibilityModel } from "../visibility-analysis";
import { askSearchProvider, providerConfig, ProviderError } from "../visibility-providers";
import { getSiteOrThrow } from "./sites";
import { getSomAnalysis } from "./som-analysis";
import { classifyIntent, generateSiteQueries, QUERY_INTENTS, QUERY_LANGUAGES, type GeneratedQuery, type QueryIntent, type QueryLanguage } from "./query-generator";

export const visibilityInput = z.object({
  queries: z.array(z.string().trim().min(1).max(500)).min(1).max(10).optional(),
  /** Only used when `queries` is omitted: restricts the auto-generated prompts. */
  intents: z.array(z.enum(QUERY_INTENTS)).min(1).max(4).optional(),
  languages: z.array(z.enum(QUERY_LANGUAGES)).min(1).max(2).optional(),
  models: z.array(z.enum(VISIBILITY_MODELS)).min(1).max(4).default([...VISIBILITY_MODELS]),
  refresh: z.boolean().default(false),
}).strict().default({ models: [...VISIBILITY_MODELS], refresh: false });
export const visibilityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const MAX_AUTO_QUERIES = 10;

/**
 * Multi-intent synthetic prompts for a site (see query-generator.ts): manual keywords first, then a
 * round-robin over intent × language so the first ten already cover every intent.
 */
export async function suggestQueryDetails(siteId: string, opts: { intents?: QueryIntent[]; languages?: QueryLanguage[]; limit?: number } = {}) {
  const limit = opts.limit ?? MAX_AUTO_QUERIES;
  const generated = await generateSiteQueries(siteId, { intents: opts.intents, languages: opts.languages, perIntent: 5 });
  const seen = new Set<string>();
  return generated.filter((g) => g.text.length <= 500 && !seen.has(g.text) && seen.add(g.text)).slice(0, limit);
}

export async function suggestQueries(siteId: string) {
  return (await suggestQueryDetails(siteId)).map((g) => g.text);
}

export async function listVisibility(siteId: string, options: z.infer<typeof visibilityQuery>, locale: Locale = DEFAULT_LOCALE) {
  await getSiteOrThrow(siteId);
  const [items, total, queries, analysis] = await Promise.all([
    prisma.llmVisibilityRecord.findMany({ where: { siteId }, orderBy: [{ checkedAt: "desc" }, { id: "desc" }], take: options.limit, skip: options.offset }),
    prisma.llmVisibilityRecord.count({ where: { siteId } }),
    suggestQueryDetails(siteId, { limit: 40 }),
    getSomAnalysis(siteId, options.days, locale),
  ]);
  return { items, total, queries: queries.slice(0, MAX_AUTO_QUERIES).map((g) => g.text), querySuggestions: queries, analysis };
}

// ponytail: one batch per Node process, two requests at a time. Use a shared queue before multi-replica deployment.
let running = false;
const CACHE_MS = 24 * 60 * 60 * 1000;

export async function runVisibility(siteId: string, input: z.infer<typeof visibilityInput>) {
  const site = await getSiteOrThrow(siteId);
  const generated: GeneratedQuery[] = input.queries ? [] : await suggestQueryDetails(siteId, { intents: input.intents, languages: input.languages });
  const labels = new Map(generated.map((g) => [g.text, g]));
  // Without keywords or crawled entities only self-branded prompts remain; they would always mention the
  // site and inflate citation rates, so an auto run still needs real input (paid calls stay deliberate).
  const grounded = generated.some((g) => g.source === "manual" || g.targets.some((t) => t.kind !== "site" && t.kind !== "competitor"));
  const queries = [...new Set(input.queries ?? (grounded ? generated.map((g) => g.text) : []))];
  if (!queries.length) throw new HttpError(400, "Provide queries, targetKeywords, or crawl products/categories first");
  if (running) throw new HttpError(409, "A visibility batch is already running; retry after it completes");
  running = true;
  try {
    const tasks = queries.flatMap((query) => [...new Set(input.models)].map((model) => ({ query, model })));
    const items: Awaited<ReturnType<typeof check>>[] = [];
    async function check({ query, model }: { query: string; model: VisibilityModel }) {
      let configured: ReturnType<typeof providerConfig>;
      try { configured = providerConfig(model); }
      catch { return { query, model, error: "not_configured" as const }; }
      const cacheKey = createHash("sha256").update(JSON.stringify(["visibility-v2", site.settings, site.url, site.title, query, model, configured.model])).digest("hex");
      if (!input.refresh) {
        const cached = await prisma.llmVisibilityRecord.findFirst({
          where: { siteId, query, model, checkedAt: { gte: new Date(Date.now() - CACHE_MS) } },
          orderBy: { checkedAt: "desc" },
        });
        const meta = cached?.responseMeta;
        if (cached && meta && typeof meta === "object" && !Array.isArray(meta) && meta.cacheKey === cacheKey) {
          return { query, model, cached: true, record: cached };
        }
      }
      let answer;
      try { answer = await askSearchProvider(model, query); }
      catch (error) {
        return { query, model, error: error instanceof ProviderError ? error.code : "provider_error" };
      }
      const analysis = analyzeAnswer(answer, site);
      const settings = site.settings && typeof site.settings === "object" && !Array.isArray(site.settings) ? site.settings.visibilityAnalysis : undefined;
      const parsed = visibilityAnalysisSettings.safeParse(settings ?? {});
      const config = parsed.success ? parsed.data : visibilityAnalysisSettings.parse({});
      const record = await prisma.llmVisibilityRecord.create({ data: {
        siteId, model, query, citationStatus: analysis.citationStatus,
        position: analysis.position, excerpt: analysis.excerpt,
        responseMeta: {
          version: 2, cacheKey, modelId: configured.model,
          answerText: answer.text.slice(0, 16_000), answerTruncated: answer.text.length > 16_000,
          sentiment: analyzeBrandSentiment(answer.text, site, config.competitors.map((c) => c.title)),
          hallucinations: auditBrandClaims(answer.text, config.facts, new Date(), config.competitors.map((c) => c.title)),
          isCited: analysis.isCited, isMentioned: analysis.isMentioned,
          citedUrls: analysis.citedUrls, citations: analysis.citations,
          competitorDomains: analysis.competitorDomains,
          positionMethod: "explicit-numbered-label", competitorMethod: "other-source-domains",
          queryIntent: labels.get(query)?.intent ?? classifyIntent(query),
          ...(labels.has(query) ? { queryLanguage: labels.get(query)!.language, queryBranded: labels.get(query)!.branded, querySource: labels.get(query)!.source } : {}),
        },
      } });
      return { query, model, cached: false, record };
    }
    for (let i = 0; i < tasks.length; i += 2) {
      // Settle both workers even on a DB error: no run-owned work survives the request.
      const results = await Promise.allSettled(tasks.slice(i, i + 2).map(check));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        items.push(result.value);
      }
    }
    const successful = items.filter((i) => i.record);
    const cited = successful.filter((i) => i.record?.citationStatus === "cited").length;
    return {
      items, attempted: tasks.length, successful: successful.length, failed: tasks.length - successful.length,
      citationRate: successful.length ? Math.round(cited / successful.length * 100) : null,
      perModel: Object.fromEntries([...new Set(input.models)].map((model) => {
        const checks = successful.filter((i) => i.model === model);
        return [model, { successful: checks.length, citationRate: checks.length ? Math.round(checks.filter((i) => i.record?.citationStatus === "cited").length / checks.length * 100) : null }];
      })),
    };
  } finally { running = false; }
}
