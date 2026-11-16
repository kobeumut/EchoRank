// MCP tools: the platform's site data for coding agents (Claude Code, Codex, …). Thin wrappers over the same
// services the REST API uses. Only `update_action_status` and `start_audit` change anything; neither spends
// LLM money (paid visibility checks and the site assistant stay behind the REST API's token check).
import { z } from "zod";
import { ACTION_CATEGORIES, ACTION_IMPACTS, ACTION_STATUSES } from "../constants";
import { prisma } from "../db";
import { notFound } from "../http";
import { normalizeSiteUrl } from "../url";
import { listActionItems, updateActionItemStatus } from "../services/audit-results";
import { executeAudit, getAuditRunner, listAudits, startAudit } from "../services/audit";
import { listSuggestions } from "../services/autogeo-suggestions";
import { listBotSimulations } from "../services/bot-simulations";
import { getSiteGraph } from "../services/graph";
import { getSiteReport } from "../services/reports";
import { buildSiteContext } from "../services/site-context";
import { listSites } from "../services/sites";

export type ToolContext = {
  /** Runs work after the response is sent (Next `after()` over HTTP, fire-and-forget over stdio). */
  defer: (task: () => Promise<unknown>) => void;
};

type Tool<S extends z.ZodType> = {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly: boolean;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
};
const tool = <S extends z.ZodType>(t: Tool<S>) => t as unknown as Tool<z.ZodType>;

const site = z.string().trim().min(1).max(2_000).describe("Site ID, URL or domain (e.g. \"example.com\"); see list_sites");

/** Accepts a site id, a full URL or a bare domain. */
export async function resolveSite(ref: string) {
  const byId = await prisma.site.findUnique({ where: { id: ref }, select: { id: true, url: true, title: true } });
  if (byId) return byId;
  let origin: string | null = null;
  try { origin = normalizeSiteUrl(ref); } catch { /* not a URL */ }
  if (origin) {
    const hostname = new URL(origin).hostname.replace(/^www\./, "");
    const candidates = await prisma.site.findMany({ where: { url: { contains: hostname } }, select: { id: true, url: true, title: true }, take: 20 });
    const match = candidates.find((s) => new URL(s.url).hostname.replace(/^www\./, "") === hostname);
    if (match) return match;
  }
  throw notFound(`Site "${ref}"`);
}

const clipJson = (value: unknown, max: number) => {
  const text = JSON.stringify(value ?? null);
  return text.length > max ? `${text.slice(0, max)}…` : value;
};

