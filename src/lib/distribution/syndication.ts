import { createHash, createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { getDistributionSettings, getIntegration, INTEGRATION_KEYS, type DistributionSettings } from "./config";
import { loadSiteCatalog, type CatalogPage, type CatalogProduct, type SiteCatalog } from "./content";
import { AI_PATHS, availabilityLabel, clip, formatPrice } from "./llms";
import { OUTBOUND_TIMEOUT_MS, pinnedFetch, readSnippet } from "./net";
import { xmlEscape } from "./sitemap";

// Rotating content syndication. Each period (day / ISO-ish week) a deterministic, seeded pick of
// products/articles is published as RSS, Atom, JSON Feed and pushed to webhooks. Same period ->
// same items (feeds stay stable and cacheable); next period -> a different slice, so the whole
// catalog surfaces over time instead of the same top items forever.

const DAY_MS = 86_400_000;

export interface SyndicationItem {
  id: string;
  type: "Product" | "Article";
  title: string;
  url: string;
  summary: string;
  markdown: string;
  jsonLd: Record<string, unknown>;
  updatedAt: Date;
}

export interface Period {
  frequency: DistributionSettings["syndication"]["frequency"];
  index: number;
  key: string;
  start: Date;
}

export function currentPeriod(frequency: Period["frequency"], now = new Date()): Period {
  const days = Math.floor(now.getTime() / DAY_MS);
  // 1970-01-01 was a Thursday; +3 makes weekly periods start on Monday.
  const index = frequency === "daily" ? days : Math.floor((days + 3) / 7);
  const start = new Date((frequency === "daily" ? index : index * 7 - 3) * DAY_MS);
  return { frequency, index, key: `${frequency}:${index}`, start };
}

/** mulberry32 PRNG seeded from a string. */
function seededRandom(seed: string) {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AVAILABILITY_SCHEMA: Record<string, string> = {
  in_stock: "InStock",
  out_of_stock: "OutOfStock",
  pre_order: "PreOrder",
  back_order: "BackOrder",
  discontinued: "Discontinued",
  limited: "LimitedAvailability",
};

function productItem(p: CatalogProduct): SyndicationItem {
  const price = formatPrice(p);
  const availability = availabilityLabel(p.availability);
  const facts = [price && `**Price:** ${price}`, availability && `**Availability:** ${availability}`, p.brand && `**Brand:** ${p.brand}`]
    .filter(Boolean)
    .join(" · ");
  return {
    id: p.key,
    type: "Product",
    title: p.name,
    url: p.url!,
    summary: clip([price, availability, p.description].filter(Boolean).join(" — "), 300),
    markdown: [`### [${p.name}](${p.url})`, facts, clip(p.description, 600)].filter(Boolean).join("\n\n"),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Product",
      name: p.name,
      url: p.url,
      ...(p.description && { description: clip(p.description, 1_000) }),
      ...(p.sku && { sku: p.sku }),
      ...(p.image && { image: p.image }),
      ...(p.brand && { brand: { "@type": "Brand", name: p.brand } }),
      ...(p.categories.length && { category: p.categories.join(" > ") }),
      ...(p.price !== null && {
        offers: {
          "@type": "Offer",
          price: p.price,
          ...(p.currency && { priceCurrency: p.currency }),
          ...(p.availability &&
            AVAILABILITY_SCHEMA[p.availability] && { availability: `https://schema.org/${AVAILABILITY_SCHEMA[p.availability]}` }),
          url: p.url,
        },
      }),
      ...(p.rating !== null && {
        aggregateRating: { "@type": "AggregateRating", ratingValue: p.rating, ...(p.reviewCount && { reviewCount: p.reviewCount }) },
      }),
    },
    updatedAt: p.lastModified,
  };
}

function articleItem(p: CatalogPage): SyndicationItem {
  const summary = clip(p.description ?? p.excerpt, 300);
  return {
    id: p.url,
    type: "Article",
    title: p.title,
    url: p.url,
    summary,
    markdown: [`### [${p.title}](${p.url})`, clip(p.excerpt ?? p.description, 800)].filter(Boolean).join("\n\n"),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: p.title,
      url: p.url,
      ...(summary && { description: summary }),
      dateModified: p.lastModified.toISOString(),
    },
    updatedAt: p.lastModified,
  };
}

