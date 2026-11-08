// Long-running scheduler worker: `npm run scheduler` (see docs/scheduler-reports.md).
import { prisma } from "../src/lib/db";
import { startScheduler } from "../src/lib/scheduler/cron";

const handle = startScheduler();
console.info(`[scheduler] started with ${handle.tasks.length} job(s), timezone ${process.env.SCHEDULER_TIMEZONE || "UTC"}`);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.info(`[scheduler] ${signal} received, stopping`);
  await handle.stop();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
