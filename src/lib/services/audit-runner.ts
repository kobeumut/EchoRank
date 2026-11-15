// Default audit runner: shells out to the Python scoring engine (`geo-audit`, services/crawler)
// and ingests its output. Enabled when GEO_AUDIT_BIN points at the executable,
// e.g. GEO_AUDIT_BIN=services/crawler/.venv/bin/geo-audit
// The engine writes its labels, findings and action cards in the language given by `--lang <locale>`: the locale of
// the request that triggered the audit, unless GEO_AUDIT_ARGS already contains a `--lang` flag.
//
// The engine runs with `--progress`, which prints `GEO_PROGRESS {json}` lines on stderr (stage, pages
// done / estimated total). They are turned into an estimated percentage on the CrawlSession so the
// dashboard can show it. Aborting the job's signal kills the engine's whole process group.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { prisma } from "../db";
import { assertPublicHttpUrl } from "../distribution/net";
import { DEFAULT_LOCALE } from "../i18n/config";
import type { AuditJob, AuditRunner } from "./audit";
import { applyAuditResult, auditResultSchema } from "./audit-results";
import { auditPercent, isAuditStage } from "./audit-progress";

const PROGRESS_PREFIX = "GEO_PROGRESS ";
/** Progress is written to the database at most this often per stage (a stage change always writes). */
const WRITE_EVERY_MS = 1_000;
const KILL_GRACE_MS = 3_000;

export interface CliRunnerOptions {
  /** Max runtime in ms (default 15 min). */
  timeoutMs?: number;
  /** Extra CLI flags, e.g. ["--rps", "2", "--no-ua-probe"]. A `--lang` flag here overrides the job's locale. */
  extraArgs?: string[];
}

/** True when the configured flags already choose the output language (`--lang tr` or `--lang=tr`). */
export const hasLangFlag = (args: readonly string[]) => args.some((arg) => arg === "--lang" || arg.startsWith("--lang="));

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

const progressEvent = z.object({ stage: z.string(), done: z.number().optional(), total: z.number().optional() });

/**
 * Turns engine progress events into throttled, never-decreasing writes. Only touches a still-running session.
 * Events inside the throttle window are not lost: the newest one is written when the window ends.
 */
function progressRecorder(job: AuditJob) {
  let percent = 0;
  let writtenStage = "";
  let lastWrite = 0;
  let timer: NodeJS.Timeout | undefined;
  let latest: { stage: string; done: number; total: number } | undefined;

  const write = () => {
    timer = undefined;
    if (!latest) return;
    const { stage, done, total } = latest;
    latest = undefined;
    writtenStage = stage;
    lastWrite = Date.now();
    prisma.crawlSession
      .updateMany({
        where: { id: job.crawlSession.id, status: "running" },
        data: { stage, progress: percent, ...(stage === "crawl" ? { pagesCrawled: done, pagesTotal: total || null } : {}) },
      })
      .catch(() => undefined); // progress is best effort: it must never fail the audit
  };

  return {
    record(raw: unknown) {
      const event = progressEvent.safeParse(raw);
      if (!event.success || !isAuditStage(event.data.stage)) return;
      const { stage, done = 0, total = 0 } = event.data;
      percent = Math.max(percent, auditPercent(stage, done, total));
      latest = { stage, done, total };
      const wait = WRITE_EVERY_MS - (Date.now() - lastWrite);
      if (stage !== writtenStage || wait <= 0) {
        clearTimeout(timer);
        write();
      } else timer ??= setTimeout(write, wait);
    },
    /** Drop a pending write: the audit is over, whoever ended it owns the final state. */
    stop() {
      clearTimeout(timer);
      latest = undefined;
    },
  };
}

