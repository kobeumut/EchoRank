import type { Site } from "@prisma/client";
import { prisma } from "../db";
import { getSiteOrThrow } from "../services/sites";
import { FAQ_TYPES } from "./config";

// Normalized, read-only view of a site's crawl data + knowledge graph. Every AI-facing output
// (llms.txt, sitemap-ai.xml, feeds, webhooks) is rendered from this one shape.

type Props = Record<string, unknown>;

export interface CatalogPage {
  url: string;
  title: string;
  description: string | null;
  pageType: string;
  h1: string | null;
  excerpt: string | null;
  wordCount: number;
  statusCode: number | null;
  /** 2xx (or unknown), not noindex, canonical points to itself. */
  indexable: boolean;
  pagerank: number | null;
  lastModified: Date;
}

export interface CatalogProduct {
  key: string;
  name: string;
  url: string | null;
  description: string | null;
  sku: string | null;
  image: string | null;
  price: number | null;
  currency: string | null;
  availability: string | null;
  rating: number | null;
  reviewCount: number | null;
  brand: string | null;
  categories: string[];
  lastModified: Date;
}

export interface CatalogFaq {
  question: string;
  answer: string | null;
  url: string | null;
}

export interface SiteCatalog {
  site: Site;
  organization: { name: string; description: string | null; sameAs: string[] } | null;
  pages: CatalogPage[];
  products: CatalogProduct[];
  /** Category name -> product count, most populated first. */
  categories: { name: string; productCount: number }[];
  faqs: CatalogFaq[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Comparable form of a URL: no hash, no trailing slash on non-root paths. */
export function normalizeForCompare(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return raw;
  }
}

function isIndexable(statusCode: number | null, canonical: string | null, url: string, data: Props) {
  if (statusCode !== null && (statusCode < 200 || statusCode >= 300)) return false;
  const meta = (data.meta ?? {}) as Props;
  const robots = `${str(meta.robots) ?? ""} ${str(meta.googlebot) ?? ""}`.toLowerCase();
  if (robots.includes("noindex")) return false;
  if (canonical && normalizeForCompare(canonical) !== normalizeForCompare(url)) return false;
  return true;
}

export async function loadSiteCatalog(siteId: string): Promise<SiteCatalog> {
  const site = await getSiteOrThrow(siteId);
  const [crawled, entities, relations] = await Promise.all([
    prisma.crawledPage.findMany({ where: { siteId }, orderBy: { url: "asc" } }),
    prisma.graphEntity.findMany({ where: { siteId }, orderBy: { createdAt: "asc" } }),
    prisma.graphRelation.findMany({
      where: { siteId, relationType: { in: ["has_category", "contains_product", "has_brand"] } },
      select: { sourceId: true, targetId: true, relationType: true },
    }),
  ]);
  const byId = new Map(entities.map((e) => [e.id, e]));

  const pagerankByUrl = new Map<string, number>();
  for (const e of entities) {
    const pr = num((e.properties as Props | null)?.pagerank);
    if (e.entityType === "Page" && e.url && pr !== null) pagerankByUrl.set(normalizeForCompare(e.url), pr);
  }

  const pages: CatalogPage[] = crawled.map((p) => {
    const data = (p.data ?? {}) as Props;
    return {
      url: p.url,
      title: p.title ?? p.h1 ?? p.url,
      description: p.metaDescription,
      pageType: p.pageType ?? "other",
      h1: p.h1,
      excerpt: str(data.text_excerpt),
      wordCount: p.wordCount,
      statusCode: p.statusCode,
      indexable: isIndexable(p.statusCode, p.canonical, p.url, data),
      pagerank: pagerankByUrl.get(normalizeForCompare(p.url)) ?? null,
      lastModified: p.crawledAt,
    };
  });
  // Graph-only sites (imported graph, no page snapshots yet): fall back to Page entities.
  const known = new Set(pages.map((p) => normalizeForCompare(p.url)));
  for (const e of entities) {
    if (e.entityType !== "Page" || !e.url || known.has(normalizeForCompare(e.url))) continue;
    if (!sameHost(e.url, site.url)) continue;
    const props = (e.properties ?? {}) as Props;
    known.add(normalizeForCompare(e.url));
    pages.push({
      url: e.url,
      title: e.name,
      description: str(props.description),
      pageType: str(props.page_type) ?? (new URL(e.url).pathname === "/" ? "home" : "other"),
      h1: null,
      excerpt: null,
      wordCount: 0,
      statusCode: null,
      indexable: true,
      pagerank: num(props.pagerank),
      lastModified: e.updatedAt,
    });
  }

  const categoriesOf = new Map<string, Set<string>>();
  const brandOf = new Map<string, string>();
  const link = (productId: string, categoryName: string) => {
    if (!categoriesOf.has(productId)) categoriesOf.set(productId, new Set());
    categoriesOf.get(productId)!.add(categoryName);
  };
  for (const r of relations) {
    const src = byId.get(r.sourceId);
    const dst = byId.get(r.targetId);
    if (!src || !dst) continue;
    if (r.relationType === "has_category" && src.entityType === "Product" && dst.entityType === "Category") {
      link(src.id, dst.name);
    } else if (r.relationType === "contains_product" && src.entityType === "Category" && dst.entityType === "Product") {
      link(dst.id, src.name);
    } else if (r.relationType === "has_brand" && src.entityType === "Product") {
      brandOf.set(src.id, dst.name);
    }
  }

  const products: CatalogProduct[] = entities
    .filter((e) => e.entityType === "Product" && !(e.properties as Props | null)?.placeholder)
    .map((e) => {
      const p = (e.properties ?? {}) as Props;
      return {
        key: e.key,
        name: e.name,
        url: str(p.url) ?? e.url,
        description: str(p.description),
        sku: str(p.sku),
        image: str(p.image),
        price: num(p.price),
        currency: str(p.currency),
        availability: str(p.availability),
        rating: num(p.rating),
        reviewCount: num(p.review_count),
        brand: brandOf.get(e.id) ?? str(p.brand),
        categories: [...(categoriesOf.get(e.id) ?? [])],
        lastModified: e.updatedAt,
      };
    });

  const categoryCounts = new Map<string, number>();
  for (const e of entities) if (e.entityType === "Category") categoryCounts.set(e.name, 0);
  for (const p of products) for (const c of p.categories) categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);

  const org = entities.find((e) => e.entityType === "Organization");
  const orgProps = (org?.properties ?? {}) as Props;

  return {
    site,
    organization: org
      ? {
          name: org.name,
          description: str(orgProps.description),
          sameAs: Array.isArray(orgProps.same_as) ? orgProps.same_as.filter((s): s is string => typeof s === "string") : [],
        }
      : null,
    pages,
    products,
    categories: [...categoryCounts.entries()]
      .map(([name, productCount]) => ({ name, productCount }))
      .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name)),
    faqs: entities
      .filter((e) => FAQ_TYPES.includes(e.entityType))
      .map((e) => ({ question: e.name, answer: str((e.properties as Props | null)?.answer), url: e.url })),
  };
}

export function sameHost(url: string, siteUrl: string) {
  try {
    return new URL(url).host === new URL(siteUrl).host;
  } catch {
    return false;
  }
}
