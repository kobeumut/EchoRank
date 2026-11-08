import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import * as audit from "@/app/api/sites/[id]/audit/route";
import * as graph from "@/app/api/sites/[id]/graph/route";
import * as reports from "@/app/api/sites/[id]/reports/route";
import * as schedules from "@/app/api/sites/[id]/reports/schedules/route";
import { executeAudit, registerAuditRunner, startAudit } from "@/lib/services/audit";
import { computeNextRun } from "@/lib/services/reports";
import { ctx, req, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());
afterEach(() => vi.unstubAllEnvs());

const newSite = (url = "https://a.example.com") =>
  prisma.site.create({ data: { url, title: "A", settings: { maxPages: 42 } } });

describe("/api/sites/[id]/audit", () => {
  it("queues an audit with crawl session and blocks concurrent runs", async () => {
    const s = await newSite();
    const res = await audit.POST(req(`/api/sites/${s.id}/audit`, { method: "POST" }), ctx(s.id));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.execution).toBe("queued");
    expect(body.crawlSession).toMatchObject({ status: "queued", maxPages: 42, trigger: "api" });
    expect(body.audit).toMatchObject({ status: "pending", crawlSessionId: body.crawlSession.id });

    const again = await audit.POST(req(`/api/sites/${s.id}/audit`, { method: "POST", body: {} }), ctx(s.id));
    expect(again.status).toBe(409);

    const list = await (await audit.GET(req(`/api/sites/${s.id}/audit`), ctx(s.id))).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].crawlSession.status).toBe("queued");
  });

  it("returns 404 for unknown site", async () => {
    expect((await audit.POST(req("/api/sites/x/audit", { method: "POST" }), ctx("x"))).status).toBe(404);
  });

  it("marks job failed when the runner throws", async () => {
    const s = await newSite();
    const job = await startAudit(s.id, { trigger: "manual" });
    registerAuditRunner(async () => {
      throw new Error("boom");
    });
    await executeAudit(job);
    registerAuditRunner(null);
    const cs = await prisma.crawlSession.findUniqueOrThrow({ where: { id: job.crawlSession.id } });
    const a = await prisma.geoAudit.findUniqueOrThrow({ where: { id: job.audit.id } });
    expect(cs).toMatchObject({ status: "failed", error: "boom" });
    expect(a).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("/api/sites/[id]/graph", () => {
  it("returns nodes, edges, degrees and orphan stats", async () => {
    const s = await newSite();
    const e = (key: string, entityType: string, url?: string) =>
      prisma.graphEntity.create({ data: { siteId: s.id, key, entityType, name: key, url } });
    const home = await e("home", "Page", "https://a.example.com/");
    const cat = await e("cat", "Category");
    const prod = await e("prod", "Product");
    await e("orphan", "Page", "https://a.example.com/old");
    await prisma.graphRelation.createMany({
      data: [
        { siteId: s.id, sourceId: home.id, targetId: cat.id, relationType: "links_to" },
        { siteId: s.id, sourceId: cat.id, targetId: prod.id, relationType: "contains_product" },
      ],
    });

    const all = await (await graph.GET(req(`/api/sites/${s.id}/graph`), ctx(s.id))).json();
    expect(all.nodes).toHaveLength(4);
    expect(all.edges).toHaveLength(2);
    expect(all.stats).toMatchObject({ totalEntities: 4, orphanPages: 1, truncated: false });
    expect(all.stats.byType).toEqual({ Page: 2, Category: 1, Product: 1 });
    expect(all.nodes.find((n: { key: string }) => n.key === "cat")).toMatchObject({ inDegree: 1, outDegree: 1 });

    const filtered = await (await graph.GET(req(`/api/sites/${s.id}/graph?types=Category,Product`), ctx(s.id))).json();
    expect(filtered.nodes).toHaveLength(2);
    expect(filtered.edges).toHaveLength(1);

    const bad = await graph.GET(req(`/api/sites/${s.id}/graph?types=Spaceship`), ctx(s.id));
    expect(bad.status).toBe(400);
  });
});

describe("/api/sites/[id]/reports", () => {
  it("aggregates scores, deltas, visibility and actions", async () => {
    const s = await newSite();
    const day = 86_400_000;
    await prisma.geoAudit.create({ data: { siteId: s.id, status: "completed", geoScore: 40, seoScore: 60, eeatScore: 30, createdAt: new Date(Date.now() - 2 * day) } });
    await prisma.geoAudit.create({ data: { siteId: s.id, status: "completed", geoScore: 55, seoScore: 58, eeatScore: 45 } });
    await prisma.geoAudit.create({ data: { siteId: s.id, status: "failed" } });
    await prisma.llmVisibilityRecord.createMany({
      data: [
        { siteId: s.id, model: "chatgpt", query: "q", citationStatus: "cited", position: 1 },
        { siteId: s.id, model: "chatgpt", query: "q2", citationStatus: "none" },
        { siteId: s.id, model: "gemini", query: "q", citationStatus: "mentioned" },
        { siteId: s.id, model: "claude", query: "q", citationStatus: "none" },
      ],
    });
    await prisma.actionItem.createMany({
      data: [
        { siteId: s.id, title: "a", category: "schema", impact: "high" },
        { siteId: s.id, title: "b", category: "crawler", impact: "high" },
        { siteId: s.id, title: "c", category: "content", impact: "low", status: "resolved" },
      ],
    });

    const r = await (await reports.GET(req(`/api/sites/${s.id}/reports?days=7`), ctx(s.id))).json();
    expect(r.scores).toMatchObject({ geo: 55, seo: 58, eeat: 45, delta: { geo: 15, seo: -2, eeat: 15 } });
    expect(r.history).toHaveLength(2);
    expect(r.visibility.totalChecks).toBe(4);
    expect(r.visibility.visibilityRate).toBe(50);
    expect(r.visibility.perModel.chatgpt).toMatchObject({ cited: 1, none: 1, total: 2, visibilityRate: 50 });
    expect(r.actions).toMatchObject({ open: 2, byImpact: { high: 2 }, byStatus: { open: 2, resolved: 1 } });

    expect((await reports.GET(req(`/api/sites/${s.id}/reports?days=0`), ctx(s.id))).status).toBe(400);
  });

  it("returns empty report for a fresh site", async () => {
    const s = await newSite();
    const r = await (await reports.GET(req(`/api/sites/${s.id}/reports`), ctx(s.id))).json();
    expect(r.scores).toBeNull();
    expect(r.visibility).toMatchObject({ totalChecks: 0, visibilityRate: 0 });
  });

  it("creates and lists schedules", async () => {
    vi.stubEnv("API_TOKEN", "reports-test");
    const s = await newSite();
    const created = await schedules.POST(
      req(`/api/sites/${s.id}/reports/schedules`, { method: "POST", token: "reports-test", body: { frequency: "weekly", recipients: ["a@b.co"] } }),
      ctx(s.id),
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(new Date(body.nextRunAt).getUTCDay()).toBe(1);
    const bad = await schedules.POST(
      req(`/api/sites/${s.id}/reports/schedules`, { method: "POST", token: "reports-test", body: { frequency: "hourly", recipients: ["nope"] } }),
      ctx(s.id),
    );
    expect(bad.status).toBe(400);
    const list = await (await schedules.GET(req(`/api/sites/${s.id}/reports/schedules`, { token: "reports-test" }), ctx(s.id))).json();
    expect(list.items).toHaveLength(1);
  });
});

describe("computeNextRun", () => {
  it("schedules daily at next 06:00 UTC and weekly on Monday", () => {
    const from = new Date("2026-11-07T10:00:00Z"); // Saturday
    expect(computeNextRun("daily", from).toISOString()).toBe("2026-11-08T06:00:00.000Z");
    expect(computeNextRun("weekly", from).toISOString()).toBe("2026-11-09T06:00:00.000Z");
    expect(computeNextRun("daily", new Date("2026-11-07T05:00:00Z")).toISOString()).toBe("2026-11-07T06:00:00.000Z");
  });
});
