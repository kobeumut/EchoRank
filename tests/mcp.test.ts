import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import * as route from "@/app/api/mcp/route";
import { handleMcpMessage } from "@/lib/mcp/server";
import { TOOLS } from "@/lib/mcp/tools";
import { resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

let nextId = 1;
function post(body: unknown, headers: Record<string, string> = {}) {
  return route.POST(new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}
async function rpc(method: string, params?: unknown) {
  const res = await post({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
  expect(res.status).toBe(200);
  return res.json();
}
async function call(name: string, args: Record<string, unknown>) {
  const body = await rpc("tools/call", { name, arguments: args });
  const text: string = body.result.content[0].text;
  return { isError: body.result.isError as boolean, text, data: body.result.isError ? null : (() => { try { return JSON.parse(text); } catch { return text; } })() };
}

async function seed() {
  const site = await prisma.site.create({ data: { url: "https://www.acme.test", title: "Acme", targetKeywords: ["kahve makinesi"] } });
  const audit = await prisma.geoAudit.create({
    data: {
      siteId: site.id, status: "completed", geoScore: 62, seoScore: 70, eeatScore: 55, completedAt: new Date(),
      metrics: { pillars: { schema: { key: "schema", label: "Schema kapsamı", score: 40, weight: 0.25, checks: [{ id: "faq", label: "FAQPage şeması", score: 10, passed: false, applicable: true, detail: "Soru-cevap sayfalarında FAQPage yok", urls: ["https://www.acme.test/sss"] }] } } },
    },
  });
  const action = await prisma.actionItem.create({
    data: {
      siteId: site.id, auditId: audit.id, title: "FAQPage şeması ekle", category: "schema", impact: "high", priority: 9, targetUrl: "https://www.acme.test/sss",
      details: { snippet: { language: "json", code: "{\"@type\":\"FAQPage\"}", instructions: "<head> içine ekleyin" } },
    },
  });
  await prisma.actionItem.create({ data: { siteId: site.id, title: "Düşük öncelik", category: "content", impact: "low", priority: 1 } });
  await prisma.crawledPage.createMany({
    data: [
      { siteId: site.id, url: "https://www.acme.test/", title: "Acme", metaDescription: "Kahve", h1: "Acme", wordCount: 800, statusCode: 200, pageType: "home" },
      { siteId: site.id, url: "https://www.acme.test/sss", title: "SSS", wordCount: 120, statusCode: 200, pageType: "faq", depth: 1, data: { jsonld: [] } },
    ],
  });
  return { site, action };
}

describe("MCP Streamable HTTP endpoint", () => {
  it("negotiates the protocol version and advertises tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echorank" } });
    expect(init.result.instructions).toContain("list_sites");
    // Unknown version -> the server's latest.
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-11-25");

    const { result } = await rpc("tools/list");
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.$schema).toBeUndefined();
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
    }
    const writes = result.tools.filter((t: { annotations: { readOnlyHint: boolean } }) => !t.annotations.readOnlyHint).map((t: { name: string }) => t.name);
    expect(writes.sort()).toEqual(["start_audit", "update_action_status"]);
  });

  it("acknowledges notifications with 202, handles batches, ping and protocol errors", async () => {
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");

    const batch = await post([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(await batch.json()).toEqual([{ jsonrpc: "2.0", id: "a", result: {} }]);

    const parse = await post("{nope");
    expect(parse.status).toBe(400);
    expect((await parse.json()).error.code).toBe(-32700);

    expect((await rpc("resources/list")).error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "nope", arguments: {} })).error.code).toBe(-32602);
    expect((await rpc("tools/call", { name: "list_sites", arguments: "x" })).error.code).toBe(-32602);
    expect(await handleMcpMessage({ id: 1, method: "ping" }, { defer: () => {} })).toMatchObject({ error: { code: -32600 } });
  });

  it("rejects cross-origin browser requests and has no GET stream", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    const same = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "http://localhost" });
    expect(same.status).toBe(200);
    expect(route.GET().status).toBe(405);
  });
});

