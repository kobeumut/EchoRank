import type { CatalogPage, SiteCatalog } from "./content";
import { normalizeForCompare, sameHost } from "./content";

// sitemap-ai.xml: a standard sitemaps.org file restricted to URLs worth a crawler's budget
// (indexable 2xx pages and product URLs), ordered and prioritized by page type and internal
// PageRank so crawlers that stop early still get the most important pages.

export const SITEMAP_MAX_URLS = 50_000;

const TYPE_WEIGHT: Record<string, number> = {
  home: 1,
  category: 0.8,
  product: 0.8,
  service: 0.8,
  faq: 0.7,
  article: 0.6,
  about: 0.5,
  contact: 0.5,
  other: 0.4,
};
const CHANGEFREQ: Record<string, string> = {
  home: "daily",
  category: "daily",
  product: "daily",
  article: "weekly",
  faq: "weekly",
  service: "weekly",
};

export function xmlEscape(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

interface Entry {
  url: string;
  lastmod: Date;
  pageType: string;
  pagerank: number | null;
}

export function sitemapEntries(c: SiteCatalog) {
  const entries = new Map<string, Entry>();
  const add = (e: Entry) => {
    const k = normalizeForCompare(e.url);
    const prev = entries.get(k);
    if (!prev || e.lastmod > prev.lastmod) entries.set(k, { ...e, pageType: prev?.pageType ?? e.pageType });
  };
  for (const p of c.pages.filter((p: CatalogPage) => p.indexable)) {
    add({ url: p.url, lastmod: p.lastModified, pageType: p.pageType, pagerank: p.pagerank });
  }
  const nonIndexable = new Set(c.pages.filter((p) => !p.indexable).map((p) => normalizeForCompare(p.url)));
  for (const p of c.products) {
    if (!p.url || !sameHost(p.url, c.site.url) || nonIndexable.has(normalizeForCompare(p.url))) continue;
    add({ url: p.url, lastmod: p.lastModified, pageType: "product", pagerank: null });
  }

  const maxPr = Math.max(0, ...[...entries.values()].map((e) => e.pagerank ?? 0));
  return [...entries.values()]
    .map((e) => {
      const base = TYPE_WEIGHT[e.pageType] ?? TYPE_WEIGHT.other;
      const pr = maxPr > 0 && e.pagerank !== null ? e.pagerank / maxPr : base;
      const priority = Math.round(Math.min(1, Math.max(0.1, base * 0.7 + pr * 0.3)) * 10) / 10;
      return { ...e, priority, changefreq: CHANGEFREQ[e.pageType] ?? "monthly" };
    })
    .sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url))
    .slice(0, SITEMAP_MAX_URLS);
}

export function buildAiSitemap(c: SiteCatalog): string {
  const urls = sitemapEntries(c).map(
    (e) =>
      "  <url>\n" +
      `    <loc>${xmlEscape(e.url)}</loc>\n` +
      `    <lastmod>${e.lastmod.toISOString()}</lastmod>\n` +
      `    <changefreq>${e.changefreq}</changefreq>\n` +
      `    <priority>${e.priority.toFixed(1)}</priority>\n` +
      "  </url>",
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
