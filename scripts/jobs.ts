// Manual job trigger / report preview CLI. Examples:
//   npm run jobs -- run daily --dry-run
//   npm run jobs -- run weekly --site <siteId>
//   npm run jobs -- list
//   npm run jobs -- preview <siteId> --frequency weekly --out ./reports
//   npm run jobs -- send <scheduleId> [--dry-run] [--force]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JOB_NAMES, REPORT_FREQUENCIES, type JobName, type ReportFrequency } from "../src/lib/constants";
import { prisma } from "../src/lib/db";
import { buildPeriodicReport } from "../src/lib/reports/builder";
import { reportFilename, sendScheduledReport } from "../src/lib/reports/dispatch";
import { renderReportHtml, renderReportText } from "../src/lib/reports/html";
import { renderReportPdf } from "../src/lib/reports/pdf";
import { resolveSchedules } from "../src/lib/scheduler/cron";
import { listJobRuns, runJob } from "../src/lib/scheduler/jobs";

const USAGE = `Usage:
  jobs run <${JOB_NAMES.join("|")}> [--dry-run] [--site <siteId>]
  jobs list [--job <name>] [--limit N]
  jobs schedules
  jobs preview <siteId> [--frequency daily|weekly] [--out <dir>]
  jobs send <scheduleId> [--dry-run] [--force]`;

function flag(args: string[], name: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]) {
  const [cmd, arg, ...rest] = argv;
  const args = [arg, ...rest].filter((x): x is string => x !== undefined);
  switch (cmd) {
    case "run": {
      if (!JOB_NAMES.includes(arg as JobName)) throw new Error(`Unknown job "${arg}"\n${USAGE}`);
      const run = await runJob(arg as JobName, { trigger: "manual", dryRun: args.includes("--dry-run"), siteId: flag(args, "site") });
      console.log(JSON.stringify(run, null, 2));
      return run.status === "failed" ? 1 : 0;
    }
    case "list": {
      const runs = await listJobRuns({ job: flag(args, "job") as JobName | undefined, limit: Number(flag(args, "limit") ?? 20) });
      for (const r of runs) {
        const secs = r.finishedAt ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000) : "-";
        console.log(`${r.startedAt.toISOString()}  ${r.job.padEnd(12)} ${r.status.padEnd(10)} ${r.trigger.padEnd(7)} ${String(secs).padStart(5)}s ${r.dryRun ? "dry-run" : ""} ${r.error ?? ""}`);
      }
      return 0;
    }
    case "schedules": {
      console.log(JSON.stringify(resolveSchedules(), null, 2));
      return 0;
    }
    case "preview": {
      if (!arg) throw new Error(USAGE);
      const frequency = (flag(args, "frequency") ?? "weekly") as ReportFrequency;
      if (!REPORT_FREQUENCIES.includes(frequency)) throw new Error(`--frequency must be one of ${REPORT_FREQUENCIES.join(", ")}`);
      const out = path.resolve(flag(args, "out") ?? "reports");
      mkdirSync(out, { recursive: true });
      const report = await buildPeriodicReport(arg, frequency);
      const files = {
        html: path.join(out, reportFilename(report, "html")),
        pdf: path.join(out, reportFilename(report, "pdf")),
        json: path.join(out, reportFilename(report, "pdf").replace(/\.pdf$/, ".json")),
      };
      writeFileSync(files.html, renderReportHtml(report));
      writeFileSync(files.pdf, renderReportPdf(report));
      writeFileSync(files.json, JSON.stringify(report, null, 2));
      console.log(renderReportText(report));
      console.log(`\nWritten:\n  ${Object.values(files).join("\n  ")}`);
      return 0;
    }
    case "send": {
      if (!arg) throw new Error(USAGE);
      const res = await sendScheduledReport(arg, { dryRun: args.includes("--dry-run"), force: args.includes("--force") });
      console.log(JSON.stringify(res, null, 2));
      return res.status === "failed" ? 1 : 0;
    }
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2))
  .then((code) => (process.exitCode = code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
