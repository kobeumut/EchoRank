import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import * as distribution from "@/app/api/sites/[id]/distribution/route";
import * as keyRoute from "@/app/api/sites/[id]/distribution/indexnow-key/route";
import * as verifyRoute from "@/app/api/sites/[id]/distribution/indexnow-key/verify/route";
import * as queueRoute from "@/app/api/sites/[id]/distribution/queue/route";
import * as syncRoute from "@/app/api/sites/[id]/distribution/sync/route";
import * as dispatchRoute from "@/app/api/sites/[id]/distribution/dispatch/route";
import * as syndicateRoute from "@/app/api/sites/[id]/distribution/syndicate/route";
import * as llmsRoute from "@/app/api/sites/[id]/ai/llms.txt/route";
import * as llmsFullRoute from "@/app/api/sites/[id]/ai/llms-full.txt/route";
import * as sitemapRoute from "@/app/api/sites/[id]/ai/sitemap-ai.xml/route";
import * as rssRoute from "@/app/api/sites/[id]/ai/ai-feed.xml/route";
import * as atomRoute from "@/app/api/sites/[id]/ai/ai-feed.atom/route";
import * as jsonFeedRoute from "@/app/api/sites/[id]/ai/ai-feed.json/route";
import { buildJwtAssertion, clearGoogleTokenCache } from "@/lib/distribution/google";
import { assertPublicHttpUrl, isPrivateAddress } from "@/lib/distribution/net";
import { dispatchSite, MAX_ATTEMPTS } from "@/lib/distribution/queue";
import { currentPeriod, selectRotation } from "@/lib/distribution/syndication";
import { loadSiteCatalog } from "@/lib/distribution/content";
import { executeAudit, registerAuditRunner, startAudit } from "@/lib/services/audit";
import { ctx, req, resetDb } from "./helpers";

const ORIGIN = "https://shop.example.com";
const KEY = "0123456789abcdef0123456789abcdef";

type FetchCall = { url: string; init: RequestInit & { body?: string } };
let calls: FetchCall[] = [];

/** Routes outbound fetches to a handler; records every call. */
function mockFetch(handler: (url: string, init: FetchCall["init"]) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: FetchCall["init"] = {}) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
}
const indexNowCalls = () => calls.filter((c) => c.url.includes("indexnow"));

beforeEach(async () => {
  await resetDb();
  clearGoogleTokenCache();
  process.env.ALLOW_PRIVATE_NETWORK_TARGETS = "true";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALLOW_PRIVATE_NETWORK_TARGETS;
});
afterAll(() => prisma.$disconnect());

async function makeSite(opts: { distribution?: object; integrations?: Record<string, string> } = {}) {
  return prisma.site.create({
    data: {
      url: ORIGIN,
      title: "Example Shop",
      description: "Cold-pressed olive oils from family farms in the Aegean.",
      settings: { distribution: opts.distribution ?? {} },
      integrations: opts.integrations ?? { indexnowKey: KEY },
    },
  });
}

const page = (siteId: string, path: string, extra: Record<string, unknown> = {}) =>
  prisma.crawledPage.create({
    data: {
      siteId,
      url: ORIGIN + path,
      statusCode: 200,
      pageType: "other",
      title: path,
      wordCount: 300,
      data: { text_excerpt: `Body text of ${path}`, meta: {} },
      ...extra,
    },
  });

