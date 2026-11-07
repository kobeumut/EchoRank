import type { Prisma, Site } from "@prisma/client";
import { prisma } from "../db";
import { HttpError, notFound } from "../http";
import type { CreateSiteInput, UpdateSiteInput } from "../validation";

type Integrations = Record<string, string>;

/** Masks secrets: "abcd1234efgh" -> "abcd…efgh" (short values fully masked). */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function serializeSite(site: Site) {
  const integrations = (site.integrations ?? {}) as Integrations;
  return {
    ...site,
    integrations: Object.fromEntries(Object.entries(integrations).map(([k, v]) => [k, maskSecret(String(v))])),
  };
}

function titleFromUrl(url: string) {
  return new URL(url).hostname.replace(/^www\./, "");
}

export async function listSites(opts: { q?: string; limit?: number; offset?: number } = {}) {
  const where: Prisma.SiteWhereInput = opts.q
    ? { OR: [{ url: { contains: opts.q } }, { title: { contains: opts.q } }] }
    : {};
  const [items, total] = await Promise.all([
    prisma.site.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: opts.limit ?? 50,
      skip: opts.offset ?? 0,
      include: {
        audits: {
          where: { status: "completed" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, geoScore: true, seoScore: true, eeatScore: true, createdAt: true },
        },
        _count: { select: { actionItems: { where: { status: "open" } } } },
      },
    }),
    prisma.site.count({ where }),
  ]);
  return {
    items: items.map(({ audits, _count, ...site }) => ({
      ...serializeSite(site),
      latestAudit: audits[0] ?? null,
      openActionItems: _count.actionItems,
    })),
    total,
  };
}

export async function getSiteOrThrow(id: string) {
  const site = await prisma.site.findUnique({ where: { id } });
  if (!site) throw notFound("Site");
  return site;
}

export async function createSite(input: CreateSiteInput) {
  const existing = await prisma.site.findUnique({ where: { url: input.url } });
  if (existing) throw new HttpError(409, "A site with this URL already exists", { id: existing.id });
  const site = await prisma.site.create({
    data: {
      url: input.url,
      title: input.title ?? titleFromUrl(input.url),
      description: input.description,
      settings: (input.settings ?? {}) as Prisma.InputJsonValue,
      targetKeywords: input.targetKeywords ?? [],
      integrations: input.integrations ?? {},
    },
  });
  return serializeSite(site);
}

export async function updateSite(id: string, input: UpdateSiteInput) {
  const site = await getSiteOrThrow(id);
  let integrations: Integrations | undefined;
  if (input.integrations) {
    integrations = { ...((site.integrations ?? {}) as Integrations) };
    for (const [k, v] of Object.entries(input.integrations)) {
      if (v === null) delete integrations[k];
      else integrations[k] = v;
    }
  }
  const updated = await prisma.site.update({
    where: { id },
    data: {
      url: input.url,
      title: input.title,
      description: input.description,
      settings: input.settings as Prisma.InputJsonValue | undefined,
      targetKeywords: input.targetKeywords,
      integrations,
    },
  });
  return serializeSite(updated);
}

export async function deleteSite(id: string) {
  await getSiteOrThrow(id);
  await prisma.site.delete({ where: { id } });
}
