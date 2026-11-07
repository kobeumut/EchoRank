import { z } from "zod";
import {
  ACTION_CATEGORIES,
  ACTION_IMPACTS,
  ACTION_STATUSES,
  CRAWL_TRIGGERS,
  ENTITY_TYPES,
  REPORT_FREQUENCIES,
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
/** Integration keys: flat map of provider -> secret/config string. */
const integrations = z.record(z.string().min(1).max(64), z.string().max(2000));
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
    integrations: z.record(z.string().min(1).max(64), z.string().max(2000).nullable()),
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
  recipients: z.array(z.email()).min(1).max(50),
  enabled: z.boolean().default(true),
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
