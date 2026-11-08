import cron, { type ScheduledTask } from "node-cron";
import type { JobName } from "../constants";
import { JobBusyError, runJob } from "./jobs";

// node-cron wiring for the long-running scheduler process (`npm run scheduler`).
// Expressions come from env; set one to "off" to disable that job (e.g. when an external cron
// calls POST /api/jobs/run instead).

export const DEFAULT_SCHEDULES: Record<JobName, string> = {
  // Daily quick check before the 06:00 UTC report slot.
  daily: "0 5 * * *",
  // Weekly full crawl + scoring, Monday early morning (weekly reports go out Monday 06:00 UTC).
  weekly: "0 2 * * 1",
  reports: "*/15 * * * *",
  distribution: "*/10 * * * *",
  snapshot: "off",
};

const ENV_KEYS: Record<JobName, string> = {
  daily: "CRON_DAILY",
  weekly: "CRON_WEEKLY",
  reports: "CRON_REPORTS",
  distribution: "CRON_DISTRIBUTION",
  snapshot: "CRON_SNAPSHOT",
};

export function resolveSchedules(env: Record<string, string | undefined> = process.env) {
  const out: Partial<Record<JobName, string>> = {};
  for (const job of Object.keys(DEFAULT_SCHEDULES) as JobName[]) {
    const expr = env[ENV_KEYS[job]]?.trim() || DEFAULT_SCHEDULES[job];
    if (expr === "off" || expr === "false") continue;
    if (!cron.validate(expr)) throw new Error(`Invalid cron expression in ${ENV_KEYS[job]}: "${expr}"`);
    out[job] = expr;
  }
  return out;
}

export interface SchedulerHandle {
  tasks: Array<{ job: JobName; expression: string; task: ScheduledTask }>;
  stop(): Promise<void>;
}

type Log = Pick<Console, "info" | "warn" | "error">;

export function startScheduler(opts: { timezone?: string; log?: Log; env?: Record<string, string | undefined> } = {}): SchedulerHandle {
  const log = opts.log ?? console;
  const env = opts.env ?? process.env;
  const timezone = opts.timezone ?? env.SCHEDULER_TIMEZONE?.trim() ?? "UTC";
  const tasks = Object.entries(resolveSchedules(env)).map(([job, expression]) => {
    const name = job as JobName;
    const task = cron.schedule(
      expression,
      async () => {
        const started = Date.now();
        try {
          const run = await runJob(name, { trigger: "cron" });
          log.info(`[scheduler] ${name} ${run.status} in ${Math.round((Date.now() - started) / 1000)}s (run ${run.id})`);
        } catch (err) {
          if (err instanceof JobBusyError) log.warn(`[scheduler] ${name} skipped: ${err.message}`);
          else log.error(`[scheduler] ${name} crashed`, err);
        }
      },
      { name: `aiv:${name}`, timezone, noOverlap: true },
    );
    return { job: name, expression, task };
  });
  for (const t of tasks) log.info(`[scheduler] ${t.job.padEnd(12)} ${t.expression.padEnd(16)} next: ${t.task.getNextRun()?.toISOString() ?? "-"}`);
  return {
    tasks,
    async stop() {
      await Promise.all(tasks.map((t) => t.task.destroy()));
    },
  };
}
