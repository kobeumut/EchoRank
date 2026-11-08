import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import * as jobsRoute from "@/app/api/jobs/route";
import * as runRoute from "@/app/api/jobs/run/route";
import * as schedules from "@/app/api/sites/[id]/reports/schedules/route";
import * as scheduleItem from "@/app/api/sites/[id]/reports/schedules/[scheduleId]/route";
import * as sendRoute from "@/app/api/sites/[id]/reports/schedules/[scheduleId]/send/route";
import * as summary from "@/app/api/sites/[id]/reports/summary/route";
import * as deliveries from "@/app/api/sites/[id]/reports/deliveries/route";
import * as trends from "@/app/api/sites/[id]/trends/route";
import { captureSnapshot, detectAnomalies, type SnapshotMetrics } from "@/lib/monitoring/trends";
import { setEmailTransport, type EmailMessage } from "@/lib/notify/email";
import { buildDiscordPayload, buildSlackPayload, detectWebhookType } from "@/lib/notify/webhook";
import { buildPeriodicReport, visibilityHeadline } from "@/lib/reports/builder";
import { processDueReports, sendScheduledReport } from "@/lib/reports/dispatch";
import { renderReportHtml } from "@/lib/reports/html";
import { renderReportPdf } from "@/lib/reports/pdf";
import { normalizePdfText, wrapText } from "@/lib/reports/pdf-writer";
import { resolveSchedules } from "@/lib/scheduler/cron";
import { JobBusyError, runJob } from "@/lib/scheduler/jobs";
import { req, resetDb } from "./helpers";

