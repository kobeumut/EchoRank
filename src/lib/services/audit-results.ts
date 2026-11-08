// Ingestion of scoring-engine output (services/crawler `geo-audit`) into GeoAudit / ActionItem,
// plus the crawl + knowledge-graph rows produced by the same run.
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import {
  ACTION_CATEGORIES,
  ACTION_EFFORTS,
  ACTION_IMPACTS,
  ACTION_STATUSES,
  CRAWL_STATUSES,
} from "../constants";
import { HttpError, notFound } from "../http";

const score = z.number().int().min(0).max(100);
const json = z.record(z.string(), z.unknown());

export const auditActionItemSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).nullish(),
  category: z.enum(ACTION_CATEGORIES),
  impact: z.enum(ACTION_IMPACTS),
  effort: z.enum(ACTION_EFFORTS).nullish(),
  ruleId: z.string().max(100).nullish(),
  priority: z.number().finite().nullish(),
  targetUrl: z.string().max(2000).nullish(),
  details: json.nullish(),
});

export const auditResultSchema = z.object({
  audit: z.object({
    status: z.literal("completed").default("completed"),
    geoScore: score,
    seoScore: score,
    eeatScore: score,
    metrics: json,
    summary: z.string().max(5000).nullish(),
  }),
  actionItems: z.array(auditActionItemSchema).max(500).default([]),
  /** Optional crawl/graph rows from the same run (geo-audit --crawl-records). */
  crawl: z
    .object({
      crawlSession: z
        .object({
          status: z.enum(CRAWL_STATUSES),
          pagesCrawled: z.number().int().min(0),
          pagesFailed: z.number().int().min(0),
          startedAt: z.string().nullish(),
          finishedAt: z.string().nullish(),
        })
        .partial()
        .optional(),
      crawledPages: z
        .array(
          z.object({
            url: z.string().min(1).max(2000),
            statusCode: z.number().int().nullish(),
            pageType: z.string().max(50).nullish(),
            title: z.string().nullish(),
            metaDescription: z.string().nullish(),
            canonical: z.string().nullish(),
            h1: z.string().nullish(),
            wordCount: z.number().int().min(0).default(0),
            depth: z.number().int().min(0).default(0),
            data: json.nullish(),
          }),
        )
        .default([]),
      graphEntities: z
        .array(
          z.object({
            key: z.string().min(1).max(2000),
            entityType: z.string().min(1).max(50),
            name: z.string().max(500),
            url: z.string().nullish(),
            properties: json.nullish(),
          }),
        )
        .default([]),
      graphRelations: z
        .array(
          z.object({
            sourceKey: z.string(),
            targetKey: z.string(),
            relationType: z.string().min(1).max(50),
            weight: z.number().finite().default(1),
            properties: json.nullish(),
          }),
        )
        .default([]),
    })
    .passthrough()
    .optional(),
});

export type AuditResultInput = z.infer<typeof auditResultSchema>;
export type CrawlRecordsInput = NonNullable<AuditResultInput["crawl"]>;

