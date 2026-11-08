import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db";
import { HttpError } from "../http";
import { analyzeAnswer, VISIBILITY_MODELS, type VisibilityModel } from "../visibility-analysis";
import { askSearchProvider, providerConfig, ProviderError } from "../visibility-providers";
import { getSiteOrThrow } from "./sites";

export const visibilityInput = z.object({
  queries: z.array(z.string().trim().min(1).max(500)).min(1).max(10).optional(),
  models: z.array(z.enum(VISIBILITY_MODELS)).min(1).max(4).default([...VISIBILITY_MODELS]),
  refresh: z.boolean().default(false),
}).strict().default({ models: [...VISIBILITY_MODELS], refresh: false });
export const visibilityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export async function suggestQueries(siteId: string) {
  const site = await getSiteOrThrow(siteId);
  const entities = await prisma.graphEntity.findMany({
    where: { siteId, entityType: { in: ["Product", "Category", "Concept", "FAQ", "Brand"] } },
    orderBy: { key: "asc" }, take: 50, select: { name: true, entityType: true },
  });
  const manual = Array.isArray(site.targetKeywords) ? site.targetKeywords.filter((q): q is string => typeof q === "string") : [];
  const generated = entities.map(({ name, entityType }) => {
    if (entityType === "FAQ") return name;
    if (entityType === "Product") return `${name} nereden satın alınır?`;
    if (entityType === "Category") return `En iyi ${name} markaları hangileri?`;
    if (entityType === "Brand") return `${name} alternatifleri nelerdir?`;
    return `${name} için en iyi seçenekler nelerdir?`;
  });
  return [...new Set([...manual, ...generated].map((q) => q.trim()).filter((q) => q.length > 0 && q.length <= 500))].slice(0, 10);
}

export async function listVisibility(siteId: string, options: z.infer<typeof visibilityQuery>) {
  await getSiteOrThrow(siteId);
  const [items, total, queries] = await Promise.all([
    prisma.llmVisibilityRecord.findMany({ where: { siteId }, orderBy: [{ checkedAt: "desc" }, { id: "desc" }], take: options.limit, skip: options.offset }),
    prisma.llmVisibilityRecord.count({ where: { siteId } }),
    suggestQueries(siteId),
  ]);
  return { items, total, queries };
}

// ponytail: one batch per Node process, two requests at a time. Use a shared queue before multi-replica deployment.
let running = false;
const CACHE_MS = 24 * 60 * 60 * 1000;

export async function runVisibility(siteId: string, input: z.infer<typeof visibilityInput>) {
  const site = await getSiteOrThrow(siteId);
  const queries = [...new Set(input.queries ?? await suggestQueries(siteId))];
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
      const cacheKey = createHash("sha256").update(JSON.stringify(["visibility-v1", site.url, site.title, query, model, configured.model])).digest("hex");
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
      const record = await prisma.llmVisibilityRecord.create({ data: {
        siteId, model, query, citationStatus: analysis.citationStatus,
        position: analysis.position, excerpt: analysis.excerpt,
        responseMeta: {
          version: 1, cacheKey, modelId: configured.model,
          isCited: analysis.isCited, isMentioned: analysis.isMentioned,
          citedUrls: analysis.citedUrls, citations: analysis.citations,
          competitorDomains: analysis.competitorDomains,
          positionMethod: "explicit-numbered-label", competitorMethod: "other-source-domains",
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
