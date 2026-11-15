import { readFileSync } from "node:fs";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import * as result from "@/app/api/sites/[id]/audit/[auditId]/result/route";
import * as actions from "@/app/api/sites/[id]/actions/route";
import * as action from "@/app/api/sites/[id]/actions/[actionId]/route";
import * as reports from "@/app/api/sites/[id]/reports/route";
import { executeAudit, getAuditRunner, registerAuditRunner, startAudit } from "@/lib/services/audit";
import { defaultAuditRunner, hasLangFlag } from "@/lib/services/audit-runner";
import { req, resetDb } from "./helpers";

// Output of `geo-audit --lang en` (services/crawler) for the fixture shop: contract test between Python and the API.
// The engine's own text (labels, findings, action cards) is English; the crawled sample shop ("Kahve Dükkanı", Turkish
// page content and URL slugs) is deliberately Turkish web content, as a Turkish storefront would be in production.
const FIXTURE = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/geo-audit-result.json"), "utf8"));

beforeEach(resetDb);
afterEach(() => {
  registerAuditRunner(null);
  delete process.env.GEO_AUDIT_BIN;
});
afterAll(() => prisma.$disconnect());

const rctx = (id: string, auditId: string) => ({ params: Promise.resolve({ id, auditId }) });
const actx = (id: string, actionId?: string) => ({ params: Promise.resolve({ id, actionId: actionId ?? "" }) });

async function newAudit() {
  const site = await prisma.site.create({ data: { url: "https://shop.example.com", title: "Shop" } });
  const job = await startAudit(site.id, { trigger: "manual" });
  return { site, job };
}

const post = (siteId: string, auditId: string, body: unknown) =>
  result.POST(req(`/api/sites/${siteId}/audit/${auditId}/result`, { method: "POST", body }), rctx(siteId, auditId));

