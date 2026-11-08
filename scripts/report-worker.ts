import cron from "node-cron";
import { parseArgs } from "node:util";
import { prisma } from "../src/lib/db";
import { recoverSchedule, runDueReports, runSchedule } from "../src/lib/reports/scheduler";

async function main() {
  const { values } = parseArgs({ options: { once: { type: "boolean" }, schedule: { type: "string" }, force: { type: "boolean" }, recover: { type: "string" }, "workers-stopped": { type: "boolean" } } });
  if (values.force && !values.schedule) throw new Error("--force requires --schedule <id>");
  if (values.recover) {
    if (!values["workers-stopped"]) throw new Error("Stop all workers first, then pass --workers-stopped. Recovery disables the schedule; delivery may already have occurred.");
    console.log({ recovered: await recoverSchedule(values.recover) });
    await prisma.$disconnect();
    return;
  }
  if (values.once || values.schedule) {
    const result = values.schedule ? await runSchedule(values.schedule, { force: values.force }) : await runDueReports();
    // No snapshot, destinations, or secrets in process logs.
    console.log(JSON.stringify(result && !Array.isArray(result) ? { id: result.id, status: result.status } : result));
    if (result && (Array.isArray(result) ? result.some((r) => r.status !== "completed") : result.status !== "completed")) process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }
  let stopping = false;
  let busy = false;
  let active: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopping || busy) return active;
    busy = true;
    active = runDueReports().then((results) => console.log(JSON.stringify(results))).catch(() => console.error("Report dispatch failed; inspect persisted claims/runs")).finally(() => { busy = false; });
    return active;
  };
  // Dedicated foreground process, never started in Next request handlers or module imports.
  const task = cron.schedule("* * * * *", tick, { timezone: "UTC", noOverlap: true });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await task.stop();
    await active;
    await task.destroy();
    await prisma.$disconnect();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.log("Report worker ready: minute ticks, daily 06:00 UTC, weekly Monday 06:00 UTC");
  await tick();
}
main().catch(async () => { console.error("Report worker failed; check configuration and persisted claims"); process.exitCode = 1; await prisma.$disconnect(); });