/** A small catalog: 2 categories, 3 products, FAQ, article, about, a noindex page and a 404. */
async function seedCatalog(siteId: string) {
  await page(siteId, "/", { pageType: "home", title: "Example Shop — Olive Oil" });
  await page(siteId, "/about", { pageType: "about", title: "About us", metaDescription: "Family farm since 1952." });
  await page(siteId, "/blog/cold-press", { pageType: "article", title: "What is cold pressing?" });
  await page(siteId, "/p/evoo-1l", { pageType: "product", title: "EVOO 1L" });
  await page(siteId, "/p/evoo-5l", { pageType: "product", title: "EVOO 5L" });
  await page(siteId, "/p/soap", { pageType: "product", title: "Olive soap" });
  await page(siteId, "/cart", { data: { meta: { robots: "noindex, follow" } } });
  await page(siteId, "/old", { statusCode: 404 });

  const ent = (key: string, entityType: string, name: string, properties: object = {}, url?: string) =>
    prisma.graphEntity.create({ data: { siteId, key, entityType, name, url, properties } });
  const oil = await ent("category:oil", "Category", "Olive Oil");
  const care = await ent("category:care", "Category", "Body Care");
  const brand = await ent("brand:ege", "Brand", "Ege Farms");
  const p1 = await ent("product:evoo-1l", "Product", "EVOO [Early Harvest] 1L", {
    url: `${ORIGIN}/p/evoo-1l`, price: 349.9, currency: "TRY", availability: "in_stock", description: "Early harvest, acidity 0.3%.", sku: "EV1",
  });
  const p2 = await ent("product:evoo-5l", "Product", "EVOO 5L", {
    url: `${ORIGIN}/p/evoo-5l`, price: 1499, currency: "TRY", availability: "out_of_stock",
  });
  const p3 = await ent("product:soap", "Product", "Olive soap", { url: `${ORIGIN}/p/soap`, price: 89, currency: "TRY", availability: "in_stock" });
  await ent("Product:ghost", "Product", "ghost", { placeholder: true });
  await ent("org", "Organization", "Ege Farms Ltd.", { same_as: ["https://instagram.com/egefarms"] });
  await ent("q1", "Question", "Is it organic?", { answer: "Yes, certified by ECOCERT since 2015." }, `${ORIGIN}/faq`);
  await ent(`${ORIGIN}/`, "Page", "Home", { pagerank: 0.3 }, `${ORIGIN}/`);
  await ent(`${ORIGIN}/about`, "Page", "About", { pagerank: 0.05 }, `${ORIGIN}/about`);
  await prisma.graphRelation.createMany({
    data: [
      { siteId, sourceId: p1.id, targetId: oil.id, relationType: "has_category" },
      { siteId, sourceId: oil.id, targetId: p2.id, relationType: "contains_product" },
      { siteId, sourceId: p3.id, targetId: care.id, relationType: "has_category" },
      { siteId, sourceId: p1.id, targetId: brand.id, relationType: "has_brand" },
    ],
  });
}