describe("POST /api/sites/[id]/audit/[auditId]/result", () => {
  it("stores scores, metrics, action cards and the crawl graph from geo-audit output", async () => {
    const { site, job } = await newAudit();
    const res = await post(site.id, job.audit.id, FIXTURE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actionItems).toMatchObject({ created: FIXTURE.actionItems.length, updated: 0, resolved: 0 });
    expect(body.crawl).toMatchObject({ pages: FIXTURE.crawl.crawledPages.length, entities: FIXTURE.crawl.graphEntities.length });

    const audit = await prisma.geoAudit.findUniqueOrThrow({ where: { id: job.audit.id } });
    expect(audit.status).toBe("completed");
    expect(audit.geoScore).toBe(FIXTURE.audit.geoScore);
    expect(audit.geoScore).toBeGreaterThanOrEqual(0);
    expect(audit.geoScore).toBeLessThanOrEqual(100);
    expect(audit.metrics).toMatchObject({ aiAccess: expect.any(Number), llmReadability: expect.any(Number) });
    const cs = await prisma.crawlSession.findUniqueOrThrow({ where: { id: job.crawlSession.id } });
    expect(cs.status).toBe("completed");
    expect(cs.pagesCrawled).toBeGreaterThan(0);
    expect(await prisma.graphRelation.count({ where: { siteId: site.id } })).toBeGreaterThan(0);

    // prioritized list with copy-paste snippets
    const list = await (await actions.GET(req(`/api/sites/${site.id}/actions`), actx(site.id))).json();
    expect(list.items.length).toBe(FIXTURE.actionItems.length);
    const prios = list.items.map((i: { priority: number }) => i.priority);
    expect(prios).toEqual([...prios].sort((a, b) => b - a));
    const llms = list.items.find((i: { ruleId: string }) => i.ruleId === "technical.llms_txt");
    expect(llms.details.snippet.code).toContain("# Kahve Dükkanı");
    expect(new Set(list.items.map((i: { ruleId: string }) => i.ruleId)).size).toBeGreaterThanOrEqual(5);

    // reports endpoint picks up the completed audit
    const rep = await (await reports.GET(req(`/api/sites/${site.id}/reports`), actx(site.id))).json();
    expect(rep.scores.geo).toBe(FIXTURE.audit.geoScore);
  });

  it("reconciles action items across audits (update, auto-resolve, respect dismissals)", async () => {
    const { site, job } = await newAudit();
    await post(site.id, job.audit.id, { audit: FIXTURE.audit, actionItems: FIXTURE.actionItems });
    const items = await prisma.actionItem.findMany({ where: { siteId: site.id } });
    const dismissed = items.find((i) => i.ruleId === "technical.meta_description")!;
    await action.PATCH(
      req(`/api/sites/${site.id}/actions/${dismissed.id}`, { method: "PATCH", body: { status: "dismissed" } }),
      actx(site.id, dismissed.id),
    );
    const manual = await prisma.actionItem.create({
      data: { siteId: site.id, title: "Manual task", category: "content", impact: "low" },
    });

    // second audit: llms.txt fixed (rule gone), everything else still reported
    await prisma.crawlSession.update({ where: { id: job.crawlSession.id }, data: { status: "completed" } });
    const job2 = await startAudit(site.id, { trigger: "manual" });
    const next = FIXTURE.actionItems.filter((i: { ruleId: string }) => i.ruleId !== "technical.llms_txt");
    const res = await (await post(site.id, job2.audit.id, { audit: { ...FIXTURE.audit, geoScore: 70 }, actionItems: next })).json();
    expect(res.actionItems).toEqual({ created: 0, updated: next.length - 1, resolved: 1, skippedDismissed: 1 });

    const llms = await prisma.actionItem.findFirstOrThrow({ where: { siteId: site.id, ruleId: "technical.llms_txt" } });
    expect(llms.status).toBe("resolved");
    expect(llms.resolvedAt).not.toBeNull();
    expect((await prisma.actionItem.findUniqueOrThrow({ where: { id: dismissed.id } })).status).toBe("dismissed");
    expect((await prisma.actionItem.findUniqueOrThrow({ where: { id: manual.id } })).status).toBe("open");
    const moved = await prisma.actionItem.count({ where: { siteId: site.id, auditId: job2.audit.id } });
    expect(moved).toBe(next.length - 1);
    expect(await prisma.actionItem.count({ where: { siteId: site.id } })).toBe(FIXTURE.actionItems.length + 1);
  });

  it("validates input and ownership", async () => {
    const { site, job } = await newAudit();
    const bad = await post(site.id, job.audit.id, { audit: { ...FIXTURE.audit, geoScore: 140 } });
    expect(bad.status).toBe(400);
    const other = await prisma.site.create({ data: { url: "https://other.example.com", title: "O" } });
    expect((await post(other.id, job.audit.id, FIXTURE)).status).toBe(404);
    expect((await post(site.id, "nope", FIXTURE)).status).toBe(404);
  });

  it("filters the action list and rejects unknown statuses", async () => {
    const { site, job } = await newAudit();
    await post(site.id, job.audit.id, { audit: FIXTURE.audit, actionItems: FIXTURE.actionItems });
    const schema = await (await actions.GET(req(`/api/sites/${site.id}/actions?category=schema`), actx(site.id))).json();
    expect(schema.items.length).toBeGreaterThan(0);
    expect(schema.items.every((i: { category: string }) => i.category === "schema")).toBe(true);
    expect((await actions.GET(req(`/api/sites/${site.id}/actions?status=bogus`), actx(site.id))).status).toBe(400);
    expect((await actions.GET(req(`/api/sites/missing/actions`), actx("missing"))).status).toBe(404);
  });
});

