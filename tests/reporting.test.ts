import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { buildSnapshot } from "@/lib/reports/snapshot";
import { renderReportHtml, renderReportPdf } from "@/lib/reports/render";
import { deliverReport } from "@/lib/reports/notify";
import { publicRequest, isBlockedReportAddress } from "@/lib/reports/outbound";
import { runDueReports, runSchedule, recoverSchedule } from "@/lib/reports/scheduler";
import { registerAuditRunner, startAudit } from "@/lib/services/audit";
import { runVisibility } from "@/lib/services/visibility";
import * as schedules from "@/app/api/sites/[id]/reports/schedules/route";
import * as toggle from "@/app/api/sites/[id]/reports/schedules/[scheduleId]/route";
import * as download from "@/app/api/sites/[id]/reports/runs/[runId]/route";
import * as history from "@/app/api/sites/[id]/reports/runs/route";
import { getSiteReport } from "@/lib/services/reports";
import { sampleReport } from "./fixtures/report";
import { ctx, req, resetDb } from "./helpers";

vi.mock("@/lib/services/visibility", () => ({ runVisibility: vi.fn(), visibilityInput: { parse: (v: unknown) => v } }));
vi.mock("@/lib/reports/outbound", async (original) => ({ ...await original<typeof import("@/lib/reports/outbound")>(), publicRequest: vi.fn() }));
const fetchMock = vi.fn();
const now = new Date("2026-11-08T12:00:00Z");
const day = 86_400_000;
beforeEach(async () => {
  await resetDb();
  vi.stubEnv("API_TOKEN", "reports-test");
  vi.stubEnv("RESEND_API_KEY", "secret");
  vi.stubEnv("REPORT_FROM_EMAIL", "reports@example.com");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  vi.mocked(publicRequest).mockReset().mockResolvedValue({ status: 204, body: "" });
  vi.mocked(runVisibility).mockReset().mockResolvedValue({ successful: 4, attempted: 4, failed: 0 } as Awaited<ReturnType<typeof runVisibility>>);
  registerAuditRunner(null);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); registerAuditRunner(null); });
afterAll(() => prisma.$disconnect());
const site = () => prisma.site.create({ data: { url: "https://example.com", title: "Sample <script>alert(1)</script>", targetKeywords: ["q"] } });
async function schedule(frequency = "daily") {
  const s = await site();
  return prisma.scheduledReport.create({ data: { siteId: s.id, frequency, recipients: ["a@example.com"], nextRunAt: new Date(Date.now() - day) } });
}
const auth = (path: string) => req(path, { token: "reports-test" });

