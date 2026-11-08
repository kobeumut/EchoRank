import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import * as auditRoute from "@/app/api/sites/[id]/audit/route";
import * as cancelRoute from "@/app/api/sites/[id]/audit/[auditId]/cancel/route";
import * as resultRoute from "@/app/api/sites/[id]/audit/[auditId]/result/route";
import { cancelAudit, executeAudit, registerAuditRunner, startAudit } from "@/lib/services/audit";
import { auditPercent } from "@/lib/services/audit-progress";
import { defaultAuditRunner } from "@/lib/services/audit-runner";
import { ctx, req, resetDb } from "./helpers";

const FIXTURE = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/geo-audit-result.json"), "utf8"));
const cctx = (id: string, auditId: string) => ({ params: Promise.resolve({ id, auditId }) });
const cancel = (siteId: string, auditId: string) => cancelRoute.POST(req(`/api/sites/${siteId}/audit/${auditId}/cancel`, { method: "POST" }), cctx(siteId, auditId));
const crawlOf = (id: string) => prisma.crawlSession.findUniqueOrThrow({ where: { id } });
const auditOf = (id: string) => prisma.geoAudit.findUniqueOrThrow({ where: { id } });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("ALLOW_PRIVATE_NETWORK_TARGETS", "true"); // no DNS in tests; the SSRF guard has its own tests
});
afterEach(() => { registerAuditRunner(null); vi.unstubAllEnvs(); });
afterAll(() => prisma.$disconnect());

async function newAudit() {
  const site = await prisma.site.create({ data: { url: "https://shop.example.com", title: "Shop" } });
  return { site, job: await startAudit(site.id, { trigger: "manual" }) };
}

describe("estimated progress", () => {
  it("maps stages to a rising percentage and the crawl to its own share", () => {
    expect(auditPercent("crawl", 0, 50)).toBe(2);
    expect(auditPercent("crawl", 25, 50)).toBe(31);
    expect(auditPercent("crawl", 50, 50)).toBe(60);
    const stages = ["crawl", "graph", "signals", "bots", "scoring", "ingest"].map((s) => auditPercent(s, 50, 50));
    expect(stages).toEqual([...stages].sort((a, b) => a - b));
    expect(Math.max(...stages)).toBeLessThan(100);
  });

  it("clamps nonsense and ignores unknown stages", () => {
    expect(auditPercent("crawl", 80, 50)).toBe(60);
    expect(auditPercent("crawl", -3, 50)).toBe(2);
    expect(auditPercent("crawl", 5, 0)).toBe(2);
    expect(auditPercent("starting")).toBe(0);
    expect(auditPercent(null)).toBe(0);
  });
});

describe("cancelling an audit", () => {
  it("releases a queued audit that nothing will ever run (no runner configured) and unblocks the site", async () => {
    const { site, job } = await newAudit();
    await expect(startAudit(site.id, { trigger: "manual" })).rejects.toMatchObject({ status: 409 });
    const res = await cancel(site.id, job.audit.id);
    expect(res.status).toBe(200);
    expect((await res.json()).audit).toMatchObject({ id: job.audit.id, status: "cancelled", crawlSession: { status: "cancelled" } });
    expect(await auditOf(job.audit.id)).toMatchObject({ status: "cancelled", error: null });
    expect((await crawlOf(job.crawlSession.id)).finishedAt).not.toBeNull();
    await expect(startAudit(site.id, { trigger: "manual" })).resolves.toBeDefined();
  });

  it("rejects cancelling something that is finished, already cancelled, unknown or on another site", async () => {
    const { site, job } = await newAudit();
    expect((await cancel(site.id, job.audit.id)).status).toBe(200);
    const again = await cancel(site.id, job.audit.id);
    expect(again.status).toBe(409);
    expect((await again.json()).details).toMatchObject({ status: "cancelled" });

    const next = await startAudit(site.id, { trigger: "manual" });
    await resultRoute.POST(req("/", { method: "POST", body: FIXTURE }), cctx(site.id, next.audit.id));
    expect((await cancel(site.id, next.audit.id)).status).toBe(409);
    expect(await auditOf(next.audit.id)).toMatchObject({ status: "completed", geoScore: FIXTURE.audit.geoScore });

    const other = await prisma.site.create({ data: { url: "https://other.example.com", title: "Other" } });
    expect((await cancel(other.id, next.audit.id)).status).toBe(404);
    expect((await cancel(site.id, "missing")).status).toBe(404);
  });

  it("stops a running runner through its abort signal and keeps the audit cancelled, not failed", async () => {
    let seen: AbortSignal | undefined;
    registerAuditRunner(async (job) => {
      seen = job.signal;
      await prisma.crawlSession.update({ where: { id: job.crawlSession.id }, data: { status: "running" } });
      await prisma.geoAudit.update({ where: { id: job.audit.id }, data: { status: "running" } });
      await new Promise((_, reject) => job.signal!.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true }));
    });
    const { site, job } = await newAudit();
    const running = executeAudit(job);
    await vi.waitFor(async () => expect((await auditOf(job.audit.id)).status).toBe("running"));
    expect((await cancel(site.id, job.audit.id)).status).toBe(200);
    await running;
    expect(seen?.aborted).toBe(true);
    expect(await auditOf(job.audit.id)).toMatchObject({ status: "cancelled", error: null });
    expect(await crawlOf(job.crawlSession.id)).toMatchObject({ status: "cancelled", error: null });
  });

  it("does not let a result that arrives after the cancel turn it back into a completed audit", async () => {
    const { site, job } = await newAudit();
    await cancelAudit(site.id, job.audit.id);
    const res = await resultRoute.POST(req("/", { method: "POST", body: FIXTURE }), cctx(site.id, job.audit.id));
    expect(res.status).toBe(409);
    expect(await auditOf(job.audit.id)).toMatchObject({ status: "cancelled", geoScore: null });
    expect(await prisma.actionItem.count({ where: { siteId: site.id } })).toBe(0);
  });
});

