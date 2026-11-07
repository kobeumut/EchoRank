// Demo data: one site with a small graph, two audits, visibility checks and actions.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const url = "https://demo-shop.example.com";
  await prisma.site.deleteMany({ where: { url } });
  const site = await prisma.site.create({
    data: {
      url,
      title: "Demo Shop",
      description: "Seed site for local development",
      targetKeywords: ["organik zeytinyağı", "soğuk sıkım zeytinyağı fiyatları"],
      settings: { maxPages: 200, maxDepth: 4, locale: "tr-TR" },
    },
  });

  const mk = (key: string, entityType: string, name: string, path?: string) =>
    prisma.graphEntity.create({
      data: { siteId: site.id, key, entityType, name, url: path ? url + path : null },
    });
  const home = await mk(url + "/", "Page", "Anasayfa", "/");
  const cat = await mk("category:zeytinyagi", "Category", "Zeytinyağı", "/zeytinyagi");
  const prod = await mk("product:sk-1", "Product", "Soğuk Sıkım Zeytinyağı 1L", "/urun/soguk-sikim-1l");
  const faq = await mk("faq:1", "FAQ", "Soğuk sıkım nedir?", "/sss");
  const org = await mk("org", "Organization", "Demo Shop A.Ş.");
  const orphan = await mk(url + "/eski-kampanya", "Page", "Eski Kampanya", "/eski-kampanya");
  void orphan;

  const rel = (s: string, t: string, relationType: string) =>
    prisma.graphRelation.create({ data: { siteId: site.id, sourceId: s, targetId: t, relationType } });
  await rel(home.id, cat.id, "links_to");
  await rel(cat.id, prod.id, "contains_product");
  await rel(prod.id, cat.id, "has_category");
  await rel(faq.id, prod.id, "answers_question");
  await rel(home.id, org.id, "mentions_entity");

  const day = 86_400_000;
  await prisma.geoAudit.create({
    data: { siteId: site.id, status: "completed", geoScore: 48, seoScore: 66, eeatScore: 41, createdAt: new Date(Date.now() - 7 * day), completedAt: new Date(Date.now() - 7 * day) },
  });
  const audit = await prisma.geoAudit.create({
    data: {
      siteId: site.id,
      status: "completed",
      geoScore: 57,
      seoScore: 71,
      eeatScore: 49,
      metrics: { schemaCoverage: 35, crawlerAccess: 100, contentDepth: 52, citationReadiness: 44 },
      completedAt: new Date(),
    },
  });

  const checks: [string, string, string, number | null][] = [
    ["chatgpt", "en iyi organik zeytinyağı", "mentioned", 4],
    ["gemini", "en iyi organik zeytinyağı", "cited", 2],
    ["claude", "soğuk sıkım zeytinyağı nereden alınır", "none", null],
    ["perplexity", "soğuk sıkım zeytinyağı nereden alınır", "cited", 1],
  ];
  for (const [model, query, citationStatus, position] of checks) {
    await prisma.llmVisibilityRecord.create({ data: { siteId: site.id, model, query, citationStatus, position } });
  }

  await prisma.actionItem.createMany({
    data: [
      { siteId: site.id, auditId: audit.id, title: "Ürün sayfalarına Product + Offer JSON-LD ekleyin", category: "schema", impact: "high" },
      { siteId: site.id, auditId: audit.id, title: "robots.txt içinde GPTBot / PerplexityBot erişimini açın", category: "crawler", impact: "high" },
      { siteId: site.id, auditId: audit.id, title: "Yazar biyografisi ve uzmanlık sayfası oluşturun (E-E-A-T)", category: "authority", impact: "medium" },
      { siteId: site.id, auditId: audit.id, title: "Yetim sayfa /eski-kampanya için iç link ekleyin veya kaldırın", category: "content", impact: "low" },
    ],
  });

  await prisma.scheduledReport.create({
    data: { siteId: site.id, frequency: "weekly", recipients: ["seo@example.com"], nextRunAt: new Date(Date.now() + 7 * day) },
  });

  console.log(`Seeded site ${site.id} (${url})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