const OPEN: string[] = ["open", "in_progress"];
const jsonValue = (v: unknown) => (v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const itemKey = (i: { ruleId?: string | null; title: string; targetUrl?: string | null }) =>
  `${i.ruleId ?? `title:${i.title}`}|${i.targetUrl ?? ""}`;
const toDate = (s?: string | null) => (s ? new Date(s) : undefined);

/**
 * Stores crawl session stats, page snapshots and the knowledge graph of one crawl.
 * The graph is replaced (latest crawl wins): stale entities are removed, relations rebuilt.
 */
export async function applyCrawlRecords(siteId: string, crawlSessionId: string | null, rec: CrawlRecordsInput) {
  return prisma.$transaction(
    async (tx) => {
      if (crawlSessionId && rec.crawlSession) {
        const s = rec.crawlSession;
        await tx.crawlSession.update({
          where: { id: crawlSessionId },
          data: {
            status: s.status,
            pagesCrawled: s.pagesCrawled,
            pagesFailed: s.pagesFailed,
            startedAt: toDate(s.startedAt),
            finishedAt: toDate(s.finishedAt) ?? new Date(),
          },
        });
      }
      for (const p of rec.crawledPages) {
        const data = {
          crawlSessionId,
          statusCode: p.statusCode ?? null,
          pageType: p.pageType ?? null,
          title: p.title ?? null,
          metaDescription: p.metaDescription ?? null,
          canonical: p.canonical ?? null,
          h1: p.h1 ?? null,
          wordCount: p.wordCount,
          depth: p.depth,
          data: jsonValue(p.data),
          crawledAt: new Date(),
        };
        await tx.crawledPage.upsert({
          where: { siteId_url: { siteId, url: p.url } },
          create: { siteId, url: p.url, ...data },
          update: data,
        });
      }

      if (rec.graphEntities.length === 0) return { pages: rec.crawledPages.length, entities: 0, relations: 0 };
      const ids = new Map<string, string>();
      for (const e of rec.graphEntities) {
        const data = {
          crawlSessionId,
          entityType: e.entityType,
          name: e.name,
          url: e.url ?? null,
          properties: jsonValue(e.properties),
        };
        const row = await tx.graphEntity.upsert({
          where: { siteId_key: { siteId, key: e.key } },
          create: { siteId, key: e.key, ...data },
          update: data,
          select: { id: true },
        });
        ids.set(e.key, row.id);
      }
      await tx.graphEntity.deleteMany({ where: { siteId, key: { notIn: [...ids.keys()] } } });
      await tx.graphRelation.deleteMany({ where: { siteId } });
      const seen = new Set<string>();
      const relations: Prisma.GraphRelationCreateManyInput[] = [];
      for (const r of rec.graphRelations) {
        const sourceId = ids.get(r.sourceKey);
        const targetId = ids.get(r.targetKey);
        const k = `${sourceId}|${targetId}|${r.relationType}`;
        if (!sourceId || !targetId || seen.has(k)) continue;
        seen.add(k);
        relations.push({
          siteId,
          sourceId,
          targetId,
          relationType: r.relationType,
          weight: r.weight,
          properties: jsonValue(r.properties),
        });
      }
      if (relations.length) await tx.graphRelation.createMany({ data: relations });
      return { pages: rec.crawledPages.length, entities: ids.size, relations: relations.length };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}

/**
 * Completes an audit with its scores and reconciles action items against previous audits:
 * - same (ruleId, targetUrl) still open  -> updated in place and moved to this audit
 * - same recommendation dismissed by a user -> not recreated
 * - machine-generated open item no longer reported -> auto-resolved (the defect was fixed)
 * - otherwise -> created
 */
export async function applyAuditResult(siteId: string, auditId: string, input: AuditResultInput) {
  const audit = await prisma.geoAudit.findUnique({ where: { id: auditId } });
  if (!audit || audit.siteId !== siteId) throw notFound("Audit");
  if (audit.status === "failed") throw new HttpError(409, "Audit already failed; start a new audit");

  const crawl = input.crawl ? await applyCrawlRecords(siteId, audit.crawlSessionId, input.crawl) : null;

  return prisma.$transaction(
    async (tx) => {
      const now = new Date();
      const updated = await tx.geoAudit.update({
        where: { id: auditId },
        data: {
          status: "completed",
          geoScore: input.audit.geoScore,
          seoScore: input.audit.seoScore,
          eeatScore: input.audit.eeatScore,
          metrics: input.audit.metrics as Prisma.InputJsonValue,
          summary: input.audit.summary ?? null,
          error: null,
          completedAt: now,
        },
      });
      if (audit.crawlSessionId && !input.crawl?.crawlSession) {
        await tx.crawlSession.updateMany({
          where: { id: audit.crawlSessionId, status: { in: ["queued", "running"] } },
          data: { status: "completed", finishedAt: now },
        });
      }

      const existing = await tx.actionItem.findMany({
        where: { siteId, status: { in: [...OPEN, "dismissed"] } },
        orderBy: { createdAt: "asc" },
      });
      const byKey = new Map(existing.map((i) => [itemKey(i), i]));
      const stats = { created: 0, updated: 0, resolved: 0, skippedDismissed: 0 };
      const touched = new Set<string>();

      for (const item of input.actionItems) {
        const key = itemKey(item);
        if (touched.has(key)) continue;
        touched.add(key);
        const data = {
          auditId,
          title: item.title,
          description: item.description ?? null,
          category: item.category,
          impact: item.impact,
          effort: item.effort ?? null,
          ruleId: item.ruleId ?? null,
          priority: item.priority ?? null,
          targetUrl: item.targetUrl ?? null,
          details: jsonValue(item.details),
        };
        const prev = byKey.get(key);
        if (prev?.status === "dismissed") {
          stats.skippedDismissed++;
        } else if (prev) {
          await tx.actionItem.update({ where: { id: prev.id }, data });
          stats.updated++;
        } else {
          await tx.actionItem.create({ data: { siteId, ...data } });
          stats.created++;
        }
      }

      const stale = existing.filter((i) => i.ruleId && OPEN.includes(i.status) && !touched.has(itemKey(i)));
      if (stale.length) {
        await tx.actionItem.updateMany({
          where: { id: { in: stale.map((i) => i.id) } },
          data: { status: "resolved", resolvedAt: now },
        });
        stats.resolved = stale.length;
      }
      return { audit: updated, actionItems: stats, crawl };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

export const actionListQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : ["open", "in_progress"]))
    .pipe(z.array(z.enum(ACTION_STATUSES))),
  category: z.enum(ACTION_CATEGORIES).optional(),
  impact: z.enum(ACTION_IMPACTS).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Action cards ordered by priority (highest first) — the "Ne Yapılmalı?" list. */
export async function listActionItems(siteId: string, q: z.infer<typeof actionListQuerySchema>) {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) throw notFound("Site");
  const items = await prisma.actionItem.findMany({
    where: { siteId, status: { in: q.status }, category: q.category, impact: q.impact },
    orderBy: [{ priority: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: q.limit,
  });
  return items;
}

export const updateActionItemSchema = z.object({ status: z.enum(ACTION_STATUSES) });

export async function updateActionItemStatus(siteId: string, id: string, status: (typeof ACTION_STATUSES)[number]) {
  const item = await prisma.actionItem.findUnique({ where: { id } });
  if (!item || item.siteId !== siteId) throw notFound("Action item");
  return prisma.actionItem.update({
    where: { id },
    data: { status, resolvedAt: status === "resolved" ? new Date() : status === "open" ? null : item.resolvedAt },
  });
}