describe("geo-audit CLI runner: progress and cancel", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "fake-geo-progress-")); });
  afterEach(async () => {
    // A failed assertion must not leave a fake engine running behind: cancelling aborts and kills it.
    for (const open of await prisma.geoAudit.findMany({ where: { status: { in: ["pending", "running"] } } })) await cancelAudit(open.siteId, open.id).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  /** Fake engine: reports progress, records pids, then waits for a `go` file (or runs until killed). */
  function fakeEngine(mode: "finish" | "hang") {
    const { crawl, ...rows } = FIXTURE;
    writeFileSync(path.join(dir, "rows.json"), JSON.stringify(rows));
    writeFileSync(path.join(dir, "crawl.json"), JSON.stringify(crawl));
    const bin = path.join(dir, "geo-audit");
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"); const { spawn } = require("child_process");
const a = process.argv.slice(2); const out = (f) => a[a.indexOf(f) + 1]; const dir = ${JSON.stringify(dir)};
fs.writeFileSync(dir + "/args.json", JSON.stringify(a));
const say = (o) => process.stderr.write("GEO_PROGRESS " + JSON.stringify(o) + "\\n");
process.stderr.write("some warning the user should see on failure\\n");
fs.writeFileSync(dir + "/pid", String(process.pid));
fs.writeFileSync(dir + "/grandchild", String(spawn("sleep", ["60"], { stdio: "ignore" }).pid));
say({ stage: "crawl", done: 0, total: 10 }); say({ stage: "crawl", done: 5, total: 10 });
setInterval(() => {
  if (${JSON.stringify(mode)} !== "finish" || !fs.existsSync(dir + "/go")) return;
  say({ stage: "graph" });
  fs.writeFileSync(out("-o"), "{}");
  fs.copyFileSync(dir + "/rows.json", out("--db-records")); fs.copyFileSync(dir + "/crawl.json", out("--crawl-records"));
  process.exit(0);
}, 50);
`);
    chmodSync(bin, 0o755);
    vi.stubEnv("GEO_AUDIT_BIN", bin);
    registerAuditRunner(defaultAuditRunner());
  }

  it("asks the engine for progress and stores an estimated percentage while it runs", async () => {
    fakeEngine("finish");
    const { site, job } = await newAudit();
    const running = executeAudit(job);
    await vi.waitFor(async () => {
      expect(await crawlOf(job.crawlSession.id)).toMatchObject({ status: "running", stage: "crawl", pagesCrawled: 0, pagesTotal: 10 });
    });
    // The 5/10 event arrived inside the one-second window of the 0/10 one: it must still be written, not dropped.
    await vi.waitFor(async () => {
      expect(await crawlOf(job.crawlSession.id)).toMatchObject({ stage: "crawl", pagesCrawled: 5, pagesTotal: 10, progress: auditPercent("crawl", 5, 10) });
    }, { timeout: 4000 });

    const listing = await (await auditRoute.GET(req("/"), ctx(site.id))).json();
    expect(listing.runner).toBe(true);
    expect(listing.items[0].crawlSession).toMatchObject({ status: "running", stage: "crawl", progress: 31, pagesCrawled: 5, pagesTotal: 10 });
    expect(JSON.parse(readFileSync(path.join(dir, "args.json"), "utf8"))).toContain("--progress");

    writeFileSync(path.join(dir, "go"), "");
    await running;
    expect(await auditOf(job.audit.id)).toMatchObject({ status: "completed", error: null });
    expect(await crawlOf(job.crawlSession.id)).toMatchObject({ status: "completed" });
  });

  it("never lets the percentage go down, even when the crawl estimate grows", async () => {
    const bin = path.join(dir, "geo-audit");
    writeFileSync(bin, `#!/usr/bin/env node
const say = (o) => process.stderr.write("GEO_PROGRESS " + JSON.stringify(o) + "\\n");
say({ stage: "crawl", done: 5, total: 10 });
setTimeout(() => say({ stage: "crawl", done: 5, total: 40 }), 1300); // links discovered: the estimate grows
setInterval(() => {}, 1000);
`);
    chmodSync(bin, 0o755);
    vi.stubEnv("GEO_AUDIT_BIN", bin);
    registerAuditRunner(defaultAuditRunner());
    const { job } = await newAudit();
    const running = executeAudit(job);
    await vi.waitFor(async () => expect(await crawlOf(job.crawlSession.id)).toMatchObject({ pagesTotal: 10, progress: 31 }));
    await vi.waitFor(async () => expect(await crawlOf(job.crawlSession.id)).toMatchObject({ pagesTotal: 40 }), { timeout: 4000 });
    expect((await crawlOf(job.crawlSession.id)).progress).toBe(31); // raw estimate would be 9%
    await cancelAudit(job.site.id, job.audit.id);
    await running;
  }, 15_000);

  it("kills the engine and everything it started when cancelled, and ingests nothing", async () => {
    fakeEngine("hang");
    const { site, job } = await newAudit();
    const running = executeAudit(job);
    await vi.waitFor(() => expect(existsSync(path.join(dir, "grandchild"))).toBe(true));
    const pid = Number(readFileSync(path.join(dir, "pid"), "utf8"));
    const grandchild = Number(readFileSync(path.join(dir, "grandchild"), "utf8"));
    expect(alive(pid) && alive(grandchild)).toBe(true);

    expect((await cancel(site.id, job.audit.id)).status).toBe(200);
    await running;
    await vi.waitFor(() => expect([alive(pid), alive(grandchild)]).toEqual([false, false]), { timeout: 5000 });
    expect(await auditOf(job.audit.id)).toMatchObject({ status: "cancelled", geoScore: null, error: null });
    expect(await crawlOf(job.crawlSession.id)).toMatchObject({ status: "cancelled" });
    expect(await prisma.crawledPage.count({ where: { siteId: site.id } })).toBe(0);
  });

  it("does not start the engine for an audit that was cancelled before the runner got to it", async () => {
    fakeEngine("finish");
    const { site, job } = await newAudit();
    await cancelAudit(site.id, job.audit.id);
    await executeAudit(job);
    expect(existsSync(path.join(dir, "pid"))).toBe(false);
    expect(await auditOf(job.audit.id)).toMatchObject({ status: "cancelled" });
    expect(await crawlOf(job.crawlSession.id)).toMatchObject({ status: "cancelled" });
  });

  it("keeps the engine's stderr in the failure message, without the progress lines", async () => {
    const bin = path.join(dir, "geo-audit");
    writeFileSync(bin, `#!/usr/bin/env node
process.stderr.write("GEO_PROGRESS " + JSON.stringify({ stage: "crawl", done: 1, total: 2 }) + "\\n");
process.stderr.write("ModuleNotFoundError: no module named httpx\\n");
process.exit(3);
`);
    chmodSync(bin, 0o755);
    vi.stubEnv("GEO_AUDIT_BIN", bin);
    registerAuditRunner(defaultAuditRunner());
    const { job } = await newAudit();
    await executeAudit(job);
    const audit = await auditOf(job.audit.id);
    expect(audit.status).toBe("failed");
    expect(audit.error).toContain("exited with code 3");
    expect(audit.error).toContain("ModuleNotFoundError");
    expect(audit.error).not.toContain("GEO_PROGRESS");
  });

  it("reports that no runner is configured so the UI can say nothing is executing", async () => {
    const { site } = await newAudit();
    expect((await (await auditRoute.GET(req("/"), ctx(site.id))).json()).runner).toBe(false);
  });
});