function runEngine(bin: string, args: string[], opts: { timeoutMs: number; signal?: AbortSignal; onProgress: (event: unknown) => void }) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error("Audit cancelled"));
    // Own process group: the engine is usually a venv shim that starts Python, and both must die together.
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
    let stderr = "";
    let pending = "";
    let settled = false;
    const signalGroup = (sig: NodeJS.Signals) => {
      try { process.kill(-child.pid!, sig); } catch { child.kill(sig); }
    };
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      done();
    };
    const stop = (error: Error) => {
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
      finish(() => reject(error));
    };
    const onAbort = () => stop(new Error("Audit cancelled"));
    const timer = setTimeout(() => stop(new Error(`geo-audit timed out after ${Math.round(opts.timeoutMs / 1000)}s`)), opts.timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (!line.startsWith(PROGRESS_PREFIX)) {
          stderr = `${stderr}${line}\n`.slice(-8_000);
          continue;
        }
        try { opts.onProgress(JSON.parse(line.slice(PROGRESS_PREFIX.length))); } catch { /* a malformed line is not worth failing for */ }
      }
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => finish(() => resolve({ code, stderr })));
  });
}

export function createCliAuditRunner(bin: string, opts: CliRunnerOptions = {}): AuditRunner {
  return async (job: AuditJob) => {
    const now = new Date();
    // Claim the job. If it was cancelled before the runner got here nothing is active any more: do not run.
    const [claimed] = await prisma.$transaction([
      prisma.crawlSession.updateMany({ where: { id: job.crawlSession.id, status: "queued" }, data: { status: "running", startedAt: now } }),
      prisma.geoAudit.updateMany({ where: { id: job.audit.id, status: "pending" }, data: { status: "running" } }),
    ]);
    if (!claimed.count) throw new Error("Audit cancelled");
    // The crawler fetches whatever the stored URL resolves to today: refuse internal addresses (SSRF).
    // A failure here propagates like any runner error, so the audit is marked failed without starting the CLI.
    await assertPublicHttpUrl(job.site.url);

    const progress = progressRecorder(job);
    const dir = await mkdtemp(path.join(tmpdir(), "geo-audit-"));
    const files = { audit: path.join(dir, "audit.json"), rows: path.join(dir, "rows.json"), crawl: path.join(dir, "crawl.json") };
    try {
      const args = [
        job.site.url,
        "-o", files.audit,
        "--db-records", files.rows,
        "--crawl-records", files.crawl,
        "--max-pages", String(job.crawlSession.maxPages),
        "--depth", String(job.crawlSession.maxDepth),
        "--progress",
        ...(opts.extraArgs ?? []),
        ...(hasLangFlag(opts.extraArgs ?? []) ? [] : ["--lang", job.locale ?? DEFAULT_LOCALE]),
      ];
      const { code, stderr } = await runEngine(bin, args, { timeoutMs: opts.timeoutMs ?? 15 * 60_000, signal: job.signal, onProgress: progress.record });
      // exit code 1 = crawl reached no pages; output files are still written and ingested below
      if (code !== 0 && code !== 1) throw new Error(`geo-audit exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`);
      if (job.signal?.aborted) throw new Error("Audit cancelled");
      const rows = await readJson(files.rows);
      if (!rows) throw new Error("geo-audit produced no result");
      const crawl = await readJson(files.crawl);
      const payload = auditResultSchema.parse({ ...(rows as object), crawl: crawl ?? undefined });
      await prisma.crawlSession.updateMany({ where: { id: job.crawlSession.id, status: "running" }, data: { stage: "ingest", progress: auditPercent("ingest") } });
      await applyAuditResult(job.site.id, job.audit.id, payload);
    } finally {
      progress.stop();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

let cached: { bin: string; runner: AuditRunner } | null = null;

/** Runner configured from the environment, or null (audits then stay queued for an external worker). */
export function defaultAuditRunner(): AuditRunner | null {
  const bin = process.env.GEO_AUDIT_BIN?.trim();
  if (!bin) return null;
  if (cached?.bin !== bin) {
    const extra = process.env.GEO_AUDIT_ARGS?.trim();
    cached = { bin, runner: createCliAuditRunner(bin, { extraArgs: extra ? extra.split(/\s+/) : [] }) };
  }
  return cached.runner;
}