describe("MCP tools", () => {
  it("lists sites and resolves a site by id, URL or bare domain", async () => {
    const { site } = await seed();
    const list = await call("list_sites", {});
    expect(list.data.sites).toEqual([expect.objectContaining({ id: site.id, url: site.url, openActionItems: 2 })]);
    for (const ref of [site.id, "acme.test", "https://acme.test/some/page", "www.acme.test"]) {
      const scores = await call("get_scores", { site: ref });
      expect(scores.isError).toBe(false);
      expect(scores.data.scores.geo).toBe(62);
    }
    const missing = await call("get_scores", { site: "other.test" });
    expect(missing).toMatchObject({ isError: true, text: expect.stringContaining("not found") });
  });

  it("returns the Markdown site briefing", async () => {
    await seed();
    const { isError, text } = await call("get_site_context", { site: "acme.test" });
    expect(isError).toBe(false);
    expect(text).toContain("# Acme (https://www.acme.test)");
    expect(text).toContain("GEO 62");
    // The digest frame is English; the seeded check/action titles are stored text and keep their own (Turkish) language.
    expect(text).toContain("FAILED FAQPage şeması");
    expect(text).toContain("FAQPage şeması ekle");
    expect(text).toContain("kahve makinesi");
    expect(text).toMatch(/2 pages; missing meta description 1, missing H1 1/);
  });

  it("lists actions with snippets in priority order and updates their status", async () => {
    const { site, action } = await seed();
    const actions = await call("list_actions", { site: site.id });
    expect(actions.data.map((a: { title: string }) => a.title)).toEqual(["FAQPage şeması ekle", "Düşük öncelik"]);
    expect(actions.data[0].details.snippet.code).toContain("FAQPage");
    expect((await call("list_actions", { site: site.id, impact: "low" })).data).toHaveLength(1);

    const updated = await call("update_action_status", { site: site.id, actionId: action.id, status: "resolved" });
    expect(updated.data).toMatchObject({ id: action.id, status: "resolved" });
    expect(updated.data.resolvedAt).toBeTruthy();
    expect((await call("list_actions", { site: site.id })).data).toHaveLength(1);
    expect((await call("list_actions", { site: site.id, status: ["resolved"] })).data[0].id).toBe(action.id);
  });

  it("filters pages by issue and returns page details with the actions targeting it", async () => {
    const { site, action } = await seed();
    const thin = await call("list_pages", { site: site.id, issue: "thin" });
    expect(thin.data).toMatchObject({ total: 1, pages: [{ url: "https://www.acme.test/sss" }] });
    expect((await call("list_pages", { site: site.id, query: "sss" })).data.total).toBe(1);
    const page = await call("get_page", { site: site.id, url: "https://www.acme.test/sss" });
    expect(page.data.openActions).toEqual([expect.objectContaining({ id: action.id })]);
    expect((await call("get_page", { site: site.id, url: "https://www.acme.test/x" })).isError).toBe(true);
  });

  it("reports invalid arguments as tool errors the model can read", async () => {
    const { site } = await seed();
    const bad = await call("list_actions", { site: site.id, limit: "many" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("limit");
    expect((await call("list_actions", { site: site.id, extra: 1 })).isError).toBe(true);
  });

  it("queues an audit without a runner and refuses a second one", async () => {
    const { site } = await seed();
    const deferred: unknown[] = [];
    const started = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start_audit", arguments: { site: site.id } } },
      { defer: (task) => deferred.push(task) },
    );
    const data = JSON.parse((started as { result: { content: { text: string }[] } }).result.content[0].text);
    expect(data.execution).toBe("queued");
    expect(deferred).toHaveLength(0);
    const again = await call("start_audit", { site: site.id });
    expect(again).toMatchObject({ isError: true, text: expect.stringContaining("already in progress") });
    const audits = await call("list_audits", { site: site.id });
    expect(audits.data.runner).toBe(false);
    expect(audits.data.audits[0].id).toBe(data.auditId);
  });

  it("summarizes empty visibility, bot and graph data without failing", async () => {
    const { site } = await seed();
    expect((await call("get_visibility", { site: site.id })).data).toMatchObject({ summary: { totalChecks: 0 }, checks: [] });
    expect((await call("get_bot_access", { site: site.id })).data).toEqual({ runId: null, checkedAt: null, summary: null });
    expect((await call("get_graph_summary", { site: site.id })).data.stats.totalEntities).toBe(0);
    expect((await call("list_content_suggestions", { site: site.id })).data).toEqual({ total: 0, suggestions: [] });
  });
});