describe("AI outputs: llms.txt, llms-full.txt, sitemap-ai.xml", () => {
  it("renders a spec-shaped llms.txt from the catalog", async () => {
    const s = await makeSite();
    await seedCatalog(s.id);
    const res = await llmsRoute.GET(req(`/api/sites/${s.id}/ai/llms.txt`), ctx(s.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    const lines = body.split("\n");

    expect(lines[0]).toBe("# Example Shop");
    expect(lines[2]).toBe("> Cold-pressed olive oils from family farms in the Aegean.");
    expect(body).toContain("- Catalog: 3 products in 2 categories");
    expect(body).toContain("- Official profiles: https://instagram.com/egefarms");
    // Biggest category first, products as link lists with facts; brackets escaped.
    expect(body.indexOf("## Olive Oil")).toBeLessThan(body.indexOf("## Body Care"));
    expect(body).toContain(
      "- [EVOO \\[Early Harvest\\] 1L](https://shop.example.com/p/evoo-1l): 349.90 TRY · In stock · Brand: Ege Farms — Early harvest, acidity 0.3%.",
    );
    expect(body).toContain("- [EVOO 5L](https://shop.example.com/p/evoo-5l): 1499 TRY · Out of stock");
    expect(body).not.toContain("ghost");
    expect(body).toContain("## Key pages");
    expect(body).toContain("- [About us](https://shop.example.com/about): Family farm since 1952.");
    expect(body).toContain("## Guides & articles");
    expect(body).toContain("- [Is it organic?](https://shop.example.com/faq): Yes, certified by ECOCERT since 2015.");
    expect(body).toContain("- [llms-full.txt](https://shop.example.com/llms-full.txt)");
    expect(body).not.toContain("/cart");
    expect(body).not.toContain("/old");
  });

  it("inlines content in llms-full.txt", async () => {
    const s = await makeSite({
      distribution: { llms: { apiEndpoints: [{ name: "Stock API", url: "https://api.example.com/stock", description: "Live stock" }] } },
    });
    await seedCatalog(s.id);
    const body = await (await llmsFullRoute.GET(req("/x"), ctx(s.id))).text();
    expect(body).toContain("## Products");
    expect(body).toContain("#### [EVOO \\[Early Harvest\\] 1L](https://shop.example.com/p/evoo-1l)");
    expect(body).toContain("- Price: 349.90 TRY");
    expect(body).toContain("- SKU: EV1");
    expect(body).toContain("### Is it organic?\n\nYes, certified by ECOCERT since 2015.");
    expect(body).toContain("Body text of /blog/cold-press");
    expect(body).toContain("- [Stock API](https://api.example.com/stock): Live stock");
  });

  it("builds sitemap-ai.xml with indexable URLs only, ordered by priority", async () => {
    const s = await makeSite();
    await seedCatalog(s.id);
    const res = await sitemapRoute.GET(req("/x"), ctx(s.id));
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    expect(locs[0]).toBe(`${ORIGIN}/`);
    expect(locs).toContain(`${ORIGIN}/p/evoo-1l`);
    expect(locs).not.toContain(`${ORIGIN}/cart`);
    expect(locs).not.toContain(`${ORIGIN}/old`);
    expect(new Set(locs).size).toBe(locs.length);
    expect(xml).toMatch(/<priority>1\.0<\/priority>/);
  });

  it("returns 404 for unknown sites", async () => {
    expect((await llmsRoute.GET(req("/x"), ctx("nope"))).status).toBe(404);
  });
});

describe("IndexNow key management", () => {
  it("generates, serves and rotates the key file", async () => {
    const s = await makeSite({ integrations: {} });
    expect((await keyRoute.GET(req("/x"), ctx(s.id))).status).toBe(404);

    const created = await keyRoute.POST(req("/x", { method: "POST" }), ctx(s.id));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.key).toMatch(/^[a-f0-9]{32}$/);
    expect(body.keyLocation).toBe(`${ORIGIN}/${body.key}.txt`);
    expect(body.fileContent).toBe(body.key);

    const again = await keyRoute.POST(req("/x", { method: "POST" }), ctx(s.id));
    expect(again.status).toBe(200);
    expect((await again.json()).key).toBe(body.key);

    const file = await keyRoute.GET(req("/x?format=txt"), ctx(s.id));
    expect(await file.text()).toBe(body.key);
    expect(file.headers.get("content-disposition")).toContain(`${body.key}.txt`);

    const rotated = await (await keyRoute.POST(req("/x", { method: "POST", body: { rotate: true } }), ctx(s.id))).json();
    expect(rotated.key).not.toBe(body.key);

    // Integrations stay masked in the regular site API.
    const overview = await (await distribution.GET(req("/x"), ctx(s.id))).json();
    expect(overview.readiness.indexnow.keyConfigured).toBe(true);
  });

  it("verifies the published key file", async () => {
    const s = await makeSite();
    mockFetch(() => new Response(`${KEY}\n`, { status: 200 }));
    const ok = await (await verifyRoute.POST(req("/x", { method: "POST" }), ctx(s.id))).json();
    expect(ok).toMatchObject({ valid: true, httpStatus: 200, keyLocation: `${ORIGIN}/${KEY}.txt` });

    mockFetch(() => new Response("other", { status: 200 }));
    const bad = await (await verifyRoute.POST(req("/x", { method: "POST" }), ctx(s.id))).json();
    expect(bad).toMatchObject({ valid: false, reason: "Key file content does not match the key" });
  });
});

describe("notification queue", () => {
  it("enqueues explicit URLs, rejects foreign hosts and dedupes per URL", async () => {
    const s = await makeSite();
    const post = (body: unknown) => queueRoute.POST(req("/x", { method: "POST", body }), ctx(s.id));
    const res = await post({ urls: [`${ORIGIN}/p/1`, `${ORIGIN}/p/1#reviews`, "https://evil.com/x", "nonsense"] });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ queued: 1, accepted: 1, rejected: ["https://evil.com/x", "nonsense"], channels: ["indexnow"] });
    await post({ urls: [`${ORIGIN}/p/1`], reason: "deleted" });
    const items = (await (await queueRoute.GET(req("/x?status=pending"), ctx(s.id))).json()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ url: `${ORIGIN}/p/1`, reason: "deleted", channel: "indexnow" });

    expect((await post({ urls: ["https://evil.com/x"] })).status).toBe(400);
    expect((await post({ urls: [] })).status).toBe(400);
  });

  it("detects created, unchanged, updated and deleted pages from crawl data", async () => {
    const s = await makeSite();
    await seedCatalog(s.id);
    const sync = async (body?: unknown) => (await syncRoute.POST(req("/x", { method: "POST", body }), ctx(s.id))).json();

    const first = await sync();
    // 6 indexable pages; /cart (noindex) ignored; /old (404) never announced so not "deleted".
    expect(first).toMatchObject({ created: 6, updated: 0, deleted: 0, ignored: 2 });
    await prisma.submissionQueueItem.updateMany({ data: { status: "sent" } });

    expect(await sync()).toMatchObject({ created: 0, updated: 0, unchanged: 6 });

    // Price change on a product (graph data, page HTML snapshot unchanged) -> updated.
    const p = await prisma.graphEntity.findFirstOrThrow({ where: { siteId: s.id, key: "product:evoo-5l" } });
    await prisma.graphEntity.update({ where: { id: p.id }, data: { properties: { ...(p.properties as object), price: 1299 } } });
    // Page removed -> deleted.
    await prisma.crawledPage.update({ where: { siteId_url: { siteId: s.id, url: `${ORIGIN}/p/soap` } }, data: { statusCode: 410 } });

    const third = await sync();
    expect(third).toMatchObject({ created: 0, updated: 1, deleted: 1, unchanged: 4 });
    const pending = await prisma.submissionQueueItem.findMany({ where: { siteId: s.id, status: "pending" }, orderBy: { url: "asc" } });
    expect(pending.map((r) => [r.url, r.reason])).toEqual([
      [`${ORIGIN}/p/evoo-5l`, "updated"],
      [`${ORIGIN}/p/soap`, "deleted"],
    ]);
  });

  it("baseline mode records fingerprints without notifying", async () => {
    const s = await makeSite();
    await seedCatalog(s.id);
    expect(await (await syncRoute.POST(req("/x", { method: "POST", body: { mode: "baseline" } }), ctx(s.id))).json()).toMatchObject({
      created: 6,
      mode: "baseline",
    });
    expect(await prisma.submissionQueueItem.count({ where: { status: "pending" } })).toBe(0);
    expect(await (await syncRoute.POST(req("/x", { method: "POST" }), ctx(s.id))).json()).toMatchObject({ created: 0, unchanged: 6 });
  });
});

