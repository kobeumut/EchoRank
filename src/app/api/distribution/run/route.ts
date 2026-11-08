import { handle, json } from "@/lib/http";
import { runDistributionCycle } from "@/lib/distribution";

/** Cron hook: flushes due queue rows for all sites and publishes due syndication periods. */
export const POST = handle<unknown>(async () => json(await runDistributionCycle()));
