import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { analyzeAnswer, type VisibilityModel } from "@/lib/visibility-analysis";
import { askSearchProvider, parseSearchAnswer } from "@/lib/visibility-providers";
import * as route from "@/app/api/sites/[id]/visibility/route";
import { getSiteReport } from "@/lib/services/reports";
import { ctx, req, resetDb } from "./helpers";

const siteInput = { url: "https://example.com", title: "Acme" };
const fixtures = {
  chatgpt: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "1. Acme is an option.", annotations: [{ type: "url_citation", url: "https://www.example.com/item" }] }] }] },
  gemini: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "2. Acme is an option." }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://shop.example.com/item" } }, { web: { uri: "https://other.test" } }] } }] },
  claude: { stop_reason: "end_turn", content: [{ type: "text", text: "Acme is an alternative.", citations: [{ type: "web_search_result_location", url: "https://example.com" }] }] },
  perplexity: { choices: [{ finish_reason: "stop", message: { content: "1. Another brand\n2. Acme [1]" } }], citations: ["https://example.com", "https://rival.test"] },
};

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("API_TOKEN", "test-token");
  for (const prefix of ["OPENAI", "GEMINI", "ANTHROPIC", "PERPLEXITY"]) {
    vi.stubEnv(`${prefix}_API_KEY`, "secret-not-to-leak");
    vi.stubEnv(`${prefix}_MODEL`, "test-model");
  }
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(() => prisma.$disconnect());

function post(id: string, body?: unknown, token = "test-token") {
  const request = req(`/api/sites/${id}/visibility`, { method: "POST", body });
  request.headers.set("authorization", `Bearer ${token}`);
  return route.POST(request, ctx(id));
}
const newSite = () => prisma.site.create({ data: siteInput });
function mockProviders() {
  return vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const provider: VisibilityModel = url.includes("openai.com") ? "chatgpt" : url.includes("googleapis.com") ? "gemini" : url.includes("anthropic.com") ? "claude" : "perplexity";
    return Response.json(fixtures[provider]);
  }));
}

describe("citation and recommendation evidence", () => {
  it("normalizes provider citations, subdomains, URL links, explicit ranks and candidates", () => {
    for (const provider of Object.keys(fixtures) as VisibilityModel[]) {
      const answer = parseSearchAnswer(provider, fixtures[provider]);
      expect(analyzeAnswer(answer, siteInput)).toMatchObject({ isCited: true, isMentioned: true, citationStatus: "cited" });
    }
    const result = analyzeAnswer({ text: "1. Other\n2. **Acme** — [buy](https://example.com/item).", citations: ["https://other.test", "https://other.test"] }, siteInput);
    expect(result).toMatchObject({ position: 2, competitorDomains: ["other.test"], citedUrls: ["https://example.com/item"] });
  });

  it("separates mention-only, source-only, absent, and deceptive host names", () => {
    expect(analyzeAnswer({ text: "Try Acme", citations: [] }, siteInput)).toMatchObject({ citationStatus: "mentioned", position: null });
    expect(analyzeAnswer({ text: "Nothing relevant", citations: ["https://example.com"] }, siteInput)).toMatchObject({ isCited: true, isMentioned: false, position: null });
    const fake = { text: "AcmeTools https://example.com.evil.test https://notexample.com https://example.com@evil.test", citations: ["javascript:alert(1)", "ftp://example.com", "https://evil.test/?site=example.com"] };
    expect(analyzeAnswer(fake, siteInput)).toMatchObject({ isCited: false, isMentioned: false, position: null });
    expect(analyzeAnswer({ text: "Sources:\n1. Acme", citations: [] }, siteInput).position).toBeNull();
    expect(analyzeAnswer({ text: "[1] https://example.com", citations: [] }, siteInput).position).toBeNull();
    for (const heading of ["**Sources:**", "### **References**", "__Kaynaklar:__"]) {
      expect(analyzeAnswer({ text: `${heading}\n1. [Acme](https://example.com)`, citations: [] }, siteInput).position).toBeNull();
    }
  });

  it("handles Unicode and punctuation without substring matches", () => {
    expect(analyzeAnswer({ text: "İyi seçenek: Yağ Dünyası.", citations: [] }, { ...siteInput, title: "Yağ Dünyası" }).isMentioned).toBe(true);
    expect(analyzeAnswer({ text: "Use C++ today", citations: [] }, { ...siteInput, title: "C++" }).isMentioned).toBe(true);
  });

  it("rejects empty, malformed, blocked and truncated replies rather than recording none", () => {
    for (const provider of Object.keys(fixtures) as VisibilityModel[]) expect(() => parseSearchAnswer(provider, {})).toThrow("invalid_response");
    expect(() => parseSearchAnswer("perplexity", { choices: [{ message: { content: " " } }] })).toThrow();
    expect(() => parseSearchAnswer("chatgpt", { ...fixtures.chatgpt, status: "incomplete" })).toThrow();
    expect(() => parseSearchAnswer("claude", { ...fixtures.claude, stop_reason: "max_tokens" })).toThrow();
    expect(() => parseSearchAnswer("gemini", { candidates: [{ ...fixtures.gemini.candidates[0], finishReason: "SAFETY" }] })).toThrow();
  });
});