/** Pinned items first, then a seeded shuffle of the remaining pool for this period. */
export function selectRotation(c: SiteCatalog, period: Period): SyndicationItem[] {
  const { syndication } = getDistributionSettings(c.site);
  const pool: SyndicationItem[] = [];
  if (syndication.includeTypes.includes("Product")) pool.push(...c.products.filter((p) => p.url).map(productItem));
  if (syndication.includeTypes.includes("Article")) {
    pool.push(...c.pages.filter((p) => p.indexable && p.pageType === "article").map(articleItem));
  }
  const byId = new Map(pool.map((i) => [i.id, i]));
  const pinned = syndication.pinnedKeys.map((k) => byId.get(k)).filter((i): i is SyndicationItem => !!i);
  const pinnedIds = new Set(pinned.map((i) => i.id));
  const rest = pool.filter((i) => !pinnedIds.has(i.id)).sort((a, b) => a.id.localeCompare(b.id));

  const rand = seededRandom(`${c.site.id}:${period.key}`);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [...pinned, ...rest].slice(0, syndication.itemsPerPeriod);
}

export async function loadRotation(siteId: string, now = new Date()) {
  const catalog = await loadSiteCatalog(siteId);
  const period = currentPeriod(getDistributionSettings(catalog.site).syndication.frequency, now);
  return { catalog, period, items: selectRotation(catalog, period) };
}

const feedTitle = (c: SiteCatalog) => `${c.site.title} — AI content feed`;
const feedDescription = (c: SiteCatalog) =>
  clip(c.site.description ?? `Rotating product and content summaries from ${c.site.title}.`, 300);

export function buildRss(c: SiteCatalog, period: Period, items: SyndicationItem[]) {
  const entry = (i: SyndicationItem) =>
    [
      "    <item>",
      `      <title>${xmlEscape(i.title)}</title>`,
      `      <link>${xmlEscape(i.url)}</link>`,
      `      <guid isPermaLink="false">${xmlEscape(`${i.id}#${period.key}`)}</guid>`,
      `      <category>${i.type}</category>`,
      `      <pubDate>${period.start.toUTCString()}</pubDate>`,
      `      <description>${xmlEscape(i.summary)}</description>`,
      "    </item>",
    ].join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${xmlEscape(feedTitle(c))}</title>`,
    `    <link>${xmlEscape(c.site.url)}</link>`,
    `    <atom:link href="${xmlEscape(c.site.url + AI_PATHS.rss)}" rel="self" type="application/rss+xml"/>`,
    `    <description>${xmlEscape(feedDescription(c))}</description>`,
    `    <lastBuildDate>${period.start.toUTCString()}</lastBuildDate>`,
    `    <ttl>${period.frequency === "daily" ? 1440 : 10080}</ttl>`,
    ...items.map(entry),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

export function buildAtom(c: SiteCatalog, period: Period, items: SyndicationItem[]) {
  const updated = period.start.toISOString();
  const entry = (i: SyndicationItem) =>
    [
      "  <entry>",
      `    <title>${xmlEscape(i.title)}</title>`,
      `    <link href="${xmlEscape(i.url)}"/>`,
      `    <id>${xmlEscape(`${c.site.url}/#${encodeURIComponent(i.id)}`)}</id>`,
      `    <updated>${i.updatedAt.toISOString()}</updated>`,
      `    <category term="${i.type}"/>`,
      `    <summary>${xmlEscape(i.summary)}</summary>`,
      "  </entry>",
    ].join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${xmlEscape(feedTitle(c))}</title>`,
    `  <subtitle>${xmlEscape(feedDescription(c))}</subtitle>`,
    `  <link href="${xmlEscape(c.site.url)}"/>`,
    `  <link rel="self" href="${xmlEscape(c.site.url + AI_PATHS.atom)}"/>`,
    `  <id>${xmlEscape(c.site.url + AI_PATHS.atom)}</id>`,
    `  <updated>${updated}</updated>`,
    `  <author><name>${xmlEscape(c.organization?.name ?? c.site.title)}</name></author>`,
    ...items.map(entry),
    "</feed>",
    "",
  ].join("\n");
}