describe("geo-audit CLI runner", () => {
  it("runs GEO_AUDIT_BIN and ingests its output", async () => {
    // Fake geo-audit: copies the fixture split into --db-records / --crawl-records outputs.
    const dir = mkdtempSync(path.join(tmpdir(), "fake-geo-audit-"));
    const { crawl, ...rows } = FIXTURE;
    writeFileSync(path.join(dir, "rows.json"), JSON.stringify(rows));
    writeFileSync(path.join(dir, "crawl.json"), JSON.stringify(crawl));
    const bin = path.join(dir, "geo-audit");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2);
const out = (f) => a[a.indexOf(f) + 1];
fs.writeFileSync(out("-o"), "{}");
fs.copyFileSync(${JSON.stringify(path.join(dir, "rows.json"))}, out("--db-records"));
fs.copyFileSync(${JSON.stringify(path.join(dir, "crawl.json"))}, out("--crawl-records"));
fs.writeFileSync(${JSON.stringify(path.join(dir, "args.json"))}, JSON.stringify(a));
`,
    );
    chmodSync(bin, 0o755);
    process.env.GEO_AUDIT_BIN = bin;
    registerAuditRunner(defaultAuditRunner()); // what the module does at startup when the env var is set
    expect(getAuditRunner()).not.toBeNull();

    const { site, job } = await newAudit();
    await executeAudit(job);
    const audit = await prisma.geoAudit.findUniqueOrThrow({ where: { id: job.audit.id } });
    expect(audit).toMatchObject({ status: "completed", geoScore: FIXTURE.audit.geoScore, error: null });
    expect(await prisma.actionItem.count({ where: { siteId: site.id } })).toBe(FIXTURE.actionItems.length);
    expect(await prisma.crawledPage.count({ where: { siteId: site.id } })).toBe(FIXTURE.crawl.crawledPages.length);
    const args = JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8"));
    expect(args[0]).toBe("https://shop.example.com");
    expect(args).toEqual(expect.arrayContaining(["--max-pages", String(job.crawlSession.maxPages)]));
    // No locale on the job (programmatic audit) -> the engine's default language, English.
    expect(args.slice(args.indexOf("--lang"))).toEqual(["--lang", "en"]);
  });

  describe("--lang", () => {
    // Fake geo-audit that only records its arguments and writes minimal valid output.
    function fakeCli() {
      const dir = mkdtempSync(path.join(tmpdir(), "fake-geo-audit-"));
      const { crawl, ...rows } = FIXTURE;
      writeFileSync(path.join(dir, "rows.json"), JSON.stringify({ ...rows, actionItems: [] }));
      writeFileSync(path.join(dir, "crawl.json"), JSON.stringify({ ...crawl, crawledPages: [], graphEntities: [], graphRelations: [] }));
      const bin = path.join(dir, "geo-audit");
      writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2);
const out = (f) => a[a.indexOf(f) + 1];
fs.writeFileSync(out("-o"), "{}");
fs.copyFileSync(${JSON.stringify(path.join(dir, "rows.json"))}, out("--db-records"));
fs.copyFileSync(${JSON.stringify(path.join(dir, "crawl.json"))}, out("--crawl-records"));
fs.writeFileSync(${JSON.stringify(path.join(dir, "args.json"))}, JSON.stringify(a));
`);
      chmodSync(bin, 0o755);
      return { bin, args: () => JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8")) as string[] };
    }

    it("passes the locale of the request that started the audit to the scoring engine", async () => {
      const cli = fakeCli();
      process.env.GEO_AUDIT_BIN = cli.bin;
      registerAuditRunner(defaultAuditRunner());
      const site = await prisma.site.create({ data: { url: "https://shop.example.com", title: "Shop" } });
      const job = await startAudit(site.id, { trigger: "manual" }, undefined, "tr");
      expect(job.locale).toBe("tr");
      await executeAudit(job);
      expect(cli.args().slice(-2)).toEqual(["--lang", "tr"]);
      expect(cli.args().filter((a) => a === "--lang")).toHaveLength(1);
    });

    it("does not add --lang when GEO_AUDIT_ARGS already sets one", async () => {
      const cli = fakeCli();
      process.env.GEO_AUDIT_BIN = cli.bin;
      process.env.GEO_AUDIT_ARGS = "--rps 2 --lang=en";
      try {
        registerAuditRunner(defaultAuditRunner());
        const site = await prisma.site.create({ data: { url: "https://shop.example.com", title: "Shop" } });
        await executeAudit(await startAudit(site.id, { trigger: "manual" }, undefined, "tr"));
        expect(cli.args()).toEqual(expect.arrayContaining(["--rps", "2", "--lang=en"]));
        expect(cli.args()).not.toContain("tr");
        expect(cli.args().filter((a) => a.startsWith("--lang"))).toEqual(["--lang=en"]);
      } finally {
        delete process.env.GEO_AUDIT_ARGS;
      }
    });

    it("detects --lang flags in either form", () => {
      expect(hasLangFlag(["--rps", "2"])).toBe(false);
      expect(hasLangFlag(["--lang", "tr"])).toBe(true);
      expect(hasLangFlag(["--lang=tr"])).toBe(true);
      expect(hasLangFlag(["--language", "tr"])).toBe(false);
    });
  });

  it("marks the audit failed when the CLI crashes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-geo-audit-"));
    const bin = path.join(dir, "geo-audit");
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(3);\n");
    chmodSync(bin, 0o755);
    process.env.GEO_AUDIT_BIN = bin;
    registerAuditRunner(defaultAuditRunner());
    const { job } = await newAudit();
    await executeAudit(job);
    const audit = await prisma.geoAudit.findUniqueOrThrow({ where: { id: job.audit.id } });
    expect(audit.status).toBe("failed");
  });
});