describe("visibility API with mocked live transports and real SQLite", () => {
  it("runs all four online adapters, persists evidence, reports citation percentages", async () => {
    const site = await newSite();
    mockProviders();
    const response = await post(site.id, { queries: ["best oil"] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ attempted: 4, successful: 4, failed: 0, citationRate: 100 });
    expect(body.perModel.gemini).toEqual({ successful: 1, citationRate: 100 });
    expect(await prisma.llmVisibilityRecord.count()).toBe(4);
    expect(body.items.find((i: { model: string }) => i.model === "perplexity").record.responseMeta).toMatchObject({ isCited: true, isMentioned: true, competitorDomains: ["rival.test"] });
    const calls = vi.mocked(fetch).mock.calls;
    const requests = calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(requests[0].tools).toEqual([{ type: "web_search" }]);
    expect(requests[1].tools).toEqual([{ google_search: {} }]);
    expect(requests[2].tools[0]).toMatchObject({ name: "web_search", max_uses: 3 });
    expect(calls[3][0]).toBe("https://api.perplexity.ai/chat/completions");
    expect(JSON.stringify(requests)).not.toContain("example.com");
    expect(JSON.stringify(requests)).not.toContain("Acme");
    expect(JSON.stringify(body)).not.toContain("secret-not-to-leak");
    expect((await getSiteReport(site.id, 30)).visibility.citationRate).toBe(100);
  });

  it("deduplicates, reuses persistent cache without inflating reports, expires and refreshes", async () => {
    const site = await newSite(); mockProviders();
    const input = { queries: ["best oil", "best oil"], models: ["chatgpt", "chatgpt"] };
    expect((await (await post(site.id, input)).json()).attempted).toBe(1);
    expect((await (await post(site.id, input)).json()).items[0].cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await prisma.llmVisibilityRecord.count()).toBe(1);
    await post(site.id, { ...input, refresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    await prisma.llmVisibilityRecord.updateMany({ data: { checkedAt: new Date(Date.now() - 25 * 3600_000) } });
    await post(site.id, input);
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.stubEnv("OPENAI_MODEL", "different-model");
    await post(site.id, input);
    expect(fetch).toHaveBeenCalledTimes(4);
    await prisma.site.update({ where: { id: site.id }, data: { title: "Changed" } });
    await post(site.id, input);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("returns partial sanitized failures and never counts failures as invisible", async () => {
    const site = await newSite();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("openai.com")
      ? new Response("secret-not-to-leak", { status: 429 })
      : url.includes("googleapis.com") ? Response.json({ candidates: [] }) : Response.json(fixtures.perplexity)));
    const body = await (await post(site.id, { queries: ["best oil"] })).json();
    expect(body).toMatchObject({ successful: 1, failed: 3, citationRate: 100 });
    expect(body.items.map((i: { error?: string }) => i.error).filter(Boolean)).toEqual(["rate_limited", "invalid_response", "not_configured"]);
    expect(body.perModel.chatgpt.citationRate).toBeNull();
    expect(JSON.stringify(body)).not.toContain("secret-not-to-leak");
    expect(await prisma.llmVisibilityRecord.count()).toBe(1);
  });

  it("excludes HTTP-200 search-tool failures from persistence and scores", async () => {
    const site = await newSite();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      stop_reason: "end_turn", content: [
        { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } },
        { type: "text", text: "Search unavailable. No sources found." },
      ],
    })));
    const body = await (await post(site.id, { queries: ["q"], models: ["claude"] })).json();
    expect(body).toMatchObject({ successful: 0, failed: 1, citationRate: null });
    expect(body.items[0].error).toBe("rate_limited");
    expect(await prisma.llmVisibilityRecord.count()).toBe(0);
  });

  it("generates scoped graph/manual queries and paginates scoped history", async () => {
    const site = await newSite();
    await prisma.site.update({ where: { id: site.id }, data: { targetKeywords: ["manual query"] } });
    await prisma.graphEntity.createMany({ data: [
      { siteId: site.id, key: "a", name: "Olive oil", entityType: "Product" },
      { siteId: site.id, key: "b", name: "Natural oils", entityType: "Category" },
      { siteId: site.id, key: "c", name: "What is cold pressed?", entityType: "FAQ" },
    ] });
    const other = await prisma.site.create({ data: { url: "https://other.test", title: "Other" } });
    await prisma.graphEntity.create({ data: { siteId: other.id, key: "x", name: "Private competitor product", entityType: "Product" } });
    mockProviders();
    const body = await (await post(site.id, { models: ["gemini"] })).json();
    expect(body.attempted).toBe(4);
    const listing = await (await route.GET(req(`/?limit=1&offset=1`), ctx(site.id))).json();
    expect(listing.items).toHaveLength(1);
    expect(listing.total).toBe(4);
    expect(listing.queries).toEqual(["manual query", "Olive oil nereden satın alınır?", "En iyi Natural oils markaları hangileri?", "What is cold pressed?"]);
    expect((await (await route.GET(req("/"), ctx(other.id))).json()).total).toBe(0);
    expect((await route.GET(req("/?limit=101"), ctx(site.id))).status).toBe(400);
  });

  it("validates requests and paid access before making network calls", async () => {
    const site = await newSite(); mockProviders();
    expect((await post(site.id, { queries: ["q"] }, "wrong")).status).toBe(401);
    for (const body of ["bad json", { queries: [] }, { queries: [" "] }, { queries: Array(11).fill("q") }, { queries: ["q"], models: ["other"] }, { refresh: "true" }]) {
      expect((await post(site.id, body)).status).toBe(400);
    }
    expect((await post(site.id)).status).toBe(400);
    expect((await post("missing", { queries: ["q"] })).status).toBe(404);
    vi.stubEnv("API_TOKEN", "");
    expect((await post(site.id, { queries: ["q"] })).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("distinguishes citation-only score from legacy mention-inclusive visibility", async () => {
    const site = await newSite();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(fixtures.perplexity))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Acme has products." } }] })));
    const body = await (await post(site.id, { queries: ["one", "two"], models: ["perplexity"] })).json();
    expect(body.citationRate).toBe(50);
    const report = await getSiteReport(site.id, 30);
    expect(report.visibility).toMatchObject({ citationRate: 50, visibilityRate: 100, totalChecks: 2 });
    expect(report.visibility.perModel.perplexity).toMatchObject({ citationRate: 50, visibilityRate: 100 });
  });

  it("caps concurrency at two and releases batch lock after completion", async () => {
    const site = await newSite();
    const pending: (() => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => pending.push(() => resolve(Response.json(fixtures.perplexity))))));
    const first = post(site.id, { queries: ["one", "two", "three"], models: ["perplexity"] });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect((await post(site.id, { queries: ["q"] })).status).toBe(409);
    pending[0](); pending[1]();
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2]();
    expect((await first).status).toBe(200);
    expect((await post(site.id, { queries: ["one"], models: ["perplexity"] })).status).toBe(200);
  });
});

describe("transport boundaries", () => {
  it("sanitizes network errors, rejects oversized payloads and invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("secret-not-to-leak"))
      .mockResolvedValueOnce(new Response("x".repeat(1_000_001)))
      .mockResolvedValueOnce(new Response("not JSON")));
    await expect(askSearchProvider("chatgpt", "q")).rejects.toThrow("provider_error");
    await expect(askSearchProvider("chatgpt", "q")).rejects.toThrow("invalid_response");
    await expect(askSearchProvider("chatgpt", "q")).rejects.toThrow("invalid_response");
  });

  it("reports timeouts without persisting a false negative", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    const site = await newSite();
    const body = await (await post(site.id, { queries: ["q"], models: ["chatgpt"] })).json();
    expect(body).toMatchObject({ successful: 0, citationRate: null });
    expect(body.items[0].error).toBe("timeout");
    expect(await prisma.llmVisibilityRecord.count()).toBe(0);
  });
});