/** JSON Feed 1.1 with schema.org JSON-LD in the `_schema_org` extension. */
export function buildJsonFeed(c: SiteCatalog, period: Period, items: SyndicationItem[]) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: feedTitle(c),
    home_page_url: c.site.url,
    feed_url: c.site.url + AI_PATHS.json,
    description: feedDescription(c),
    _period: { frequency: period.frequency, key: period.key, start: period.start.toISOString() },
    items: items.map((i) => ({
      id: `${i.id}#${period.key}`,
      url: i.url,
      title: i.title,
      summary: i.summary,
      content_text: i.markdown,
      date_modified: i.updatedAt.toISOString(),
      tags: [i.type],
      _schema_org: i.jsonLd,
    })),
  };
}

export function buildMarkdownDigest(c: SiteCatalog, period: Period, items: SyndicationItem[]) {
  return [
    `# ${c.site.title} — ${period.frequency} highlights (${period.start.toISOString().slice(0, 10)})`,
    "",
    `> ${feedDescription(c)}`,
    "",
    ...items.map((i) => i.markdown),
    "",
    `More: ${c.site.url}${AI_PATHS.llms}`,
    "",
  ].join("\n\n").replace(/\n{3,}/g, "\n\n");
}

/** HMAC-SHA256 over "<timestamp>.<body>", sent as `X-AIV-Signature: sha256=<hex>`. */
export function signWebhook(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface WebhookResult {
  url: string;
  status: "sent" | "failed" | "skipped";
  httpStatus: number | null;
  message: string;
  submissionId?: string;
}

/**
 * Pushes this period's rotation to every configured webhook that has not received it yet
 * (or to all of them when `force`). Each delivery is logged as a PlatformSubmission.
 */
export async function publishSyndication(siteId: string, opts: { force?: boolean; now?: Date } = {}) {
  const { catalog, period, items } = await loadRotation(siteId, opts.now);
  const { syndication, enabled } = getDistributionSettings(catalog.site);
  const results: WebhookResult[] = [];
  if (!enabled || !syndication.webhooks.length) return { period, items: items.length, results };

  const recent = await prisma.platformSubmission.findMany({
    where: { siteId, platform: "webhook", status: "sent" },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { payload: true },
  });
  const delivered = new Set(
    recent.map((r) => {
      const p = (r.payload ?? {}) as { webhook?: string; period?: string };
      return `${p.webhook}|${p.period}`;
    }),
  );
  const secret = getIntegration(catalog.site, INTEGRATION_KEYS.webhookSecret);
  const json = buildJsonFeed(catalog, period, items);

  for (const hook of syndication.webhooks) {
    if (!opts.force && delivered.has(`${hook.url}|${period.key}`)) {
      results.push({ url: hook.url, status: "skipped", httpStatus: null, message: "Already delivered for this period" });
      continue;
    }
    if (!items.length) {
      results.push({ url: hook.url, status: "skipped", httpStatus: null, message: "Nothing to publish" });
      continue;
    }
    const envelope = {
      event: "syndication.published",
      site: { id: catalog.site.id, url: catalog.site.url, title: catalog.site.title },
      period: json._period,
      feed: json,
      ...(hook.format === "markdown" && { markdown: buildMarkdownDigest(catalog, period, items) }),
    };
    const body = JSON.stringify(envelope);
    const timestamp = String(Math.floor(Date.now() / 1000));
    let result: WebhookResult;
    try {
      const res = await pinnedFetch(hook.url, { // validated, DNS-pinned connection; redirects are not followed
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "user-agent": "AIVisibility-Syndication/1.0",
          "x-aiv-event": "syndication.published",
          "x-aiv-timestamp": timestamp,
          ...(secret && { "x-aiv-signature": signWebhook(secret, timestamp, body) }),
        },
        body,
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
      result = {
        url: hook.url,
        status: res.ok ? "sent" : "failed",
        httpStatus: res.status,
        message: res.ok ? "Delivered" : await readSnippet(res, 300),
      };
    } catch (err) {
      result = { url: hook.url, status: "failed", httpStatus: null, message: (err as Error).message };
    }
    const submission = await prisma.platformSubmission.create({
      data: {
        siteId,
        platform: "webhook",
        status: result.status,
        urls: items.map((i) => i.url),
        payload: { webhook: hook.url, period: period.key, format: hook.format, itemIds: items.map((i) => i.id) } as Prisma.InputJsonValue,
        response: { httpStatus: result.httpStatus, message: result.message },
      },
    });
    results.push({ ...result, submissionId: submission.id });
  }
  return { period, items: items.length, results };
}
