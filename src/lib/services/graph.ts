import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import type { EntityType } from "../constants";
import { getSiteOrThrow } from "./sites";

export async function getSiteGraph(siteId: string, opts: { types?: EntityType[]; limit: number }) {
  await getSiteOrThrow(siteId);
  const where: Prisma.GraphEntityWhereInput = { siteId, ...(opts.types ? { entityType: { in: opts.types } } : {}) };

  const [entities, totalEntities, typeCounts] = await Promise.all([
    prisma.graphEntity.findMany({ where, orderBy: { createdAt: "asc" }, take: opts.limit }),
    prisma.graphEntity.count({ where }),
    prisma.graphEntity.groupBy({ by: ["entityType"], where: { siteId }, _count: { _all: true } }),
  ]);

  const ids = entities.map((e) => e.id);
  const relations = ids.length
    ? await prisma.graphRelation.findMany({
        where: { siteId, sourceId: { in: ids }, targetId: { in: ids } },
      })
    : [];

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const r of relations) {
    incoming.set(r.targetId, (incoming.get(r.targetId) ?? 0) + 1);
    outgoing.set(r.sourceId, (outgoing.get(r.sourceId) ?? 0) + 1);
  }

  const nodes = entities.map((e) => ({
    id: e.id,
    key: e.key,
    type: e.entityType,
    label: e.name,
    url: e.url,
    properties: e.properties,
    inDegree: incoming.get(e.id) ?? 0,
    outDegree: outgoing.get(e.id) ?? 0,
  }));
  const edges = relations.map((r) => ({
    id: r.id,
    source: r.sourceId,
    target: r.targetId,
    type: r.relationType,
    weight: r.weight,
  }));

  // Orphan = a non-home Page node nobody links to (within the returned subgraph).
  const orphanPages = nodes.filter(
    (n) => n.type === "Page" && n.inDegree === 0 && !(n.url && new URL(n.url).pathname === "/"),
  ).length;

  return {
    nodes,
    edges,
    stats: {
      totalEntities,
      returnedEntities: nodes.length,
      truncated: totalEntities > nodes.length,
      edges: edges.length,
      byType: Object.fromEntries(typeCounts.map((t) => [t.entityType, t._count._all])),
      orphanPages,
    },
  };
}