describe("immutable report evidence", () => {
  it("compares adjacent matched periods, persists trends, counts actions and detects declines/candidate jumps", async () => {
    const s = await site();
    await prisma.geoAudit.createMany({ data: [
      { siteId: s.id, status: "completed", geoScore: 80, eeatScore: 70, createdAt: new Date(now.getTime() - 8 * day) },
      { siteId: s.id, status: "completed", geoScore: 55, eeatScore: 45, createdAt: new Date(now.getTime() - day) },
      { siteId: s.id, status: "failed", geoScore: 1, createdAt: now },
    ] });
    for (let i = 0; i < 5; i++) {
      await prisma.llmVisibilityRecord.createMany({ data: [
        { siteId: s.id, model: "chatgpt", query: `q${i}`, citationStatus: "cited", checkedAt: new Date(now.getTime() - 8 * day) },
        { siteId: s.id, model: "chatgpt", query: `q${i}`, citationStatus: "none", checkedAt: new Date(now.getTime() - day), responseMeta: { competitorDomains: ["candidate.example", "candidate.example"] } },
      ] });
    }
    await prisma.actionItem.createMany({ data: [
      { siteId: s.id, title: "Fix schema", category: "schema", impact: "high" },
      { siteId: s.id, title: "Fixed access", category: "crawler", impact: "high", status: "resolved", resolvedAt: now },
      { siteId: s.id, title: "Old fix", category: "crawler", impact: "high", status: "resolved", resolvedAt: new Date(now.getTime() - 20 * day) },
    ] });
    const snapshot = await buildSnapshot(s.id, 7, now);
    expect(snapshot.scores).toMatchObject({ geo: 55, eeat: 45, delta: { geo: -25, eeat: -25 } });
    expect(snapshot.visibility).toMatchObject({ citations: 0, previousCitations: 5, matchedPairs: 5, change: -100 });
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.alerts).toHaveLength(4);
    expect(snapshot.actions).toMatchObject({ openCount: 1, resolvedCount: 1 });
    expect(snapshot.locale).toBe("en");
    expect(snapshot.summary).toBe("AI citation visibility decreased by 100 percentage points (100% to 0%) on 5 matched model/query pairs.");
    expect(snapshot.alerts).toContain("GEO score dropped 25 points since the pre-period audit.");
    const html = renderReportHtml(snapshot);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Fixed access");
    expect(html).toContain("Pending critical actions");
  });
  it("does not invent a change from no data, unmatched queries, or duplicate observations", async () => {
    const s = await site();
    const empty = await buildSnapshot(s.id, 7, now);
    expect(empty.scores.geo).toBeNull();
    expect(empty.visibility.change).toBeNull();
    await prisma.llmVisibilityRecord.createMany({ data: [
      { siteId: s.id, model: "chatgpt", query: "old", citationStatus: "cited", checkedAt: new Date(now.getTime() - 8 * day) },
      { siteId: s.id, model: "gemini", query: "new", citationStatus: "none", checkedAt: now },
    ] });
    expect((await buildSnapshot(s.id, 7, now)).visibility.change).toBeNull();
    await prisma.llmVisibilityRecord.createMany({ data: [
      { siteId: s.id, model: "chatgpt", query: "old", citationStatus: "cited", checkedAt: new Date(now.getTime() - day) },
      { siteId: s.id, model: "chatgpt", query: "old", citationStatus: "none", checkedAt: now },
    ] });
    expect((await buildSnapshot(s.id, 7, now)).visibility).toMatchObject({ matchedPairs: 1, change: -100 });
  });
  it("generates a real Unicode PDF and complete weekly HTML", async () => {
    const pdf = await renderReportPdf(sampleReport);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(10000);
    const html = renderReportHtml(sampleReport);
    for (const text of ["Executive summary", "20 percentage points", "Sample Store", "Daily trend", "Resolved critical actions", "DEMO"]) expect(html).toContain(text);
    expect(html).toContain('<html lang="en">');
  });
  it("writes the snapshot, HTML and PDF in the requested Turkish locale (text is stored in the language it was generated in)", async () => {
    const s = await prisma.site.create({ data: { url: "https://example.com", title: "Örnek Mağaza", targetKeywords: ["q"] } });
    await prisma.geoAudit.createMany({ data: [
      { siteId: s.id, status: "completed", geoScore: 80, eeatScore: 70, createdAt: new Date(now.getTime() - 8 * day) },
      { siteId: s.id, status: "completed", geoScore: 55, eeatScore: 45, createdAt: new Date(now.getTime() - day) },
    ] });
    const snapshot = await buildSnapshot(s.id, 7, now, [], "tr");
    expect(snapshot.locale).toBe("tr");
    expect(snapshot.alerts).toContain("GEO skoru, dönem öncesi denetime göre 25 puan düştü.");
    expect(snapshot.summary).toBe("Yapay zeka görünürlüğündeki değişimi hesaplamak için karşılaştırılabilir gözlem yetersiz.");
    expect(snapshot.caveats).toContain("kural tabanlı bir güven vekilidir");
    // The stored snapshot's own language wins; an explicit locale overrides it.
    const html = renderReportHtml(snapshot);
    expect(html).toContain('<html lang="tr">');
    for (const text of ["Yönetici özeti", "Skorlar ve kanıtlar", "Bekleyen kritik aksiyonlar (0)", "HAFTALIK ÖZET", "Örnek Mağaza"]) expect(html).toContain(text);
    expect(html).not.toContain("Executive summary");
    expect(renderReportHtml(snapshot, "en")).toContain("Executive summary");
    const pdf = await renderReportPdf(snapshot);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(renderReportHtml(sampleReport, "tr")).toContain("Yönetici özeti");
  });
  it("renders snapshots stored before localization (no `locale` field) in English", () => {
    const legacy: Partial<typeof sampleReport> = { ...sampleReport };
    delete legacy.locale;
    expect(renderReportHtml(legacy as typeof sampleReport)).toContain("Executive summary");
  });
});