export const TOOLS = [
  tool({
    name: "list_sites",
    title: "List tracked sites",
    description: "Lists the sites tracked by EchoRank with their latest GEO / SEO / E-E-A-T scores and open action counts. Start here to find a site's ID.",
    input: z.object({
      query: z.string().trim().max(200).optional().describe("Filter by URL or title substring"),
      limit: z.number().int().min(1).max(100).default(20),
    }).strict(),
    readOnly: true,
    run: async ({ query, limit }) => {
      const { items, total } = await listSites({ q: query, limit });
      return {
        total,
        sites: items.map((s) => ({ id: s.id, url: s.url, title: s.title, latestAudit: s.latestAudit, openActionItems: s.openActionItems })),
      };
    },
  }),
  tool({
    name: "get_site_context",
    title: "Site briefing",
    description: "Markdown briefing of everything known about a site: scores with failing checks, top open actions, crawled pages, knowledge graph, LLM visibility, competitors, AI bot access and AutoGEO suggestions. The same grounding the dashboard's site assistant uses — read it before answering questions about a site.",
    input: z.object({ site }).strict(),
    readOnly: true,
    run: async (args) => (await buildSiteContext((await resolveSite(args.site)).id)).markdown,
  }),
  tool({
    name: "get_scores",
    title: "Scores and history",
    description: "Latest GEO / SEO / E-E-A-T scores with deltas, the scoring engine's pillar metrics, score history and per-model LLM visibility rates.",
    input: z.object({ site, days: z.number().int().min(1).max(365).default(90) }).strict(),
    readOnly: true,
    run: async (args) => getSiteReport((await resolveSite(args.site)).id, args.days),
  }),
  tool({
    name: "list_actions",
    title: "Prioritized fixes",
    description: "Prioritized recommendations (the dashboard's \"What to Do?\" list), highest priority first. `details` holds the evidence, affected URLs and a ready-made snippet (JSON-LD, robots.txt, llms.txt, meta tags) with instructions — apply it in the site's codebase, then mark the action resolved with update_action_status.",
    input: z.object({
      site,
      status: z.array(z.enum(ACTION_STATUSES)).min(1).default(["open", "in_progress"]),
      category: z.enum(ACTION_CATEGORIES).optional(),
      impact: z.enum(ACTION_IMPACTS).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }).strict(),
    readOnly: true,
    run: async ({ site: ref, status, category, impact, limit }) => {
      const items = await listActionItems((await resolveSite(ref)).id, { status, category, impact, limit });
      return items.map((a) => ({
        id: a.id, title: a.title, description: a.description, category: a.category, impact: a.impact, effort: a.effort,
        status: a.status, priority: a.priority, ruleId: a.ruleId, targetUrl: a.targetUrl, details: clipJson(a.details, 12_000),
      }));
    },
  }),
  tool({
    name: "update_action_status",
    title: "Update a fix's status",
    description: "Marks an action item open, in_progress, resolved or dismissed (e.g. resolved after applying its snippet). Run start_audit afterwards to verify: a still-failing check reopens the item.",
    input: z.object({ site, actionId: z.string().min(1).max(100), status: z.enum(ACTION_STATUSES) }).strict(),
    readOnly: false,
    run: async ({ site: ref, actionId, status }) => {
      const a = await updateActionItemStatus((await resolveSite(ref)).id, actionId, status);
      return { id: a.id, title: a.title, status: a.status, resolvedAt: a.resolvedAt };
    },
  }),
  tool({
    name: "list_pages",
    title: "Crawled pages",
    description: "Technical SEO snapshot of crawled pages: HTTP status, page type, title, meta description, canonical, H1, word count, crawl depth.",
    input: z.object({
      site,
      query: z.string().trim().max(500).optional().describe("URL or title substring"),
      pageType: z.string().max(50).optional().describe("home | product | category | article | about | contact | faq | other"),
      issue: z.enum(["missing_meta", "missing_h1", "thin", "error_status"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }).strict(),
    readOnly: true,
    run: async ({ site: ref, query, pageType, issue, limit }) => {
      const siteId = (await resolveSite(ref)).id;
      const issueWhere = {
        missing_meta: { OR: [{ metaDescription: null }, { metaDescription: "" }] },
        missing_h1: { OR: [{ h1: null }, { h1: "" }] },
        thin: { wordCount: { lt: 300 } },
        error_status: { statusCode: { gte: 400 } },
      };
      const where = {
        siteId,
        ...(pageType ? { pageType } : {}),
        ...(issue ? issueWhere[issue] : {}),
        ...(query ? { AND: [{ OR: [{ url: { contains: query } }, { title: { contains: query } }] }] } : {}),
      };
      const [total, pages] = await Promise.all([
        prisma.crawledPage.count({ where }),
        prisma.crawledPage.findMany({
          where, orderBy: [{ depth: "asc" }, { url: "asc" }], take: limit,
          select: { url: true, statusCode: true, pageType: true, title: true, metaDescription: true, canonical: true, h1: true, wordCount: true, depth: true, crawledAt: true },
        }),
      ]);
      return { total, pages };
    },
  }),
  tool({
    name: "get_page",
    title: "Page details",
    description: "Everything extracted from one crawled page (headings, structured data / JSON-LD, OpenGraph, links …) plus the open actions that target it.",
    input: z.object({ site, url: z.string().min(1).max(2_000).describe("Absolute URL as listed by list_pages") }).strict(),
    readOnly: true,
    run: async ({ site: ref, url }) => {
      const siteId = (await resolveSite(ref)).id;
      const page = await prisma.crawledPage.findUnique({ where: { siteId_url: { siteId, url } } });
      if (!page) throw notFound("Crawled page");
      const actions = await prisma.actionItem.findMany({
        where: { siteId, targetUrl: url, status: { in: ["open", "in_progress"] } },
        select: { id: true, title: true, impact: true, category: true },
      });
      return { ...page, data: clipJson(page.data, 30_000), openActions: actions };
    },
  }),
  tool({
    name: "get_visibility",
    title: "LLM visibility checks",
    description: "Whether ChatGPT, Gemini, Claude and Perplexity cite or mention the site: per-model rates and the most recent checks (query, citation status, position, excerpt).",
    input: z.object({ site, days: z.number().int().min(1).max(365).default(30), limit: z.number().int().min(1).max(100).default(20) }).strict(),
    readOnly: true,
    run: async ({ site: ref, days, limit }) => {
      const siteId = (await resolveSite(ref)).id;
      const [report, checks] = await Promise.all([
        getSiteReport(siteId, days),
        prisma.llmVisibilityRecord.findMany({
          where: { siteId, checkedAt: { gte: new Date(Date.now() - days * 86_400_000) } },
          orderBy: { checkedAt: "desc" }, take: limit,
          select: { model: true, query: true, citationStatus: true, position: true, excerpt: true, checkedAt: true },
        }),
      ]);
      return { summary: report.visibility, checks };
    },
  }),
  tool({
    name: "list_content_suggestions",
    title: "AutoGEO rewrites",
    description: "AutoGEO content suggestions: block-level rewrites / insertions per page (original vs suggested snippet, unified diff, expected visibility gain), best first.",
    input: z.object({
      site,
      status: z.array(z.enum(["pending", "applied", "dismissed"])).min(1).default(["pending"]),
      pageUrl: z.string().max(2_000).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }).strict(),
    readOnly: true,
    run: async ({ site: ref, status, pageUrl, limit }) => {
      const { items, total } = await listSuggestions((await resolveSite(ref)).id, { status, pageUrl, limit, offset: 0, sort: "gain" });
      return {
        total,
        suggestions: items.map((s) => ({
          id: s.id, pageUrl: s.pageUrl, ruleType: s.ruleType, title: s.title, expectedGain: s.expectedGain, status: s.status,
          originalSnippet: s.originalSnippet, suggestedSnippet: s.suggestedSnippet, diffMarkdown: s.diffMarkdown,
        })),
      };
    },
  }),
  tool({
    name: "get_bot_access",
    title: "AI crawler access",
    description: "Latest live AI crawler test (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Applebot-Extended): per-bot blocks (WAF vendor), empty client-side-rendered shells and bot-only blocks.",
    input: z.object({ site }).strict(),
    readOnly: true,
    run: async (args) => {
      const r = await listBotSimulations((await resolveSite(args.site)).id, { limit: 100, offset: 0 });
      return { runId: r.runId, checkedAt: r.checkedAt, summary: r.summary };
    },
  }),
  tool({
    name: "get_graph_summary",
    title: "Knowledge graph summary",
    description: "Knowledge-graph statistics (entities per type, edges) and structural problems: orphan pages nobody links to and products without a category.",
    input: z.object({ site }).strict(),
    readOnly: true,
    run: async (args) => {
      const graph = await getSiteGraph((await resolveSite(args.site)).id, { limit: 2_000 });
      const orphans = graph.nodes.filter((n) => n.type === "Page" && n.inDegree === 0 && !(n.url && new URL(n.url).pathname === "/"));
      const categorized = new Set(graph.edges.filter((e) => e.type === "has_category").map((e) => e.source));
      const uncategorized = graph.nodes.filter((n) => n.type === "Product" && !categorized.has(n.id));
      return {
        stats: graph.stats,
        orphanPages: orphans.slice(0, 50).map((n) => n.url ?? n.label),
        uncategorizedProducts: uncategorized.slice(0, 50).map((n) => ({ name: n.label, url: n.url })),
      };
    },
  }),
  tool({
    name: "list_audits",
    title: "Audit history",
    description: "Recent audits with status, scores, crawl progress and whether this server runs audits itself.",
    input: z.object({ site, limit: z.number().int().min(1).max(50).default(10) }).strict(),
    readOnly: true,
    run: async ({ site: ref, limit }) => ({ runner: !!getAuditRunner(), audits: await listAudits((await resolveSite(ref)).id, limit) }),
  }),
  tool({
    name: "start_audit",
    title: "Start an audit",
    description: "Queues a new crawl + GEO audit of the live site (outbound requests to the site; no LLM cost). Poll list_audits for progress. Fails with 409 while another audit is running.",
    input: z.object({ site, maxPages: z.number().int().min(1).max(50_000).optional() }).strict(),
    readOnly: false,
    run: async ({ site: ref, maxPages }, ctx) => {
      const job = await startAudit((await resolveSite(ref)).id, { trigger: "api", maxPages });
      const runner = !!getAuditRunner();
      if (runner) ctx.defer(() => executeAudit(job));
      return {
        auditId: job.audit.id,
        crawlSessionId: job.crawlSession.id,
        execution: runner ? "started" : "queued",
        note: runner ? "Poll list_audits until the audit completes." : "No audit runner is configured on this server (GEO_AUDIT_BIN); an external worker must complete it.",
      };
    },
  }),
];

export function toolDefinitions() {
  return TOOLS.map((t) => {
    const inputSchema = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    delete inputSchema.$schema;
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema,
      annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: t.name === "start_audit" },
    };
  });
}

export const findTool = (name: string) => TOOLS.find((t) => t.name === name);
