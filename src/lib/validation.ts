import { z } from "zod";
import {
  ACTION_CATEGORIES,
  ACTION_IMPACTS,
  ACTION_STATUSES,
  CHANGE_REASONS,
  CRAWL_TRIGGERS,
  ENTITY_TYPES,
  QUEUE_CHANNELS,
  QUEUE_STATUSES,
  JOB_NAMES,
  REPORT_FORMATS,
  REPORT_FREQUENCIES,
  SNAPSHOT_KINDS,
  WEBHOOK_TYPES,
} from "./constants";
import { normalizeSiteUrl } from "./url";

const siteUrl = z.string().transform((value, ctx) => {
  try {
    return normalizeSiteUrl(value);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

const keywords = z.array(z.string().trim().min(1).max(200)).max(500);
/** Integration keys: flat map of provider -> secret/config string (10k fits a Google service-account JSON). */
const INTEGRATION_VALUE_MAX = 10_000;
const integrations = z.record(z.string().min(1).max(64), z.string().max(INTEGRATION_VALUE_MAX));
const settings = z
  .object({
    maxPages: z.number().int().min(1).max(50_000).optional(),
    maxDepth: z.number().int().min(0).max(20).optional(),
    locale: z.string().max(20).optional(),
    respectRobotsTxt: z.boolean().optional(),
  })
  .catchall(z.unknown());

export const createSiteSchema = z.object({
  url: siteUrl,
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  settings: settings.optional(),
  targetKeywords: keywords.optional(),
  integrations: integrations.optional(),
});

export const updateSiteSchema = z
  .object({
    url: siteUrl,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable(),
    settings,
    targetKeywords: keywords,
    /** Merged into existing integrations; a null value removes that key. */
    integrations: z.record(z.string().min(1).max(64), z.string().max(INTEGRATION_VALUE_MAX).nullable()),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

export const startAuditSchema = z
  .object({
    trigger: z.enum(CRAWL_TRIGGERS).default("api"),
    maxPages: z.number().int().min(1).max(50_000).optional(),
    maxDepth: z.number().int().min(0).max(20).optional(),
  })
  .default({ trigger: "api" });

export const graphQuerySchema = z.object({
  types: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(ENTITY_TYPES)).optional()),
  limit: z.coerce.number().int().min(1).max(10_000).default(2_000),
});

export const reportQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/** Report / alert webhook: Slack incoming webhook, Discord webhook or any JSON endpoint. */
export const webhookTargetSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2_048),
  /** Auto-detected from the URL (hooks.slack.com, discord.com/api/webhooks) when omitted. */
  type: z.enum(WEBHOOK_TYPES).optional(),
});

const scheduleFields = {
  frequency: z.enum(REPORT_FREQUENCIES),
  recipients: z.array(z.email()).max(50),
  webhooks: z.array(webhookTargetSchema).max(10),
  /** Push anomaly alerts (sudden drops, competitor surges) to the same channels right away. */
  alerts: z.boolean(),
  enabled: z.boolean(),
};

export const createScheduleSchema = z
  .object({
    frequency: scheduleFields.frequency,
    recipients: scheduleFields.recipients.default([]),
    webhooks: scheduleFields.webhooks.default([]),
    alerts: scheduleFields.alerts.default(true),
    enabled: scheduleFields.enabled.default(true),
  })
  .refine((v) => v.recipients.length + v.webhooks.length > 0, {
    message: "Provide at least one e-mail recipient or webhook",
    path: ["recipients"],
  });

export const updateScheduleSchema = z
  .object(scheduleFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

export const sendReportSchema = z
  .object({
    /** Simulate every channel (no e-mail / webhook leaves the server). */
    dryRun: z.boolean().default(false),
    /** Re-send to targets that already received this period. */
    force: z.boolean().default(false),
  })
  .default({ dryRun: false, force: false });

export const reportSummaryQuerySchema = z.object({
  frequency: z.enum(REPORT_FREQUENCIES).default("weekly"),
  format: z.enum(REPORT_FORMATS).default("json"),
  download: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export const trendQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(730).default(90),
  kind: z.enum(SNAPSHOT_KINDS).optional(),
});

export const runJobSchema = z.object({
  job: z.enum(JOB_NAMES),
  dryRun: z.boolean().default(false),
  /** Restrict site-level jobs to one site. */
  siteId: z.string().min(1).max(64).optional(),
});

export const jobListQuerySchema = z.object({
  job: z.enum(JOB_NAMES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const actionItemSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  category: z.enum(ACTION_CATEGORIES),
  impact: z.enum(ACTION_IMPACTS),
  status: z.enum(ACTION_STATUSES).default("open"),
  targetUrl: z.string().url().optional(),
});

export type CreateSiteInput = z.infer<typeof createSiteSchema>;
export type UpdateSiteInput = z.infer<typeof updateSiteSchema>;
export type StartAuditInput = z.infer<typeof startAuditSchema>;

// ---- AI distribution (GENE-97) ----
export const enqueueUrlsSchema = z.object({
  urls: z.array(z.string().min(1).max(2_048)).min(1).max(10_000),
  reason: z.enum(CHANGE_REASONS).default("updated"),
  channels: z.array(z.enum(QUEUE_CHANNELS)).min(1).optional(),
});

export const queueQuerySchema = z.object({
  status: z.enum(QUEUE_STATUSES).optional(),
  channel: z.enum(QUEUE_CHANNELS).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(100),
});

export const syncSchema = z.object({ mode: z.enum(["notify", "baseline"]).default("notify") }).default({ mode: "notify" });
export const dispatchSchema = z.object({ limit: z.number().int().min(1).max(10_000).optional() }).default({});
export const rotateKeySchema = z.object({ rotate: z.boolean().default(false) }).default({ rotate: false });
export const syndicateSchema = z.object({ force: z.boolean().default(false) }).default({ force: false });