describe("durable scheduler", () => {
  it("runs daily once, checks key and fresh visibility, saves evidence and delivers email", async () => {
    const s = await schedule();
    await prisma.site.update({ where: { id: s.siteId }, data: { integrations: { indexnowKey: "abcdefgh12345678" } } });
    vi.mocked(publicRequest).mockResolvedValueOnce({ status: 200, body: "abcdefgh12345678" });
    const result = await runDueReports();
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("completed");
    expect(runVisibility).toHaveBeenCalledWith(s.siteId, { refresh: true });
    const stored = await prisma.reportRun.findUniqueOrThrow({ where: { id: result[0].id } });
    expect(stored.snapshot).not.toBeNull();
    expect(stored.deliveries).toEqual([{ channel: "email", status: "sent", detail: "Resend HTTP 200" }]);
    const email = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(email.to).toEqual(["a@example.com"]);
    expect(email.html).toContain("Executive summary");
    expect(await runDueReports()).toEqual([]);
    const saved = await prisma.scheduledReport.findUniqueOrThrow({ where: { id: s.id } });
    expect(saved.claimId).toBeNull();
    expect(saved.nextRunAt!.getUTCHours()).toBe(6);
  });
  it("writes a scheduled report in the site's configured locale (settings.locale), e-mail subject included", async () => {
    const s = await schedule();
    await prisma.site.update({ where: { id: s.siteId }, data: { settings: { locale: "tr-TR" } } });
    const run = await runSchedule(s.id);
    expect(run?.snapshot).toMatchObject({ locale: "tr" });
    expect(run?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "llm-visibility", status: "ok", detail: "4/4 yeni kontrol başarılı oldu (önbellek atlandı)" }),
      expect.objectContaining({ name: "indexnow", status: "skipped", detail: "Geçerli bir IndexNow anahtarı yapılandırılmamış" }),
    ]));
    const email = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(email.subject).toMatch(/^Yapay zeka görünürlüğü: /);
    expect(email.html).toContain("Yönetici özeti");
    // Operator-facing delivery diagnostics stay English.
    expect(run?.deliveries).toEqual([{ channel: "email", status: "sent", detail: "Resend HTTP 200" }]);
  });
  it("defaults to English for sites without a supported locale", async () => {
    const s = await schedule();
    await prisma.site.update({ where: { id: s.siteId }, data: { settings: { locale: "de" } } });
    const run = await runSchedule(s.id);
    expect(run?.snapshot).toMatchObject({ locale: "en" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).subject).toMatch(/^AI visibility: /);
  });
  it("flushes only enabled IndexNow queues and marks deferred submissions partial", async () => {
    vi.stubEnv("ALLOW_PRIVATE_NETWORK_TARGETS", "true");
    const s = await schedule();
    await prisma.site.update({ where: { id: s.siteId }, data: { integrations: { indexnowKey: "abcdefgh12345678" } } });
    vi.mocked(publicRequest).mockResolvedValue({ status: 200, body: "abcdefgh12345678" });
    await prisma.submissionQueueItem.createMany({ data: [
      { siteId: s.siteId, url: "https://example.com/a", channel: "indexnow" },
      { siteId: s.siteId, url: "https://example.com/a", channel: "google_indexing" },
    ] });
    const run = await runSchedule(s.id);
    expect(run?.status).toBe("completed");
    expect(await prisma.submissionQueueItem.findFirstOrThrow({ where: { channel: "indexnow" } })).toMatchObject({ status: "sent" });
    expect(await prisma.submissionQueueItem.findFirstOrThrow({ where: { channel: "google_indexing" } })).toMatchObject({ status: "pending", attempts: 0 });
    await prisma.submissionQueueItem.updateMany({ where: { channel: "indexnow" }, data: { status: "pending", nextAttemptAt: new Date(0) } });
    await prisma.site.update({ where: { id: s.siteId }, data: { settings: { distribution: { channels: { indexnow: false } } } } });
    await runSchedule(s.id, { force: true });
    expect(await prisma.submissionQueueItem.findFirstOrThrow({ where: { channel: "indexnow" } })).toMatchObject({ status: "pending", attempts: 1 });
    await prisma.site.update({ where: { id: s.siteId }, data: { settings: {} } });
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const partial = await runSchedule(s.id, { force: true });
    expect(partial?.status).toBe("partial");
    expect(partial?.steps).toEqual(expect.arrayContaining([expect.objectContaining({ name: "indexnow-queue", status: "failed" })]));
  });
  it("does not claim disabled, future or already claimed schedules, including a second dispatcher", async () => {
    const s = await schedule();
    await prisma.scheduledReport.update({ where: { id: s.id }, data: { enabled: false } });
    expect(await runSchedule(s.id, { force: true })).toBeNull();
    await prisma.scheduledReport.update({ where: { id: s.id }, data: { enabled: true, nextRunAt: new Date(Date.now() + day) } });
    expect(await runSchedule(s.id)).toBeNull();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    vi.mocked(runVisibility).mockImplementationOnce(async () => { entered(); await new Promise<void>((r) => { release = r; }); return { successful: 4, attempted: 4, failed: 0 } as Awaited<ReturnType<typeof runVisibility>>; });
    const running = runSchedule(s.id, { force: true });
    await started;
    expect(await runSchedule(s.id, { force: true })).toBeNull();
    release(); await running;
    expect(await prisma.reportRun.count()).toBe(1);
  });
  it("awaits weekly crawl/graph/EEAT, marks missing checks partial, and isolates email failure from webhook", async () => {
    const s = await schedule("weekly");
    await prisma.scheduledReport.update({ where: { id: s.id }, data: { webhookUrl: "https://hooks.example.com/token" } });
    registerAuditRunner(async (job) => {
      await prisma.geoAudit.update({ where: { id: job.audit.id }, data: { status: "completed", geoScore: 71, eeatScore: 65, completedAt: new Date() } });
      await prisma.crawlSession.update({ where: { id: job.crawlSession.id }, data: { status: "completed" } });
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const run = await runSchedule(s.id);
    expect(run?.status).toBe("partial");
    expect(run?.snapshot).toMatchObject({ period: { days: 7 }, scores: { geo: 71, eeat: 65 } });
    expect(run?.deliveries).toEqual(expect.arrayContaining([expect.objectContaining({ channel: "webhook", status: "sent" }), expect.objectContaining({ channel: "email", status: "failed" })]));
    expect((await prisma.crawlSession.findFirstOrThrow()).trigger).toBe("scheduled");
  });
  it("does not queue a weekly crawl without a runner; failed providers are explicit, not zeros", async () => {
    const s = await schedule("weekly");
    vi.mocked(runVisibility).mockResolvedValue({ successful: 0, attempted: 4, failed: 4 } as Awaited<ReturnType<typeof runVisibility>>);
    const run = await runSchedule(s.id);
    expect(run?.status).toBe("partial");
    expect(await prisma.crawlSession.count()).toBe(0);
    expect(run?.snapshot).toMatchObject({ visibility: { citationRate: null }, steps: expect.arrayContaining([expect.objectContaining({ name: "crawl-graph-eeat", status: "skipped" }), expect.objectContaining({ name: "llm-provider-coverage", status: "failed" })]) });
  });
  it("atomically owns weekly jobs and recovers only its interrupted crawl and audit", async () => {
    const s = await schedule("weekly");
    await prisma.scheduledReport.update({ where: { id: s.id }, data: { claimId: "crash", claimedAt: now } });
    await prisma.reportRun.create({ data: { id: "crash", siteId: s.siteId, scheduleId: s.id, frequency: "weekly" } });
    const job = await startAudit(s.siteId, { trigger: "scheduled" }, "crash");
    expect(await prisma.reportRun.findUniqueOrThrow({ where: { id: "crash" } })).toMatchObject({ auditId: job.audit.id, crawlSessionId: job.crawlSession.id });
    await recoverSchedule(s.id);
    expect(await prisma.crawlSession.findUniqueOrThrow({ where: { id: job.crawlSession.id } })).toMatchObject({ status: "failed" });
    expect(await prisma.geoAudit.findUniqueOrThrow({ where: { id: job.audit.id } })).toMatchObject({ status: "failed" });
    const manual = await startAudit(s.siteId, { trigger: "manual" });
    expect(manual.crawlSession.status).toBe("queued");
    expect(await recoverSchedule(s.id)).toBe(false);
    expect(await prisma.crawlSession.findUniqueOrThrow({ where: { id: manual.crawlSession.id } })).toMatchObject({ status: "queued" });
  });
  it("sanitizes failures, advances the schedule and recovers interrupted claims only explicitly", async () => {
    const s = await schedule();
    vi.mocked(runVisibility).mockRejectedValueOnce(new Error("secret-key-in-error"));
    const run = await runSchedule(s.id);
    expect(JSON.stringify(run)).not.toContain("secret-key-in-error");
    expect(run?.status).toBe("partial");
    await prisma.scheduledReport.update({ where: { id: s.id }, data: { claimId: "interrupted", claimedAt: now } });
    await prisma.reportRun.create({ data: { id: "interrupted", siteId: s.siteId, scheduleId: s.id, frequency: "daily" } });
    expect(await runSchedule(s.id, { force: true })).toBeNull();
    expect(await recoverSchedule(s.id)).toBe(true);
    expect(await prisma.scheduledReport.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ enabled: false, claimId: null, nextRunAt: null });
    expect((await prisma.reportRun.findUniqueOrThrow({ where: { id: "interrupted" } })).status).toBe("interrupted");
  });
});

