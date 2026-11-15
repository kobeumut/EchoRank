import type { Prisma, Site } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { asIntegrationRecord, readIntegrationSecret, sealIntegrations } from "../secrets";
import { SYNDICATION_FREQUENCIES } from "../constants";

// Distribution settings live under `Site.settings.distribution`. Secrets (IndexNow key, Google
// service account, webhook signing secret) live in `Site.integrations` so the API masks them.

export const INTEGRATION_KEYS = {
  indexnowKey: "indexnowKey",
  googleServiceAccount: "googleServiceAccount",
  webhookSecret: "webhookSecret",
} as const;

const httpUrl = z.url({ protocol: /^https?$/ });

const webhook = z.object({
  url: httpUrl,
  /** json: structured items + JSON-LD; markdown: same envelope plus a rendered Markdown digest. */
  format: z.enum(["json", "markdown"]).default("json"),
});

export const distributionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Dispatch the queue right after a successful audit/crawl sync. */
  autoDispatch: z.boolean().default(true),
  channels: z
    .object({
      indexnow: z.boolean().default(true),
      /** Search Console sitemap submit after URL changes. Needs a service account with Owner access. */
      googleSearchConsole: z.boolean().default(false),
      /**
       * Google Indexing API. Officially supported only for JobPosting / BroadcastEvent pages,
       * so it stays opt-in.
       */
      googleIndexingApi: z.boolean().default(false),
    })
    .prefault({}),
  indexnow: z
    .object({
      endpoint: httpUrl.optional(),
      /** Custom key file location on the same host; default is https://<host>/<key>.txt */
      keyLocation: httpUrl.optional(),
    })
    .prefault({}),
  google: z
    .object({
      /** Search Console property: "sc-domain:example.com" or "https://example.com/". Default: site URL + "/". */
      property: z.string().min(1).max(300).optional(),
      /** Sitemaps to (re)submit. Default: <site>/sitemap.xml */
      sitemaps: z.array(httpUrl).max(50).optional(),
      /** Indexing API daily quota (Google default is 200 publish calls per day). */
      indexingDailyQuota: z.number().int().min(1).max(100_000).default(200),
    })
    .prefault({}),
  llms: z
    .object({
      maxProducts: z.number().int().min(0).max(5_000).default(200),
      maxPages: z.number().int().min(0).max(2_000).default(60),
      maxFaqs: z.number().int().min(0).max(1_000).default(50),
      /** Extra API / machine-readable endpoints the site exposes, listed in llms.txt. */
      apiEndpoints: z
        .array(z.object({ name: z.string().min(1).max(120), url: httpUrl, description: z.string().max(300).optional() }))
        .max(50)
        .default([]),
    })
    .prefault({}),
  syndication: z
    .object({
      frequency: z.enum(SYNDICATION_FREQUENCIES).default("weekly"),
      itemsPerPeriod: z.number().int().min(1).max(100).default(10),
      includeTypes: z.array(z.enum(["Product", "Article"])).min(1).default(["Product", "Article"]),
      /** Entity keys always included (in this order) before the rotating picks. */
      pinnedKeys: z.array(z.string().min(1)).max(100).default([]),
      webhooks: z.array(webhook).max(20).default([]),
    })
    .prefault({}),
});

export type DistributionSettings = z.infer<typeof distributionSettingsSchema>;
/** PATCH body: any subset; nested objects are merged one level deep. */
export const distributionPatchSchema = z
  .object({
    enabled: z.boolean(),
    autoDispatch: z.boolean(),
    channels: z.record(z.string(), z.unknown()),
    indexnow: z.record(z.string(), z.unknown()),
    google: z.record(z.string(), z.unknown()),
    llms: z.record(z.string(), z.unknown()),
    syndication: z.record(z.string(), z.unknown()),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

type Settings = Record<string, unknown> & { distribution?: unknown };

/** Parses stored settings, falling back to defaults (stored values were validated on write). */
export function getDistributionSettings(site: Pick<Site, "settings">): DistributionSettings {
  const raw = ((site.settings ?? {}) as Settings).distribution ?? {};
  const parsed = distributionSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : distributionSettingsSchema.parse({});
}

export async function updateDistributionSettings(site: Site, patch: z.infer<typeof distributionPatchSchema>) {
  const settings = (site.settings ?? {}) as Settings;
  const current = (settings.distribution ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    merged[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...((current[k] as object) ?? {}), ...v } : v;
  }
  const next = distributionSettingsSchema.parse(merged);
  await prisma.site.update({
    where: { id: site.id },
    data: { settings: { ...settings, distribution: next } as Prisma.InputJsonValue },
  });
  return next;
}

/** Decrypted integration secret (see lib/secrets.ts); undefined when unset. */
export function getIntegration(site: Pick<Site, "integrations">, key: string): string | undefined {
  return readIntegrationSecret(site.integrations, key);
}

/** Stores one integration secret; the whole record is re-sealed, so legacy plaintext values get encrypted too. */
export async function setIntegration(site: Site, key: string, value: string) {
  const integrations = sealIntegrations({ ...asIntegrationRecord(site.integrations), [key]: value });
  await prisma.site.update({ where: { id: site.id }, data: { integrations } });
}

/** The crawler writes Question / Person; the Prisma schema comment says FAQ / Author. Accept both. */
export const FAQ_TYPES = ["FAQ", "Question"];
export const AUTHOR_TYPES = ["Author", "Person"];
