// EntityEnrichment: a queryable mirror of the Wikidata reconciliation the crawler and wikidata.ts keep inside
// GraphEntity.properties. GraphEntity stays the source of truth; every read re-syncs the mirror, and every
// verify/reject/requery goes through wikidata.ts so the knowledge graph's same_as edges stay consistent.
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { csvEnum, queryBool } from "../validation";
import {
  applyReconciliationAction, AUTO_ACCEPT, RECONCILABLE_TYPES, RECONCILIATION_STATUSES, reconciliationActionSchema, wikidataUrl,
} from "./wikidata";
import { getSiteOrThrow } from "./sites";

type Json = Record<string, unknown>;
const props = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const urls = (v: unknown) => (Array.isArray(v) ? v.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)) : []);

type EntityRow = { id: string; key: string; entityType: string; name: string; properties: unknown };

/**
 * Verified = a human pinned the QID, or an automatic/declared match cleared the auto-accept threshold.
 * Only verified rows publish sameAs links.
 */
export function enrichmentOf(e: EntityRow) {
  const p = props(e.properties);
  const r = props(p.reconciliation);
  const status = (typeof r.status === "string" ? r.status : "pending") as (typeof RECONCILIATION_STATUSES)[number];
  const confidence = typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : 0;
  const wikidataId = typeof p.wikidataId === "string" ? p.wikidataId : null;
  const isVerified = !!wikidataId && (status === "verified" || ((status === "matched" || status === "declared") && confidence >= AUTO_ACCEPT));
  const wikipediaUrl = typeof p.wikipediaUrl === "string" ? p.wikipediaUrl : null;
  const sameAs = [...new Set([...(wikidataId ? [wikidataUrl(wikidataId)] : []), ...(wikipediaUrl ? [wikipediaUrl] : []), ...urls(p.sameAs)])];
  return {
    entityId: e.id,
    entityKey: e.key,
    entityName: e.name.slice(0, 500),
    entityType: e.entityType,
    status,
    wikidataId,
    wikipediaUrl,
    sameAsLinks: sameAs,
    matchConfidence: Math.round(confidence * 1e4) / 1e4,
    isVerified,
  };
}

/** Rebuilds the mirror for one site (or the given entities) from GraphEntity; drops rows whose entity is gone. */
export async function syncEnrichments(siteId: string, entityIds?: string[]) {
  const rows = await prisma.graphEntity.findMany({
    where: { siteId, entityType: { in: [...RECONCILABLE_TYPES] }, ...(entityIds ? { id: { in: entityIds } } : {}) },
    select: { id: true, key: true, entityType: true, name: true, properties: true },
    take: 20_000,
  });
  const next = rows.map(enrichmentOf);
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.entityEnrichment.findMany({
        where: { siteId, ...(entityIds ? { entityKey: { in: next.map((n) => n.entityKey) } } : {}) },
      });
      const byKey = new Map(existing.map((e) => [e.entityKey, e]));
      let changed = 0;
      for (const n of next) {
        const prev = byKey.get(n.entityKey);
        if (prev && same(prev, n)) continue;
        const data = { ...n, sameAsLinks: n.sameAsLinks as Prisma.InputJsonValue };
        // entityId is unique: a re-keyed entity must release it before another row takes it.
        await tx.entityEnrichment.updateMany({ where: { entityId: n.entityId, NOT: { entityKey: n.entityKey } }, data: { entityId: null } });
        await tx.entityEnrichment.upsert({
          where: { siteId_entityKey: { siteId, entityKey: n.entityKey } },
          create: { siteId, ...data },
          update: data,
        });
        changed++;
      }
      const removed = entityIds
        ? 0
        : (await tx.entityEnrichment.deleteMany({ where: { siteId, entityKey: { notIn: next.map((n) => n.entityKey) } } })).count;
      return { entities: next.length, changed, removed };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

function same(prev: { entityId: string | null; entityName: string; entityType: string; status: string; wikidataId: string | null; wikipediaUrl: string | null; sameAsLinks: unknown; matchConfidence: number; isVerified: boolean }, n: ReturnType<typeof enrichmentOf>) {
  return (
    prev.entityId === n.entityId && prev.entityName === n.entityName && prev.entityType === n.entityType && prev.status === n.status &&
    prev.wikidataId === n.wikidataId && prev.wikipediaUrl === n.wikipediaUrl && prev.matchConfidence === n.matchConfidence &&
    prev.isVerified === n.isVerified && JSON.stringify(prev.sameAsLinks ?? []) === JSON.stringify(n.sameAsLinks)
  );
}

// ---------------------------------------------------------------- API

export const entityEnrichmentQuerySchema = z.object({
  status: csvEnum(RECONCILIATION_STATUSES),
  type: z.enum(RECONCILABLE_TYPES).optional(),
  verified: queryBool.optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const entityRef = z.object({ entityId: z.string().min(1).max(64) });
export const entityReconcileActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }).strict(),
  reconciliationActionSchema.options[0].extend(entityRef.shape).strict(),
  reconciliationActionSchema.options[1].extend(entityRef.shape).strict(),
  reconciliationActionSchema.options[2].extend(entityRef.shape).strict(),
]);
export const entityReconcileBodySchema = entityReconcileActionSchema.default({ action: "sync" });

export async function listEnrichments(siteId: string, q: z.infer<typeof entityEnrichmentQuerySchema>) {
  await getSiteOrThrow(siteId);
  const sync = await syncEnrichments(siteId);
  const where: Prisma.EntityEnrichmentWhereInput = {
    siteId,
    ...(q.status ? { status: { in: q.status } } : {}),
    ...(q.type ? { entityType: q.type } : {}),
    ...(q.verified !== undefined ? { isVerified: q.verified } : {}),
    ...(q.minConfidence !== undefined ? { matchConfidence: { gte: q.minConfidence } } : {}),
  };
  const [items, total, byStatus, verified] = await Promise.all([
    prisma.entityEnrichment.findMany({
      where,
      orderBy: [{ isVerified: "desc" }, { matchConfidence: "desc" }, { entityName: "asc" }],
      take: q.limit,
      skip: q.offset,
    }),
    prisma.entityEnrichment.count({ where }),
    prisma.entityEnrichment.groupBy({ by: ["status"], where: { siteId }, _count: { _all: true } }),
    prisma.entityEnrichment.findMany({
      where: { siteId, isVerified: true },
      orderBy: [{ entityType: "asc" }, { entityName: "asc" }],
      select: { entityKey: true, entityName: true, entityType: true, wikidataId: true, sameAsLinks: true },
    }),
  ]);
  return {
    items,
    total,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    /** Ready for Schema.org `sameAs`: verified entities only. */
    sameAs: verified,
    sync,
  };
}

export async function reconcileEntity(siteId: string, input: z.infer<typeof entityReconcileActionSchema>) {
  await getSiteOrThrow(siteId);
  if (input.action === "sync") return { action: "sync", ...(await syncEnrichments(siteId)) };
  const { entityId, ...action } = input;
  const entity = await applyReconciliationAction(siteId, entityId, action);
  await syncEnrichments(siteId, [entityId]);
  const enrichment = await prisma.entityEnrichment.findUnique({ where: { entityId } });
  return { action: input.action, entity, enrichment };
}