describe("dispatch", () => {
  async function queued(siteOpts?: Parameters<typeof makeSite>[0], urls = [`${ORIGIN}/a`, `${ORIGIN}/b`]) {
    const s = await makeSite(siteOpts);
    await queueRoute.POST(req("/x", { method: "POST", body: { urls } }), ctx(s.id));
    return s;
  }

  it("sends a valid IndexNow request and marks rows sent", async () => {
    const s = await queued();
    mockFetch(() => new Response(null, { status: 200 }));
    const res = await (await dispatchRoute.POST(req("/x", { method: "POST" }), ctx(s.id))).json();
    expect(res.channels[0]).toMatchObject({ channel: "indexnow", claimed: 2, sent: 2, failed: 0 });

    expect(indexNowCalls()).toHaveLength(1);
    const call = indexNowCalls()[0];
    expect(call.url).toBe("https://api.indexnow.org/indexnow");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(call.init.body!)).toEqual({ host: "shop.example.com", key: KEY, urlList: [`${ORIGIN}/a`, `${ORIGIN}/b`] });

    const rows = await prisma.submissionQueueItem.findMany({ where: { siteId: s.id } });
    expect(rows.every((r) => r.status === "sent" && r.sentAt && r.submissionId && !r.claimId)).toBe(true);
    const sub = await prisma.platformSubmission.findFirstOrThrow({ where: { siteId: s.id } });
    expect(sub).toMatchObject({ platform: "indexnow", status: "sent" });

    // Nothing due anymore.
    const again = await (await dispatchRoute.POST(req("/x", { method: "POST" }), ctx(s.id))).json();
    expect(again.claimed).toBe(0);
  });

  it("retries 429 with backoff, fails fast on 422", async () => {
    const s = await queued();
    mockFetch(() => new Response("slow down", { status: 429 }));
    const r1 = await dispatchSite(s.id);
    expect(r1.channels[0]).toMatchObject({ deferred: 2, sent: 0 });
    let rows = await prisma.submissionQueueItem.findMany({ where: { siteId: s.id } });
    expect(rows.every((r) => r.status === "pending" && r.attempts === 1 && r.nextAttemptAt > new Date())).toBe(true);
    expect(rows[0].lastError).toContain("Too many requests");

    await prisma.submissionQueueItem.updateMany({ data: { nextAttemptAt: new Date(0) } });
    mockFetch(() => new Response("bad host", { status: 422 }));
    const r2 = await dispatchSite(s.id);
    expect(r2.channels[0]).toMatchObject({ failed: 2 });
    rows = await prisma.submissionQueueItem.findMany({ where: { siteId: s.id } });
    expect(rows.every((r) => r.status === "failed" && r.attempts === 2)).toBe(true);
  });

  it("gives up after MAX_ATTEMPTS retryable failures", async () => {
    const s = await queued(undefined, [`${ORIGIN}/a`]);
    await prisma.submissionQueueItem.updateMany({ data: { attempts: MAX_ATTEMPTS - 1 } });
    mockFetch(() => new Response(null, { status: 503 }));
    await dispatchSite(s.id);
    expect((await prisma.submissionQueueItem.findFirstOrThrow()).status).toBe("failed");
  });

  it("defers without burning attempts when no key is configured", async () => {
    const s = await queued({ integrations: {} });
    mockFetch(() => new Response(null, { status: 200 }));
    const r = await dispatchSite(s.id);
    expect(r.channels[0]).toMatchObject({ deferred: 2, message: "IndexNow key is not configured" });
    expect(calls).toHaveLength(0);
    const rows = await prisma.submissionQueueItem.findMany();
    expect(rows.every((x) => x.status === "pending" && x.attempts === 0)).toBe(true);
  });

  it("never sends a row twice when dispatches overlap", async () => {
    const urls = Array.from({ length: 30 }, (_, i) => `${ORIGIN}/p/${i}`);
    const s = await queued(undefined, urls);
    mockFetch(() => new Response(null, { status: 202 }));
    await Promise.all([dispatchSite(s.id), dispatchSite(s.id), dispatchSite(s.id)]);
    const sent = indexNowCalls().flatMap((c) => JSON.parse(c.init.body!).urlList as string[]);
    expect(sent.sort()).toEqual([...urls].sort());
    expect(await prisma.submissionQueueItem.count({ where: { status: "sent" } })).toBe(30);
  });

  it("re-enqueue during an in-flight send keeps the fresh row pending", async () => {
    const s = await queued(undefined, [`${ORIGIN}/a`]);
    mockFetch(async () => {
      // CMS saves the product again while the request is in flight.
      await queueRoute.POST(req("/x", { method: "POST", body: { urls: [`${ORIGIN}/a`] } }), ctx(s.id));
      return new Response(null, { status: 200 });
    });
    await dispatchSite(s.id);
    expect((await prisma.submissionQueueItem.findFirstOrThrow()).status).toBe("pending");
  });
});

