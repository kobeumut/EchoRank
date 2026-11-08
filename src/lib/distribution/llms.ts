import { getDistributionSettings } from "./config";
import type { CatalogPage, CatalogProduct, SiteCatalog } from "./content";

// llms.txt (https://llmstxt.org): an H1 with the site name (the only required part), a
// blockquote summary, optional free text, then H2 sections holding "- [name](url): notes" lists.
// A section titled "Optional" marks links an agent may skip when its context is tight.
// llms-full.txt carries the same structure with the content inlined, so an agent can answer
// from one fetch without crawling.

export const AI_PATHS = {
  llms: "/llms.txt",
  llmsFull: "/llms-full.txt",
  sitemap: "/sitemap-ai.xml",
  rss: "/ai-feed.xml",
  atom: "/ai-feed.atom",
  json: "/ai-feed.json",
} as const;

const KEY_PAGE_TYPES = ["about", "contact", "faq", "service", "category"];
const NOTE_MAX = 160;

/** Collapses whitespace and cuts at a word boundary. */
export function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

const escText = (t: string) => t.replace(/([\\[\]])/g, "\\$1").replace(/\s+/g, " ").trim();
const escUrl = (u: string) => u.replace(/[()\s]/g, (c) => encodeURIComponent(c));
const linkItem = (name: string, url: string, note?: string) =>
  `- [${escText(name)}](${escUrl(url)})${note ? `: ${note}` : ""}`;

const AVAILABILITY_LABEL: Record<string, string> = {
  in_stock: "In stock",
  out_of_stock: "Out of stock",
  pre_order: "Pre-order",
  back_order: "Back-order",
  discontinued: "Discontinued",
  limited: "Limited availability",
};

export function availabilityLabel(value: string | null) {
  if (!value) return null;
  const key = value.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return AVAILABILITY_LABEL[key] ?? value;
}

export function formatPrice(p: Pick<CatalogProduct, "price" | "currency">) {
  if (p.price === null) return null;
  const amount = Number.isInteger(p.price) ? String(p.price) : p.price.toFixed(2);
  return p.currency ? `${amount} ${p.currency}` : amount;
}

function productFacts(p: CatalogProduct) {
  return [
    formatPrice(p),
    availabilityLabel(p.availability),
    p.brand ? `Brand: ${p.brand}` : null,
    p.rating !== null ? `Rating ${p.rating}${p.reviewCount ? ` (${p.reviewCount} reviews)` : ""}` : null,
  ].filter(Boolean) as string[];
}

function productNote(p: CatalogProduct) {
  const facts = productFacts(p).join(" · ");
  const desc = clip(p.description, NOTE_MAX - Math.min(facts.length, 80));
  return [facts, desc].filter(Boolean).join(" — ");
}

/** Products worth listing first: in stock, priced, described, recently updated. */
function rankProducts(products: CatalogProduct[]) {
  const score = (p: CatalogProduct) =>
    (p.availability === "in_stock" ? 4 : 0) + (p.price !== null ? 2 : 0) + (p.description ? 1 : 0);
  return [...products]
    .filter((p) => p.url)
    .sort((a, b) => score(b) - score(a) || b.lastModified.getTime() - a.lastModified.getTime() || a.name.localeCompare(b.name));
}

function rankPages(pages: CatalogPage[]) {
  return [...pages]
    .filter((p) => p.indexable)
    .sort((a, b) => (b.pagerank ?? 0) - (a.pagerank ?? 0) || a.url.localeCompare(b.url));
}

function summary(c: SiteCatalog) {
  return clip(c.site.description ?? c.organization?.description ?? `Official website of ${c.site.title}.`, 300);
}

function header(c: SiteCatalog) {
  const facts = [
    `Website: ${c.site.url}`,
    c.organization ? `Organization: ${c.organization.name}` : null,
    c.products.length ? `Catalog: ${c.products.length} products in ${c.categories.length || 1} categories` : null,
    c.organization?.sameAs.length ? `Official profiles: ${c.organization.sameAs.join(", ")}` : null,
  ].filter(Boolean);
  return [`# ${escText(c.site.title)}`, "", `> ${summary(c)}`, "", ...facts.map((f) => `- ${f}`)];
}

/** Products grouped under their primary category, biggest categories first. */
function groupProducts(c: SiteCatalog, limit: number) {
  const chosen = rankProducts(c.products).slice(0, limit);
  const order = new Map(c.categories.map((cat, i) => [cat.name, i]));
  const groups = new Map<string, CatalogProduct[]>();
  for (const p of chosen) {
    const primary = [...p.categories].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))[0] ?? "Products";
    if (!groups.has(primary)) groups.set(primary, []);
    groups.get(primary)!.push(p);
  }
  return {
    chosen,
    groups: [...groups.entries()].sort((a, b) => (order.get(a[0]) ?? 1e9) - (order.get(b[0]) ?? 1e9)),
  };
}