const DAY = 86_400_000;
const NOW = new Date("2026-11-09T06:00:00Z"); // Monday report slot
const at = (daysAgo: number, hours = 0) => new Date(NOW.getTime() - daysAgo * DAY + hours * 3_600_000);
const sctx = (id: string, scheduleId: string) => ({ params: Promise.resolve({ id, scheduleId }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

type Sent = EmailMessage & { from: string };
let mails: Sent[] = [];
type Call = { url: string; body: string; headers: Record<string, string> };
let calls: Call[] = [];
let failUrls = new Set<string>();

beforeEach(async () => {
  await resetDb();
  await prisma.jobRun.deleteMany();
  await prisma.jobLock.deleteMany();
  mails = [];
  calls = [];
  failUrls = new Set();
  setEmailTransport({
    name: "capture",
    async send(m) {
      mails.push(m);
      return { messageId: `m-${mails.length}` };
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, body: String(init.body ?? ""), headers: (init.headers ?? {}) as Record<string, string> });
      return new Response(failUrls.has(url) ? "boom" : "ok", { status: failUrls.has(url) ? 500 : 200 });
    }),
  );
  process.env.ALLOW_PRIVATE_NETWORK_TARGETS = "true";
});

afterEach(() => {
  setEmailTransport(null);
  vi.unstubAllGlobals();
  delete process.env.ALLOW_PRIVATE_NETWORK_TARGETS;
  delete process.env.API_TOKEN;
  delete process.env.APP_BASE_URL;
});
afterAll(() => prisma.$disconnect());

const SLACK = "https://hooks.slack.com/services/T000/B000/XXXX";
const DISCORD = "https://discord.com/api/webhooks/123/abc";
const GENERIC = "https://hooks.example.com/aiv";

async function seedSite() {
  const site = await prisma.site.create({
    data: { url: "https://shop.example.com", title: "Örnek Mağaza", integrations: { webhookSecret: "s3cret" } },
  });
  const id = site.id;
  // Previous week: lower scores, 2/8 visible. This week: higher scores, 5/8 visible.
  await prisma.geoAudit.create({ data: { siteId: id, status: "completed", geoScore: 52, seoScore: 70, eeatScore: 40, createdAt: at(9) } });
  await prisma.geoAudit.create({ data: { siteId: id, status: "completed", geoScore: 61, seoScore: 72, eeatScore: 48, createdAt: at(2) } });
  const vis = (daysAgo: number, model: string, status: string, competitors: string[] = []) => ({
    siteId: id, model, query: `q-${model}-${daysAgo}-${status}-${Math.random()}`, citationStatus: status, checkedAt: at(daysAgo),
    responseMeta: { competitorDomains: competitors },
  });
  await prisma.llmVisibilityRecord.createMany({
    data: [
      ...["cited", "none", "none", "none"].map((s) => vis(10, "chatgpt", s, ["rakip.com"])),
      ...["mentioned", "none", "none", "none"].map((s) => vis(10, "gemini", s)),
      ...["cited", "cited", "none", "mentioned"].map((s) => vis(3, "chatgpt", s, ["rakip.com"])),
      ...["cited", "cited", "mentioned", "none"].map((s) => vis(3, "gemini", s, ["rakip.com"])),
    ],
  });
  await prisma.actionItem.createMany({
    data: [
      { siteId: id, title: "FAQPage şeması ekleyin", category: "schema", impact: "high", priority: 9, details: { expected_gain: 6 } },
      { siteId: id, title: "GPTBot erişimini açın", category: "crawler", impact: "high", priority: 12, targetUrl: "https://shop.example.com/robots.txt" },
      { siteId: id, title: "Yazar biyografisi", category: "authority", impact: "medium", priority: 3 },
      { siteId: id, title: "Düşük öncelik", category: "content", impact: "low" },
      { siteId: id, title: "Canonical düzeltildi", category: "technical", impact: "high", status: "resolved", resolvedAt: at(1) },
      { siteId: id, title: "Eski çözüm", category: "technical", impact: "low", status: "resolved", resolvedAt: at(20) },
    ],
  });
  return site;
}

const metrics = (m: Partial<SnapshotMetrics>): SnapshotMetrics => ({
  geoScore: 60, seoScore: 70, eeatScore: 50, visibilityRate: 50, citationRate: 30, totalChecks: 10, competitors: [], ...m,
});

describe("detectAnomalies", () => {
  it("flags score drops, visibility collapse and competitor surges", () => {
    const history = [metrics({ citationRate: 40, competitors: [{ domain: "rakip.com", count: 2, share: 20 }] }), metrics({}), metrics({})];
    const out = detectAnomalies(
      metrics({ geoScore: 42, seoScore: 66, visibilityRate: 20, citationRate: 24, competitors: [{ domain: "rakip.com", count: 6, share: 60 }] }),
      history,
    );
    const byMetric = Object.fromEntries(out.map((a) => [a.metric, a]));
    expect(byMetric.geoScore).toMatchObject({ type: "score_drop", severity: "high", previous: 60, current: 42, change: -18 });
    expect(byMetric.seoScore).toBeUndefined(); // -4 with a flat baseline: sd = 0 -> no z-score flag
    expect(byMetric.visibilityRate).toMatchObject({ type: "visibility_drop", severity: "high", change: -30 });
    expect(byMetric.citationRate).toMatchObject({ type: "citation_drop", severity: "medium" });
    expect(byMetric["competitor:rakip.com"]).toMatchObject({ type: "competitor_surge", severity: "high", change: 40 });
    expect(out[0].severity).toBe("high");
  });

  it("uses a z-score against a noisy baseline and ignores small samples / stable data", () => {
    const baseline = [70, 72, 71, 69, 70].map((geoScore) => metrics({ geoScore }));
    const z = detectAnomalies(metrics({ geoScore: 64 }), baseline);
    expect(z.map((a) => a.metric)).toEqual(["geoScore"]);
    expect(detectAnomalies(metrics({}), [metrics({})])).toEqual([]);
    expect(detectAnomalies(metrics({ visibilityRate: 0, totalChecks: 2 }), [metrics({})])).toEqual([]);
    expect(detectAnomalies(metrics({ geoScore: 30 }), [])).toEqual([]);
  });
});

describe("trend snapshots", () => {
  it("captures snapshots, compares like-for-like and exposes the series via the API", async () => {
    const site = await seedSite();
    const first = await captureSnapshot(site.id, { kind: "weekly", now: at(7) });
    expect(first).toMatchObject({ geoScore: 52, visibilityRate: 25, citationRate: 13, totalChecks: 8, citedCount: 1, windowDays: 7 });
    expect(first.anomalies).toEqual([]);

    // Competitor share jumps from 50% to 100%, while visibility improves.
    const second = await captureSnapshot(site.id, { kind: "weekly", now: NOW });
    expect(second).toMatchObject({ geoScore: 61, visibilityRate: 75, citationRate: 50, openActions: 4, criticalActions: 2 });
    expect(second.anomalies).toEqual([expect.objectContaining({ type: "competitor_surge", metric: "competitor:rakip.com", previous: 50, current: 100 })]);

    // A daily snapshot is not compared with weekly history.
    const daily = await captureSnapshot(site.id, { kind: "daily", now: NOW });
    expect(daily.anomalies).toEqual([]);

    const res = await trends.GET(req(`/api/sites/${site.id}/trends?days=30&kind=weekly`), ctx(site.id));
    const body = await res.json();
    expect(body.points).toHaveLength(2);
    expect(body.change).toMatchObject({ geoScore: 9, visibilityRate: 50 });
    expect(body.anomalies[0]).toMatchObject({ type: "competitor_surge" });

    const manual = await trends.POST(req(`/api/sites/${site.id}/trends`, { method: "POST" }), ctx(site.id));
    expect(manual.status).toBe(201);
    expect((await trends.GET(req(`/api/sites/${site.id}/trends?days=0`), ctx(site.id))).status).toBe(400);
  });
});

describe("periodic report", () => {
  it("builds the weekly executive summary with visibility change and action lists", async () => {
    const site = await seedSite();
    await captureSnapshot(site.id, { kind: "weekly", now: at(7) });
    await captureSnapshot(site.id, { kind: "weekly", now: NOW });
    const r = await buildPeriodicReport(site.id, "weekly", NOW);

    expect(r.periodKey).toBe("weekly:2026-11-09");
    expect(r.headline).toMatchObject({ direction: "up", changePct: 200, changePoints: 50 });
    expect(r.headline.text).toBe("Bu hafta yapay zeka aramalarındaki görünürlüğünüz %200 arttı (%25 → %75).");
    expect(r.scores.geo).toEqual({ current: 61, previous: 52, delta: 9 });
    expect(r.scores.newAuditInPeriod).toBe(true);
    expect(r.visibility.current).toMatchObject({ totalChecks: 8, cited: 4, mentioned: 2, visibilityRate: 75 });
    expect(r.visibility.perModel.map((m) => [m.model, m.current?.visibilityRate, m.previousVisibilityRate])).toEqual([
      ["chatgpt", 75, 25],
      ["gemini", 75, 25],
    ]);
    expect(r.visibility.competitors[0]).toEqual({ domain: "rakip.com", count: 8, share: 100 });
    expect(r.actions.resolved.map((a) => a.title)).toEqual(["Canonical düzeltildi"]);
    expect(r.actions.pendingCritical.map((a) => a.title)).toEqual(["GPTBot erişimini açın", "FAQPage şeması ekleyin", "Yazar biyografisi"]);
    expect(r.actions.pendingCritical[1].expectedGain).toBe(6);
    expect(r.actions).toMatchObject({ resolvedCount: 1, pendingCount: 4, pendingByImpact: { high: 2, medium: 1, low: 1 } });
    expect(r.anomalies.map((a) => a.type)).toEqual(["competitor_surge"]);
    expect(r.trend).toHaveLength(2);
    expect(r.executiveSummary[0]).toBe(r.headline.text);
    expect(r.executiveSummary.join("\n")).toContain("GEO 61 (+9)");
  });

  it("phrases headline edge cases", () => {
    expect(visibilityHeadline("weekly", 40, 50).text).toBe("Bu hafta yapay zeka aramalarındaki görünürlüğünüz %20 azaldı (%50 → %40).");
    expect(visibilityHeadline("daily", 30, 30).direction).toBe("flat");
    expect(visibilityHeadline("weekly", 10, 0).text).toContain("%0 → %10 yükseldi");
    expect(visibilityHeadline("weekly", null, 10).direction).toBe("none");
    expect(visibilityHeadline("weekly", 33, 30).changePct).toBe(10);
  });

  it("renders a complete HTML e-mail and a valid PDF with Turkish text", async () => {
    const site = await seedSite();
    await captureSnapshot(site.id, { kind: "weekly", now: at(7) });
    await captureSnapshot(site.id, { kind: "weekly", now: NOW });
    const r = await buildPeriodicReport(site.id, "weekly", NOW);

    const html = renderReportHtml(r, { reportUrl: "https://app.example.com/r", pdfUrl: "https://app.example.com/r.pdf" });
    for (const s of ["Yönetici Özeti", "Bekleyen kritik aksiyonlar", "Çözülen aksiyonlar", "Model bazında", "Skor trendi", "Anormallikler", "%200 arttı", "Örnek Mağaza", "PDF indir"]) {
      expect(html).toContain(s);
    }
    expect(html).not.toMatch(/<script|<svg/i);

    const pdf = renderReportPdf(r);
    const raw = pdf.toString("latin1");
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    const startxref = Number(raw.match(/startxref\n(\d+)/)![1]);
    expect(raw.slice(startxref, startxref + 4)).toBe("xref");

    let pdftotext = true;
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    } catch {
      pdftotext = false;
    }
    if (pdftotext) {
      const dir = mkdtempSync(path.join(tmpdir(), "aiv-pdf-"));
      try {
        const file = path.join(dir, "r.pdf");
        writeFileSync(file, pdf);
        const text = execFileSync("pdftotext", ["-layout", file, "-"]).toString("utf8");
        for (const s of ["Yönetici Özeti", "görünürlüğünüz %200 arttı", "GPTBot erişimini açın", "Çözülen aksiyonlar", "Örnek Mağaza", "E-E-A-T"]) {
          expect(text).toContain(s);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("serves json, html, text and pdf from the summary endpoint", async () => {
    const site = await seedSite();
    const json = await (await summary.GET(req(`/api/sites/${site.id}/reports/summary`), ctx(site.id))).json();
    expect(json).toMatchObject({ frequency: "weekly", site: { id: site.id } });
    const html = await summary.GET(req(`/api/sites/${site.id}/reports/summary?format=html&frequency=daily`), ctx(site.id));
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("Günlük");
    const pdf = await summary.GET(req(`/api/sites/${site.id}/reports/summary?format=pdf&download=1`), ctx(site.id));
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toMatch(/^attachment; filename="ai-gorunurluk-haftalik-shop\.example\.com-\d{4}-\d{2}-\d{2}\.pdf"$/);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    const text = await summary.GET(req(`/api/sites/${site.id}/reports/summary?format=text`), ctx(site.id));
    expect(await text.text()).toContain("YÖNETİCİ ÖZETİ");
    expect((await summary.GET(req(`/api/sites/${site.id}/reports/summary?format=docx`), ctx(site.id))).status).toBe(400);
    expect((await summary.GET(req(`/api/sites/nope/reports/summary`), ctx("nope"))).status).toBe(404);
  });
});

describe("pdf writer", () => {
  it("keeps Turkish glyphs, transliterates arrows and wraps long words", () => {
    expect(normalizePdfText("ğüşıöç İĞÜŞÖÇ ▲ → 🎉")).toBe("ğüşıöç İĞÜŞÖÇ + -> ");
    const lines = wrapText("kısa " + "x".repeat(200), 10, 100);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toBe("kısa");
  });
});

describe("schedules API", () => {
  it("creates with webhooks, requires a channel, updates and deletes", async () => {
    const site = await seedSite();
    const noChannel = await schedules.POST(req(`/api/sites/${site.id}/reports/schedules`, { method: "POST", body: { frequency: "weekly" } }), ctx(site.id));
    expect(noChannel.status).toBe(400);
    const res = await schedules.POST(
      req(`/api/sites/${site.id}/reports/schedules`, { method: "POST", body: { frequency: "daily", webhooks: [{ url: SLACK }] } }),
      ctx(site.id),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ recipients: [], webhooks: [{ url: SLACK }], alerts: true, enabled: true });

    const off = await scheduleItem.PATCH(req("/x", { method: "PATCH", body: { enabled: false } }), sctx(site.id, created.id));
    expect(await off.json()).toMatchObject({ enabled: false, nextRunAt: null });
    const weekly = await scheduleItem.PATCH(req("/x", { method: "PATCH", body: { enabled: true, frequency: "weekly" } }), sctx(site.id, created.id));
    expect(new Date((await weekly.json()).nextRunAt).getUTCDay()).toBe(1);
    const empty = await scheduleItem.PATCH(req("/x", { method: "PATCH", body: { webhooks: [] } }), sctx(site.id, created.id));
    expect(empty.status).toBe(400);
    expect((await scheduleItem.GET(req("/x"), sctx("other", created.id))).status).toBe(404);
    expect((await scheduleItem.DELETE(req("/x", { method: "DELETE" }), sctx(site.id, created.id))).status).toBe(204);
    expect(await prisma.scheduledReport.count()).toBe(0);
  });
});

describe("report delivery", () => {
  async function schedule(siteId: string, extra: Record<string, unknown> = {}) {
    return prisma.scheduledReport.create({
      data: {
        siteId,
        frequency: "weekly",
        recipients: ["ceo@example.com", "seo@example.com"],
        webhooks: [{ url: SLACK }, { url: DISCORD }, { url: GENERIC }],
        nextRunAt: at(0, -1),
        ...extra,
      },
    });
  }

  it("sends e-mail with PDF and Slack / Discord / signed generic webhooks, then dedupes per period", async () => {
    process.env.APP_BASE_URL = "https://app.example.com/";
    const site = await seedSite();
    const s = await schedule(site.id);
    const res = await sendScheduledReport(s.id, { now: NOW });
    expect(res).toMatchObject({ status: "sent", periodKey: "weekly:2026-11-09" });
    expect(res.deliveries.map((d) => [d.channel, d.status])).toEqual([
      ["email", "sent"], ["email", "sent"], ["webhook", "sent"], ["webhook", "sent"], ["webhook", "sent"],
    ]);

    expect(mails).toHaveLength(2);
    expect(mails[0].to).toBe("ceo@example.com");
    expect(mails[0].subject).toBe("Haftalık AI görünürlük raporu — Örnek Mağaza ▲ %200");
    expect(mails[0].html).toContain(`https://app.example.com/api/sites/${site.id}/reports/summary?frequency=weekly&amp;format=html`);
    expect(mails[0].text).toContain("YÖNETİCİ ÖZETİ");
    expect(mails[0].attachments?.[0]).toMatchObject({ filename: "ai-gorunurluk-haftalik-shop.example.com-2026-11-09.pdf", contentType: "application/pdf" });
    expect(mails[0].attachments?.[0].content.subarray(0, 5).toString()).toBe("%PDF-");

    const slack = JSON.parse(calls.find((c) => c.url === SLACK)!.body);
    expect(slack.text).toContain("%200 arttı");
    expect(slack.blocks[0]).toMatchObject({ type: "header" });
    const discord = JSON.parse(calls.find((c) => c.url === DISCORD)!.body);
    expect(discord.embeds[0]).toMatchObject({ color: 0x047857 });
    expect(discord.embeds[0].fields.find((f: { name: string }) => f.name === "GEO").value).toBe("61 (+9)");
    const generic = calls.find((c) => c.url === GENERIC)!;
    expect(JSON.parse(generic.body)).toMatchObject({ event: "report.weekly", report: { periodKey: "weekly:2026-11-09" } });
    const ts = generic.headers["x-aiv-timestamp"];
    expect(generic.headers["x-aiv-signature"]).toBe(`sha256=${createHmac("sha256", "s3cret").update(`${ts}.${generic.body}`).digest("hex")}`);
    expect(calls.find((c) => c.url === SLACK)!.headers["x-aiv-signature"]).toBeUndefined();

    // Same period again: everything already delivered.
    const again = await sendScheduledReport(s.id, { now: NOW });
    expect(again.status).toBe("skipped");
    expect(mails).toHaveLength(2);
    const forced = await sendScheduledReport(s.id, { now: NOW, force: true });
    expect(forced.status).toBe("sent");
    expect(mails).toHaveLength(4);

    const log = await (await deliveries.GET(req(`/api/sites/${site.id}/reports/deliveries`), ctx(site.id))).json();
    expect(log.items).toHaveLength(10);
    expect(await prisma.scheduledReport.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ lastStatus: "sent", lastError: null });
  });

  it("marks partial failures and retries only the failed target", async () => {
    const site = await seedSite();
    const s = await schedule(site.id);
    failUrls.add(DISCORD);
    const first = await sendScheduledReport(s.id, { now: NOW });
    expect(first.status).toBe("partial");
    expect(await prisma.scheduledReport.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ lastStatus: "partial", lastError: "discord: boom" });
    failUrls.clear();
    calls = [];
    const retry = await sendScheduledReport(s.id, { now: NOW });
    expect(retry.status).toBe("sent");
    expect(calls.map((c) => c.url)).toEqual([DISCORD]);
    expect(retry.deliveries.filter((d) => d.status === "skipped")).toHaveLength(4);
  });

  it("simulates every channel on dry run without network or e-mail", async () => {
    const site = await seedSite();
    const s = await schedule(site.id);
    const res = await sendRoute.POST(req("/x", { method: "POST", body: { dryRun: true } }), sctx(site.id, s.id));
    const body = await res.json();
    expect(body).toMatchObject({ status: "simulated", dryRun: true });
    expect(body.deliveries.every((d: { status: string }) => d.status === "simulated")).toBe(true);
    expect(mails).toHaveLength(0);
    expect(calls).toHaveLength(0);
    // Simulated deliveries never block the real send.
    expect((await sendScheduledReport(s.id, { now: NOW })).status).toBe("sent");
  });

  it("processes due schedules once and moves nextRunAt forward", async () => {
    const site = await seedSite();
    const due = await schedule(site.id, { webhooks: [] });
    await schedule(site.id, { nextRunAt: new Date(NOW.getTime() + DAY) });
    await schedule(site.id, { enabled: false });

    const dry = await processDueReports({ now: NOW, dryRun: true });
    expect(dry.due).toBe(1);
    expect((await prisma.scheduledReport.findUniqueOrThrow({ where: { id: due.id } })).nextRunAt).toEqual(at(0, -1));

    const real = await processDueReports({ now: NOW });
    expect(real.due).toBe(1);
    expect(real.results[0]).toMatchObject({ scheduleId: due.id, status: "sent" });
    const after = await prisma.scheduledReport.findUniqueOrThrow({ where: { id: due.id } });
    expect(after.nextRunAt!.toISOString()).toBe("2026-11-16T06:00:00.000Z");
    expect(after.lastRunAt).toEqual(NOW);
    expect((await processDueReports({ now: NOW })).due).toBe(0);
  });

  it("detects the webhook flavour from the URL", () => {
    expect(detectWebhookType({ url: SLACK })).toBe("slack");
    expect(detectWebhookType({ url: DISCORD })).toBe("discord");
    expect(detectWebhookType({ url: "https://discord.com/channels/1" })).toBe("generic");
    expect(detectWebhookType({ url: GENERIC, type: "slack" })).toBe("slack");
  });

  it("blocks private webhook targets", async () => {
    delete process.env.ALLOW_PRIVATE_NETWORK_TARGETS;
    const site = await seedSite();
    const s = await schedule(site.id, { recipients: [], webhooks: [{ url: "http://127.0.0.1:8080/hook" }] });
    const res = await sendScheduledReport(s.id, { now: NOW });
    expect(res.status).toBe("failed");
    expect(res.deliveries[0].detail).toContain("private network");
    expect(calls).toHaveLength(0);
  });
});

describe("scheduled jobs", () => {
  it("runs the reports job, logs it and lists runs", async () => {
    const site = await seedSite();
    await prisma.scheduledReport.create({ data: { siteId: site.id, frequency: "daily", recipients: ["a@example.com"], nextRunAt: at(1) } });
    const run = await runJob("reports", { trigger: "manual" });
    expect(run).toMatchObject({ job: "reports", status: "completed", trigger: "manual", dryRun: false });
    expect(run.summary).toMatchObject({ due: 1, results: [{ status: "sent" }] });
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain("Günlük AI görünürlük raporu");
    expect(await prisma.jobLock.count()).toBe(0);

    const list = await (await jobsRoute.GET(req("/api/jobs?job=reports"), undefined)).json();
    expect(list.items).toHaveLength(1);
    expect(list.schedules).toMatchObject({ daily: "0 5 * * *", weekly: "0 2 * * 1" });
  });

  it("refuses to run the same job twice at once and takes over expired leases", async () => {
    await prisma.jobLock.create({ data: { job: "snapshot", runId: "other", expiresAt: new Date(Date.now() + 60_000) } });
    await expect(runJob("snapshot")).rejects.toBeInstanceOf(JobBusyError);
    expect((await prisma.jobRun.findFirstOrThrow({ where: { job: "snapshot" } })).status).toBe("skipped");

    await prisma.jobLock.update({ where: { job: "snapshot" }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await runJob("snapshot")).status).toBe("completed");
    expect(await prisma.jobLock.count()).toBe(0);
  });

  it("daily job: skips unconfigured steps, snapshots and pushes anomaly alerts once", async () => {
    const site = await seedSite();
    await prisma.scheduledReport.create({ data: { siteId: site.id, frequency: "weekly", recipients: ["ops@example.com"], webhooks: [{ url: SLACK }], nextRunAt: at(-3) } });
    // Yesterday's daily snapshot: well visible. Today: only "none" answers in the last 24h.
    await prisma.metricSnapshot.create({
      data: { siteId: site.id, kind: "daily", windowDays: 1, geoScore: 61, visibilityRate: 80, citationRate: 60, totalChecks: 10, capturedAt: at(1) },
    });
    await prisma.llmVisibilityRecord.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({ siteId: site.id, model: "chatgpt", query: `d${i}`, citationStatus: "none", checkedAt: at(0, -2) })),
    });

    const run = await runJob("daily", { now: NOW });
    expect(run.status).toBe("completed");
    const steps = (run.summary as { sites: Array<{ steps: Record<string, { status: string; detail: unknown }> }> }).sites[0].steps;
    expect(steps.visibility).toMatchObject({ status: "skipped", detail: expect.stringContaining("no LLM provider") });
    expect(steps.indexnow).toMatchObject({ status: "skipped" });
    expect(steps.snapshot.status).toBe("ok");
    expect(steps.alerts).toMatchObject({ status: "ok", detail: { status: "sent" } });

    const snap = await prisma.metricSnapshot.findFirstOrThrow({ where: { siteId: site.id, kind: "daily" }, orderBy: { capturedAt: "desc" } });
    expect(snap.visibilityRate).toBe(0);
    expect(snap.alertedAt).not.toBeNull();
    expect((snap.anomalies as Array<{ type: string }>).map((a) => a.type).sort()).toEqual(["citation_drop", "visibility_drop"]);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe("🚨 Kritik AI görünürlük anormalliği — Örnek Mağaza");
    expect(JSON.parse(calls.find((c) => c.url === SLACK)!.body).text).toContain("anormalliği");
    expect(await prisma.reportDelivery.count({ where: { kind: "alert" } })).toBe(2);
  });

  it("weekly job queues a scheduled audit when no runner is configured", async () => {
    const site = await seedSite();
    const run = await runJob("weekly", { siteId: site.id });
    const steps = (run.summary as { sites: Array<{ steps: Record<string, { status: string; detail: { execution?: string } }> }> }).sites[0].steps;
    expect(steps.audit).toMatchObject({ status: "ok", detail: { execution: "queued" } });
    expect(await prisma.crawlSession.findFirst({ where: { siteId: site.id, trigger: "scheduled", status: "queued" } })).not.toBeNull();
    // Second run: the audit is still in progress, so it is skipped rather than duplicated.
    const again = await runJob("weekly", { siteId: site.id });
    expect((again.summary as { sites: Array<{ steps: Record<string, { status: string }> }> }).sites[0].steps.audit.status).toBe("skipped");
  });

  it("HTTP trigger: dry runs are open, real runs require API_TOKEN", async () => {
    await seedSite();
    const dry = await runRoute.POST(req("/api/jobs/run", { method: "POST", body: { job: "daily", dryRun: true } }), undefined);
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ job: "daily", dryRun: true, trigger: "api", status: "completed" });

    expect((await runRoute.POST(req("/api/jobs/run", { method: "POST", body: { job: "reports" } }), undefined)).status).toBe(503);
    process.env.API_TOKEN = "t0k";
    expect((await runRoute.POST(req("/api/jobs/run", { method: "POST", body: { job: "reports" } }), undefined)).status).toBe(401);
    const authed = new Request("http://localhost/api/jobs/run", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t0k" },
      body: JSON.stringify({ job: "reports" }),
    });
    expect((await runRoute.POST(authed, undefined)).status).toBe(200);
    expect((await runRoute.POST(req("/api/jobs/run", { method: "POST", body: { job: "hourly" } }), undefined)).status).toBe(400);
  });

  it("validates cron expressions from env", () => {
    expect(resolveSchedules({ CRON_DAILY: "30 4 * * *", CRON_DISTRIBUTION: "off" })).toEqual({
      daily: "30 4 * * *",
      weekly: "0 2 * * 1",
      reports: "*/15 * * * *",
    });
    expect(() => resolveSchedules({ CRON_WEEKLY: "every monday" })).toThrow(/CRON_WEEKLY/);
  });
});

describe("chat payloads", () => {
  it("keeps Slack / Discord payloads inside platform limits", async () => {
    const site = await seedSite();
    const r = await buildPeriodicReport(site.id, "weekly", NOW);
    const slack = buildSlackPayload({ event: "report.weekly", report: r, links: {} }) as { blocks: Array<{ text?: { text: string } }> };
    expect(slack.blocks.every((b) => !b.text || b.text.text.length <= 3000)).toBe(true);
    const discord = buildDiscordPayload({ event: "report.weekly", report: r, links: { pdf: "https://x/p.pdf" } });
    expect((discord.embeds[0] as { fields: unknown[] }).fields.length).toBeLessThanOrEqual(25);
    expect(discord.embeds[0].description!.length).toBeLessThanOrEqual(4096);
  });
});
