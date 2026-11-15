import type { Prisma, Site } from "@prisma/client";
import { prisma } from "../db";
import { HttpError, notFound } from "../http";
import { DEFAULT_LOCALE, toLocale, type Locale } from "../i18n/config";
import { asIntegrationRecord, openIntegrations, sealIntegrations } from "../secrets";
import type { CreateSiteInput, UpdateSiteInput } from "../validation";

type Integrations = Record<string, string>;

/**
 * Masks secrets for API responses: only a short tail of long values is shown, so the user can recognise a key
 * without the response revealing a usable part of it. "abcdefghijklmnop1234" -> "…1234"; values shorter than
 * 16 characters (and anything JSON-like, e.g. a Google service-account file) are fully masked.
 */
export function maskSecret(value: string): string {
  if (value.length < 16 || /^\s*[{[]/.test(value)) return "••••";
  return `…${value.slice(-4)}`;
}

/** API shape of a site: integration secrets are decrypted only to mask them (undecryptable ones are fully masked). */
export function serializeSite(site: Site) {
  return {
    ...site,
    integrations: Object.fromEntries(Object.entries(openIntegrations(site.integrations)).map(([k, v]) => [k, v === null ? "••••" : maskSecret(v)])),
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

/**
 * Language for text generated without an HTTP request (scheduled reports and audits): the site's `settings.locale`
 * ("tr", "tr-TR", "en-GB" …) when it is a supported locale, otherwise English.
 */
export function siteLocale(site: { settings: unknown }): Locale {
  const settings = site.settings && typeof site.settings === "object" && !Array.isArray(site.settings) ? (site.settings as { locale?: unknown }) : {};
  return (typeof settings.locale === "string" ? toLocale(settings.locale) : null) ?? DEFAULT_LOCALE;
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
      integrations: sealIntegrations(input.integrations ?? {}),
    },
  });
  return serializeSite(site);
}

export async function updateSite(id: string, input: UpdateSiteInput) {
  const site = await getSiteOrThrow(id);
  let integrations: Integrations | undefined;
  if (input.integrations) {
    integrations = asIntegrationRecord(site.integrations);
    for (const [k, v] of Object.entries(input.integrations)) {
      if (v === null) delete integrations[k];
      else integrations[k] = v;
    }
    integrations = sealIntegrations(integrations); // encrypted at rest (legacy plaintext values are upgraded too)
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