function resourcesSection(c: SiteCatalog, full: boolean) {
  const { llms } = getDistributionSettings(c.site);
  const lines = [
    full
      ? linkItem("llms.txt", c.site.url + AI_PATHS.llms, "Short index of this file")
      : linkItem("llms-full.txt", c.site.url + AI_PATHS.llmsFull, "Full product catalog, FAQ answers and page content in one file"),
    linkItem("AI sitemap", c.site.url + AI_PATHS.sitemap, "Prioritized list of indexable URLs with last-modified dates"),
    linkItem("Product & content feed (JSON)", c.site.url + AI_PATHS.json, "Rotating structured summaries with schema.org JSON-LD"),
    ...llms.apiEndpoints.map((e) => linkItem(e.name, e.url, e.description)),
  ];
  return ["", "## Machine-readable resources", "", ...lines];
}

export function buildLlmsTxt(c: SiteCatalog): string {
  const { llms } = getDistributionSettings(c.site);
  const out = header(c);
  const { groups } = groupProducts(c, llms.maxProducts);
  for (const [category, items] of groups) {
    out.push("", `## ${escText(category)}`, "", ...items.map((p) => linkItem(p.name, p.url!, productNote(p))));
  }

  const pages = rankPages(c.pages);
  const keyPages = pages.filter((p) => p.pageType === "home" || KEY_PAGE_TYPES.includes(p.pageType));
  const articles = pages.filter((p) => p.pageType === "article");
  const pageNote = (p: CatalogPage) => clip(p.description ?? p.excerpt, NOTE_MAX) || undefined;
  if (keyPages.length) {
    out.push("", "## Key pages", "", ...keyPages.slice(0, llms.maxPages).map((p) => linkItem(p.title, p.url, pageNote(p))));
  }
  if (articles.length) {
    out.push("", "## Guides & articles", "", ...articles.slice(0, llms.maxPages).map((p) => linkItem(p.title, p.url, pageNote(p))));
  }
  const faqs = c.faqs.filter((f) => f.url).slice(0, llms.maxFaqs);
  if (faqs.length) {
    out.push("", "## FAQ", "", ...faqs.map((f) => linkItem(f.question, f.url!, clip(f.answer, NOTE_MAX) || undefined)));
  }
  out.push(...resourcesSection(c, false));

  const listed = new Set([...keyPages, ...articles].slice(0, llms.maxPages * 2).map((p) => p.url));
  const rest = pages.filter((p) => !listed.has(p.url) && p.pageType !== "product").slice(0, llms.maxPages);
  if (rest.length) out.push("", "## Optional", "", ...rest.map((p) => linkItem(p.title, p.url, pageNote(p))));
  return out.join("\n") + "\n";
}

export function buildLlmsFullTxt(c: SiteCatalog): string {
  const { llms } = getDistributionSettings(c.site);
  // Full file is for one-shot ingestion: allow a larger slice than the index.
  const productLimit = Math.max(llms.maxProducts, Math.min(c.products.length, llms.maxProducts * 5));
  const out = header(c);
  if (c.organization?.description && c.organization.description !== c.site.description) {
    out.push("", clip(c.organization.description, 1_000));
  }

  const { groups } = groupProducts(c, productLimit);
  if (groups.length) out.push("", "## Products");
  for (const [category, items] of groups) {
    out.push("", `### ${escText(category)}`);
    for (const p of items) {
      out.push("", `#### [${escText(p.name)}](${escUrl(p.url!)})`, "");
      const facts = [
        formatPrice(p) && `Price: ${formatPrice(p)}`,
        availabilityLabel(p.availability) && `Availability: ${availabilityLabel(p.availability)}`,
        p.brand && `Brand: ${p.brand}`,
        p.sku && `SKU: ${p.sku}`,
        p.categories.length > 1 && `Categories: ${p.categories.join(", ")}`,
        p.rating !== null && `Rating: ${p.rating}${p.reviewCount ? ` (${p.reviewCount} reviews)` : ""}`,
      ].filter(Boolean) as string[];
      out.push(...facts.map((f) => `- ${f}`));
      if (p.description) out.push("", clip(p.description, 1_000));
    }
  }

  const faqs = c.faqs.slice(0, llms.maxFaqs * 4);
  if (faqs.length) {
    out.push("", "## Frequently asked questions");
    for (const f of faqs) {
      out.push("", `### ${escText(f.question)}`, "", clip(f.answer, 1_500) || "_No answer published._");
      if (f.url) out.push("", `Source: ${f.url}`);
    }
  }

  const pages = rankPages(c.pages).filter((p) => p.pageType !== "product" && (p.excerpt || p.description));
  if (pages.length) out.push("", "## Pages");
  for (const p of pages.slice(0, llms.maxPages * 2)) {
    out.push("", `### [${escText(p.title)}](${escUrl(p.url)})`, "", clip(p.excerpt ?? p.description, 1_000));
  }
  out.push(...resourcesSection(c, true));
  return out.join("\n") + "\n";
}
