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
  REPORT_FREQUENCIES,
} from "./constants";
import { normalizeSiteUrl } from "./url";
import { visibilityAnalysisSettings } from "./visibility-analysis";

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
    visibilityAnalysis: visibilityAnalysisSettings.optional(),
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

export const createScheduleSchema = z.object({
  frequency: z.enum(REPORT_FREQUENCIES),
  recipients: z.array(z.email()).max(50).default([]),
  webhookUrl: z.url().max(2048).refine((raw) => {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  }, "Webhook must be HTTPS without credentials or fragment").optional(),
  enabled: z.boolean().default(true),
}).strict().refine((v) => v.recipients.length > 0 || !!v.webhookUrl, "At least one delivery channel is required");

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

// ---- query-string helpers (GENE-109) ----
/** "a,b" -> ["a", "b"] validated against `values`; empty -> undefined. */
export const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(values)).optional());

/** "true"/"1" -> true, "false"/"0" -> false (z.coerce.boolean treats "false" as true). */
export const queryBool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
