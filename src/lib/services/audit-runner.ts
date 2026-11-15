// Default audit runner: shells out to the Python scoring engine (`geo-audit`, services/crawler)
// and ingests its output. Enabled when GEO_AUDIT_BIN points at the executable,
// e.g. GEO_AUDIT_BIN=services/crawler/.venv/bin/geo-audit
// The engine writes its labels, findings and action cards in the language given by `--lang <locale>`: the locale of
// the request that triggered the audit, unless GEO_AUDIT_ARGS already contains a `--lang` flag.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prisma } from "../db";
import { assertPublicHttpUrl } from "../distribution/net";
import { DEFAULT_LOCALE } from "../i18n/config";
import type { AuditJob, AuditRunner } from "./audit";
import { applyAuditResult, auditResultSchema } from "./audit-results";

const run = promisify(execFile);

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

export function createCliAuditRunner(bin: string, opts: CliRunnerOptions = {}): AuditRunner {
  return async (job: AuditJob) => {
    const now = new Date();
    await prisma.$transaction([
      prisma.crawlSession.update({ where: { id: job.crawlSession.id }, data: { status: "running", startedAt: now } }),
      prisma.geoAudit.update({ where: { id: job.audit.id }, data: { status: "running" } }),
    ]);
    // The crawler fetches whatever the stored URL resolves to today: refuse internal addresses (SSRF).
    // A failure here propagates like any runner error, so the audit is marked failed without starting the CLI.
    await assertPublicHttpUrl(job.site.url);
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
        ...(opts.extraArgs ?? []),
        ...(hasLangFlag(opts.extraArgs ?? []) ? [] : ["--lang", job.locale ?? DEFAULT_LOCALE]),
      ];
      try {
        await run(bin, args, { timeout: opts.timeoutMs ?? 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
      } catch (err) {
        // exit code 1 = crawl reached no pages; output files are still written and ingested below
        const code = (err as { code?: unknown }).code;
        if (code !== 1) throw err;
      }
      const rows = await readJson(files.rows);
      if (!rows) throw new Error("geo-audit produced no result");
      const crawl = await readJson(files.crawl);
      const payload = auditResultSchema.parse({ ...(rows as object), crawl: crawl ?? undefined });
      await applyAuditResult(job.site.id, job.audit.id, payload);
    } finally {
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