describe("notifications and protected report API", () => {
  it("rejects internal IPv4/IPv6, including mapped IPv4", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:7f00:1", "::ffff:192.168.0.1"]) expect(isBlockedReportAddress(address)).toBe(true);
    expect(isBlockedReportAddress("8.8.8.8")).toBe(false);
    expect(isBlockedReportAddress("2606:4700:4700::1111")).toBe(false);
  });
  it("refuses private targets, credentials and insecure webhooks before connecting", async () => {
    const actual = await vi.importActual<typeof import("@/lib/reports/outbound")>("@/lib/reports/outbound");
    for (const url of ["https://127.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://user:password@example.com/"]) await expect(actual.publicRequest(url)).rejects.toThrow();
    await expect(actual.publicRequest("http://8.8.8.8/", "{}")).rejects.toThrow("Webhook requires HTTPS");
  });
  it("sends a Slack/Discord-compatible summary and records failed webhook without leaking URL", async () => {
    const s = await schedule();
    const config = { ...s, recipients: [], webhookUrl: "https://hooks.example.com/secret" };
    expect(await deliverReport(config, "r1", sampleReport)).toMatchObject([{ channel: "webhook", status: "sent" }]);
    const body = JSON.parse(vi.mocked(publicRequest).mock.calls[0][1]!);
    expect(body.text).toBe(body.content);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    vi.mocked(publicRequest).mockRejectedValueOnce(new Error("https://hooks.example.com/secret"));
    const result = await deliverReport(config, "r2", sampleReport);
    expect(result[0].status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("requires a token, validates destination and supports disabling scoped schedules", async () => {
    const s = await site();
    const payload = { frequency: "weekly", webhookUrl: "https://hooks.example.com/secret" };
    const path = `/api/sites/${s.id}/reports/schedules`;
    vi.stubEnv("API_TOKEN", "");
    expect((await schedules.POST(req(path, { method: "POST", body: payload }), ctx(s.id))).status).toBe(503);
    vi.stubEnv("API_TOKEN", "reports-test");
    expect((await schedules.POST(req(path, { method: "POST", body: payload }), ctx(s.id))).status).toBe(401);
    expect((await schedules.POST(req(path, { method: "POST", token: "reports-test", body: { ...payload, webhookUrl: "http://localhost" } }), ctx(s.id))).status).toBe(400);
    expect((await schedules.POST(req(path, { method: "POST", token: "reports-test", body: { frequency: "daily" } }), ctx(s.id))).status).toBe(400);
    const created = await (await schedules.POST(req(path, { method: "POST", token: "reports-test", body: payload }), ctx(s.id))).json();
    const params = { params: Promise.resolve({ id: s.id, scheduleId: created.id }) };
    expect((await toggle.PATCH(req(path, { method: "PATCH", token: "reports-test", body: { enabled: false } }), params)).status).toBe(200);
    expect((await prisma.scheduledReport.findUniqueOrThrow({ where: { id: created.id } })).nextRunAt).toBeNull();
    expect(JSON.stringify((await getSiteReport(s.id, 7)).schedules)).not.toContain("secret");
  });
  it("downloads the stored snapshot as HTML/PDF, prevents cross-site access and keeps history bounded", async () => {
    const s = await schedule();
    const run = await runSchedule(s.id);
    const params = { params: Promise.resolve({ id: s.siteId, runId: run!.id }) };
    expect((await download.GET(req("/"), params)).status).toBe(401);
    const html = await download.GET(auth("/?format=html"), params);
    expect(html.status).toBe(200);
    expect(html.headers.get("cache-control")).toBe("private, no-store");
    expect(await html.text()).toContain("Executive summary");
    const pdf = await download.GET(auth("/?format=pdf"), params);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await download.GET(auth("/"), { params: Promise.resolve({ id: "other", runId: run!.id }) })).status).toBe(404);
    const listed = await (await history.GET(auth("/"), ctx(s.siteId))).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].snapshot).toBeUndefined();
  });
});
