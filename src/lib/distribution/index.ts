import { prisma } from "../db";
import { getSiteOrThrow } from "../services/sites";
import { getDistributionSettings, getIntegration, INTEGRATION_KEYS } from "./config";
import { getServiceAccount } from "./google";
import { describeKeyFile, getIndexNowKey } from "./indexnow";
import { AI_PATHS } from "./llms";
import { dispatchAllDue, dispatchSite, queueStats, syncFromCrawl } from "./queue";
import { publishSyndication } from "./syndication";

export { AI_PATHS };

/** Dashboard view: settings, readiness of each channel, queue counters and recent submissions. */
export async function getDistributionOverview(siteId: string) {
  const site = await getSiteOrThrow(siteId);
  const settings = getDistributionSettings(site);
  const key = getIndexNowKey(site);
  const [queue, recentSubmissions] = await Promise.all([
    queueStats(siteId),
    prisma.platformSubmission.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, platform: true, status: true, createdAt: true, response: true, urls: true },
    }),
  ]);
  return {
    settings,
    readiness: {
      indexnow: { enabled: settings.channels.indexnow, keyConfigured: !!key, keyFile: key ? describeKeyFile(site, key) : null },
      googleSearchConsole: { enabled: settings.channels.googleSearchConsole, serviceAccount: !!getServiceAccount(site) },
      googleIndexingApi: { enabled: settings.channels.googleIndexingApi, serviceAccount: !!getServiceAccount(site) },
      webhooks: {
        count: settings.syndication.webhooks.length,
        signed: !!getIntegration(site, INTEGRATION_KEYS.webhookSecret),
      },
    },
    outputs: Object.fromEntries(
      Object.entries(AI_PATHS).map(([name, path]) => [name, { publicPath: path, api: `/api/sites/${siteId}/ai${path}` }]),
    ),
    queue,
    recentSubmissions: recentSubmissions.map((s) => ({
      ...s,
      urlCount: Array.isArray(s.urls) ? s.urls.length : 0,
      urls: undefined,
    })),
  };
}

/** Called after a successful audit/crawl: queue changed URLs and (optionally) send right away. */
export async function onCrawlCompleted(siteId: string) {
  const site = await getSiteOrThrow(siteId);
  const settings = getDistributionSettings(site);
  if (!settings.enabled) return { sync: null, dispatch: null };
  const sync = await syncFromCrawl(siteId);
  const dispatch = settings.autoDispatch ? await dispatchSite(siteId) : null;
  return { sync, dispatch };
}

/** Periodic job (GENE-99 cron): flush due queue rows and publish due syndication periods. */
export async function runDistributionCycle(now = new Date()) {
  const dispatched = await dispatchAllDue();
  const sites = await prisma.site.findMany({ select: { id: true, settings: true } });
  const syndicated = [];
  for (const s of sites) {
    const settings = getDistributionSettings(s);
    if (!settings.enabled || !settings.syndication.webhooks.length) continue;
    syndicated.push({ siteId: s.id, ...(await publishSyndication(s.id, { now })) });
  }
  return { dispatched, syndicated };
}
