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
      targetKeywords: ["organic olive oil", "cold-pressed olive oil prices"],
      settings: { maxPages: 200, maxDepth: 4, locale: "en-US" },
    },
  });

  const mk = (key: string, entityType: string, name: string, path?: string) =>
    prisma.graphEntity.create({
      data: { siteId: site.id, key, entityType, name, url: path ? url + path : null },
    });
  const home = await mk(url + "/", "Page", "Home", "/");
  const cat = await mk("category:olive-oil", "Category", "Olive Oil", "/olive-oil");
  const prod = await mk("product:cp-1", "Product", "Cold-Pressed Olive Oil 1L", "/product/cold-pressed-1l");
  const faq = await mk("faq:1", "FAQ", "What is cold-pressed olive oil?", "/faq");
  const org = await mk("org", "Organization", "Demo Shop Inc.");
  const orphan = await mk(url + "/old-campaign", "Page", "Old Campaign", "/old-campaign");
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
    ["chatgpt", "best organic olive oil", "mentioned", 4],
    ["gemini", "best organic olive oil", "cited", 2],
    ["claude", "where to buy cold-pressed olive oil", "none", null],
    ["perplexity", "where to buy cold-pressed olive oil", "cited", 1],
  ];
  for (const [model, query, citationStatus, position] of checks) {
    await prisma.llmVisibilityRecord.create({ data: { siteId: site.id, model, query, citationStatus, position } });
  }

  await prisma.actionItem.createMany({
    data: [
      { siteId: site.id, auditId: audit.id, title: "Add Product + Offer JSON-LD to product pages", category: "schema", impact: "high" },
      { siteId: site.id, auditId: audit.id, title: "Allow GPTBot / PerplexityBot access in robots.txt", category: "crawler", impact: "high" },
      { siteId: site.id, auditId: audit.id, title: "Create an author bio and expertise page (E-E-A-T)", category: "authority", impact: "medium" },
      { siteId: site.id, auditId: audit.id, title: "Add internal links to the orphan page /old-campaign or remove it", category: "content", impact: "low" },
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