describe("Google channels", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = {
    client_email: "bot@proj.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: "https://oauth2.googleapis.com/token",
  };

  it("signs a verifiable RS256 JWT assertion", () => {
    const jwt = buildJwtAssertion(sa, "scope-a", 1_000);
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      iss: sa.client_email,
      scope: "scope-a",
      aud: sa.token_uri,
      iat: 1_000,
      exp: 4_600,
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, sig, "base64url")).toBe(true);
  });

  it("publishes via the Indexing API within quota and resubmits sitemaps once", async () => {
    const s = await makeSite({
      distribution: {
        channels: { indexnow: true, googleIndexingApi: true, googleSearchConsole: true },
        google: { indexingDailyQuota: 1, sitemaps: [`${ORIGIN}/sitemap.xml`] },
      },
      integrations: { indexnowKey: KEY, googleServiceAccount: JSON.stringify(sa) },
    });
    await queueRoute.POST(req("/x", { method: "POST", body: { urls: [`${ORIGIN}/a`, `${ORIGIN}/b`], reason: "deleted" } }), ctx(s.id));
    mockFetch((url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
      return new Response("{}", { status: 200 });
    });
    const r = await dispatchSite(s.id);
    const byChannel = Object.fromEntries(r.channels.map((c) => [c.channel, c]));
    expect(byChannel.indexnow).toMatchObject({ sent: 2 });
    expect(byChannel.google_indexing).toMatchObject({ sent: 1, deferred: 1 });
    expect(byChannel.google_search_console).toMatchObject({ sent: 1 });

    const publish = calls.filter((c) => c.url.includes("urlNotifications:publish"));
    expect(publish).toHaveLength(1);
    expect(JSON.parse(publish[0].init.body!)).toEqual({ url: `${ORIGIN}/a`, type: "URL_DELETED" });
    expect((publish[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const gsc = calls.filter((c) => c.url.includes("/webmasters/v3/sites/"));
    expect(gsc).toHaveLength(1);
    expect(gsc[0].url).toBe(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(ORIGIN + "/")}/sitemaps/${encodeURIComponent(ORIGIN + "/sitemap.xml")}`,
    );
    expect(gsc[0].init.method).toBe("PUT");

    // Second send within the hour: sitemaps not resubmitted.
    await queueRoute.POST(req("/x", { method: "POST", body: { urls: [`${ORIGIN}/c`], channels: ["indexnow"] } }), ctx(s.id));
    const r2 = await dispatchSite(s.id);
    expect(r2.channels.find((c) => c.channel === "google_search_console")?.message).toContain("less than an hour");
  });
});

describe("settings", () => {
  it("merges partial updates and validates", async () => {
    const s = await makeSite();
    const patch = (body: unknown) => distribution.PATCH(req("/x", { method: "PATCH", body }), ctx(s.id));
    const res = await patch({ channels: { googleSearchConsole: true }, syndication: { itemsPerPeriod: 3 } });
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(settings.channels).toEqual({ indexnow: true, googleSearchConsole: true, googleIndexingApi: false });
    expect(settings.syndication).toMatchObject({ itemsPerPeriod: 3, frequency: "weekly" });
    const again = await (await patch({ syndication: { frequency: "daily" } })).json();
    expect(again.settings.syndication).toMatchObject({ itemsPerPeriod: 3, frequency: "daily" });

    expect((await patch({ syndication: { itemsPerPeriod: 0 } })).status).toBe(400);
    expect((await patch({ syndication: { webhooks: [{ url: "ftp://x" }] } })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
  });
});

describe("syndication", () => {
  it("rotates deterministically per period with pinned items first", async () => {
    const s = await makeSite({ distribution: { syndication: { itemsPerPeriod: 3, pinnedKeys: ["product:soap"] } } });
    for (let i = 0; i < 20; i++) {
      await prisma.graphEntity.create({
        data: { siteId: s.id, key: `product:${i}`, entityType: "Product", name: `P${i}`, properties: { url: `${ORIGIN}/p/${i}`, price: i } },
      });
    }
    await prisma.graphEntity.create({
      data: { siteId: s.id, key: "product:soap", entityType: "Product", name: "Soap", properties: { url: `${ORIGIN}/p/soap` } },
    });
    const c = await loadSiteCatalog(s.id);
    const monday = new Date("2026-11-09T10:00:00Z");
    const p1 = currentPeriod("weekly", monday);
    expect(p1.start.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(currentPeriod("weekly", new Date("2026-11-15T23:59:00Z")).key).toBe(p1.key);

    const a = selectRotation(c, p1).map((i) => i.id);
    const b = selectRotation(c, p1).map((i) => i.id);
    expect(a).toEqual(b);
    expect(a[0]).toBe("product:soap");
    expect(a).toHaveLength(3);
    const picks = new Set<string>();
    for (let w = 0; w < 8; w++) {
      const p = currentPeriod("weekly", new Date(monday.getTime() + w * 7 * 86_400_000));
      selectRotation(c, p).slice(1).forEach((i) => picks.add(i.id));
    }
    expect(picks.size).toBeGreaterThan(6);
  });

  it("serves RSS, Atom and JSON feeds with JSON-LD", async () => {
    const s = await makeSite();
    await seedCatalog(s.id);
    const rss = await (await rssRoute.GET(req("/x"), ctx(s.id))).text();
    expect(rss).toContain('<rss version="2.0"');
    expect(rss).toContain("<title>EVOO [Early Harvest] 1L</title>");
    const atom = await (await atomRoute.GET(req("/x"), ctx(s.id))).text();
    expect(atom).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    const feedRes = await jsonFeedRoute.GET(req("/x"), ctx(s.id));
    expect(feedRes.headers.get("content-type")).toContain("application/feed+json");
    const feed = await feedRes.json();
    expect(feed.version).toBe("https://jsonfeed.org/version/1.1");
    const evoo = feed.items.find((i: { url: string }) => i.url === `${ORIGIN}/p/evoo-1l`);
    expect(evoo._schema_org).toMatchObject({
      "@type": "Product",
      brand: { "@type": "Brand", name: "Ege Farms" },
      offers: { "@type": "Offer", price: 349.9, priceCurrency: "TRY", availability: "https://schema.org/InStock" },
    });
    expect(feed.items.some((i: { tags: string[] }) => i.tags[0] === "Article")).toBe(true);
  });

  it("delivers signed webhooks once per period", async () => {
    const s = await makeSite({
      distribution: { syndication: { webhooks: [{ url: "https://hooks.example.com/in", format: "markdown" }] } },
      integrations: { indexnowKey: KEY, webhookSecret: "s3cret" },
    });
    await seedCatalog(s.id);
    mockFetch(() => new Response("ok", { status: 200 }));
    const post = (body?: unknown) => syndicateRoute.POST(req("/x", { method: "POST", body }), ctx(s.id));

    const first = await (await post()).json();
    expect(first.results[0]).toMatchObject({ status: "sent", httpStatus: 200 });
    const call = calls[0];
    const headers = call.init.headers as Record<string, string>;
    const expected = `sha256=${createHmac("sha256", "s3cret").update(`${headers["x-aiv-timestamp"]}.${call.init.body}`).digest("hex")}`;
    expect(headers["x-aiv-signature"]).toBe(expected);
    const payload = JSON.parse(call.init.body!);
    expect(payload).toMatchObject({ event: "syndication.published", site: { url: ORIGIN } });
    expect(payload.markdown).toContain("# Example Shop — weekly highlights");
    expect(payload.feed.items.length).toBeGreaterThan(0);

    expect((await (await post()).json()).results[0].status).toBe("skipped");
    expect((await (await post({ force: true })).json()).results[0].status).toBe("sent");
    expect(calls).toHaveLength(2);
    expect(await prisma.platformSubmission.count({ where: { platform: "webhook", status: "sent" } })).toBe(2);

    const preview = await (await syndicateRoute.GET(req("/x"), ctx(s.id))).json();
    expect(preview.period.frequency).toBe("weekly");
  });

  it("refuses webhooks pointing to private networks", async () => {
    delete process.env.ALLOW_PRIVATE_NETWORK_TARGETS;
    const s = await makeSite({ distribution: { syndication: { webhooks: [{ url: "http://127.0.0.1:8080/hook" }] } } });
    await seedCatalog(s.id);
    mockFetch(() => new Response("ok"));
    const res = await (await syndicateRoute.POST(req("/x", { method: "POST" }), ctx(s.id))).json();
    expect(res.results[0]).toMatchObject({ status: "failed" });
    expect(res.results[0].message).toContain("private network");
    expect(calls).toHaveLength(0);
  });
});

describe("network guard", () => {
  it("classifies private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("rejects localhost and non-http targets", async () => {
    delete process.env.ALLOW_PRIVATE_NETWORK_TARGETS;
    await expect(assertPublicHttpUrl("http://localhost/x")).rejects.toThrow("private network");
    await expect(assertPublicHttpUrl("http://[::1]/x")).rejects.toThrow("private network");
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow("Only http(s)");
  });
});

describe("audit hand-off", () => {
  it("queues and sends changed URLs after a completed crawl", async () => {
    const s = await makeSite();
    const job = await startAudit(s.id, { trigger: "manual" });
    registerAuditRunner(async (j) => {
      await page(j.site.id, "/", { pageType: "home" });
      await page(j.site.id, "/p/new", { pageType: "product" });
      await prisma.crawlSession.update({ where: { id: j.crawlSession.id }, data: { status: "completed" } });
    });
    mockFetch(() => new Response(null, { status: 200 }));
    await executeAudit(job);
    registerAuditRunner(null);

    expect(indexNowCalls()).toHaveLength(1);
    expect(JSON.parse(indexNowCalls()[0].init.body!).urlList).toEqual([`${ORIGIN}/`, `${ORIGIN}/p/new`]);
    expect(await prisma.submissionQueueItem.count({ where: { status: "sent" } })).toBe(2);
  });

  it("does not notify when distribution is disabled", async () => {
    const s = await makeSite({ distribution: { enabled: false } });
    const job = await startAudit(s.id, { trigger: "manual" });
    registerAuditRunner(async (j) => {
      await page(j.site.id, "/");
      await prisma.crawlSession.update({ where: { id: j.crawlSession.id }, data: { status: "completed" } });
    });
    mockFetch(() => new Response(null, { status: 200 }));
    await executeAudit(job);
    registerAuditRunner(null);
    expect(calls).toHaveLength(0);
    expect(await prisma.submissionQueueItem.count()).toBe(0);
  });
});
