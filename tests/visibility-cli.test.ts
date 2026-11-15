import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { cliMaxCalls, parseAgyOutput, parseClaudeOutput, parseCodexOutput } from "@/lib/visibility-cli";
import * as route from "@/app/api/sites/[id]/visibility/route";
import { ctx, req, resetDb } from "./helpers";

const answer = "1. Acme is an option: https://example.com/item\n2. Other https://other.test";
const claudeOut = JSON.stringify({ is_error: false, stop_reason: "end_turn", terminal_reason: "completed", result: answer });
const codexOut = [
  { type: "thread.started", thread_id: "t" },
  { type: "item.completed", item: { type: "agent_message", text: "I'll check the web." } },
  { type: "item.completed", item: { type: "web_search", query: "q" } },
  { type: "item.completed", item: { type: "agent_message", text: answer } },
  { type: "turn.completed", usage: {} },
].map((e) => JSON.stringify(e)).join("\n");
const agyOut = JSON.stringify({ conversation_id: "c", status: "SUCCESS", response: answer });

describe("CLI output parsers", () => {
  it("extract the final answer; links in the text become the citations", () => {
    for (const parsed of [parseClaudeOutput(claudeOut), parseCodexOutput(codexOut), parseAgyOutput(agyOut)]) {
      expect(parsed).toEqual({ text: answer, citations: [] });
    }
    // Banner lines before the JSON result are ignored.
    expect(parseClaudeOutput(`warning: update available\n${claudeOut}`).text).toBe(answer);
  });

  it("maps CLI failures to sanitized codes, never to a recorded answer", () => {
    const claude = (result: string, status: number | null = null) => () => parseClaudeOutput(JSON.stringify({ is_error: true, result, api_error_status: status }));
    expect(claude("Not logged in · Please run /login")).toThrow("unauthorized");
    expect(claude("overloaded", 429)).toThrow("rate_limited");
    expect(claude("something broke")).toThrow("provider_error");
    expect(() => parseClaudeOutput(JSON.stringify({ is_error: false, terminal_reason: "api_error", result: "x" }))).toThrow("provider_error");
    const codexFail = (message: string) => () => parseCodexOutput(JSON.stringify({ type: "turn.failed", error: { message } }));
    expect(codexFail("You've hit your usage limit")).toThrow("rate_limited");
    expect(codexFail("401 unauthorized")).toThrow("unauthorized");
    expect(() => parseAgyOutput(JSON.stringify({ status: "ERROR", response: "", error: "invalid model" }))).toThrow("provider_error");
  });

  it("rejects empty, truncated and non-JSON output", () => {
    expect(() => parseClaudeOutput("")).toThrow("invalid_response");
    expect(() => parseClaudeOutput("not json")).toThrow("invalid_response");
    expect(() => parseClaudeOutput(JSON.stringify({ is_error: false, result: "  " }))).toThrow("invalid_response");
    expect(() => parseCodexOutput(codexOut.split("\n").slice(0, 4).join("\n"))).toThrow("invalid_response");
    expect(() => parseAgyOutput(JSON.stringify({ status: "SUCCESS", response: "" }))).toThrow("invalid_response");
    expect(() => parseAgyOutput("{}")).toThrow("invalid_response");
  });
});

let dir: string;
const rec = (name: string) => readFileSync(path.join(dir, `${name}.rec`), "utf8");
const calls = (name: string) => (existsSync(path.join(dir, `${name}.calls`)) ? readFileSync(path.join(dir, `${name}.calls`), "utf8").split("\n").filter(Boolean).length : 0);

/** A stand-in executable that records argv / cwd / env / stdin, counts calls and prints canned output. */
function fakeCli(name: string, stdout: string, opts: { code?: number; sleep?: number } = {}) {
  const file = path.join(dir, name);
  writeFileSync(file, [
    "#!/bin/sh",
    `{ echo "ARGV:$*"; echo "CWD:$(pwd)"; env; echo "STDIN:"; cat; } > "${dir}/${name}.rec"`,
    `echo x >> "${dir}/${name}.calls"`,
    ...(opts.sleep ? [`sleep ${opts.sleep}`] : []),
    "cat <<'__EOF__'", stdout, "__EOF__",
    `exit ${opts.code ?? 0}`, "",
  ].join("\n"));
  chmodSync(file, 0o755);
  vi.stubEnv(`${{ claude: "CLAUDE", codex: "CODEX", agy: "AGY" }[name]}_CLI_BIN`, file);
}

beforeEach(async () => {
  await resetDb();
  dir = mkdtempSync(path.join(tmpdir(), "fake-cli-"));
  vi.stubEnv("API_TOKEN", "test-token");
  vi.stubEnv("LLM_TRANSPORT", "cli");
  // Secrets that exist in the server process: none may reach a CLI.
  vi.stubEnv("OPENAI_API_KEY", "secret-not-to-leak");
  vi.stubEnv("ANTHROPIC_API_KEY", "secret-not-to-leak");
  vi.stubEnv("DATABASE_URL", "file:./test.db");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
afterAll(() => prisma.$disconnect());

const newSite = () => prisma.site.create({ data: { url: "https://example.com", title: "Acme" } });
function post(id: string, body?: unknown) {
  const request = req(`/api/sites/${id}/visibility`, { method: "POST", body });
  request.headers.set("authorization", "Bearer test-token");
  return route.POST(request, ctx(id));
}

describe("CLI transport through the visibility API", () => {
  it("answers via claude / codex / agy without any API key and records the transport", async () => {
    fakeCli("claude", claudeOut); fakeCli("codex", codexOut); fakeCli("agy", agyOut);
    const site = await newSite();
    const body = await (await post(site.id, { queries: ["best oil"] })).json();
    expect(body).toMatchObject({ attempted: 4, successful: 3, failed: 1, citationRate: 100 });
    expect(body.items.find((i: { error?: string }) => i.error)).toMatchObject({ model: "perplexity", error: "not_configured" });
    const metas = Object.fromEntries(body.items.filter((i: { record?: unknown }) => i.record).map((i: { model: string; record: { responseMeta: unknown } }) => [i.model, i.record.responseMeta]));
    expect(metas.chatgpt).toMatchObject({ transport: "cli", modelId: "cli:codex", isCited: true, isMentioned: true });
    expect(body.items.find((i: { model: string }) => i.model === "chatgpt").record.position).toBe(1);
    expect(metas.claude).toMatchObject({ transport: "cli", modelId: "cli:claude" });
    expect(metas.gemini).toMatchObject({ transport: "cli", modelId: "cli:agy", competitorDomains: ["other.test"] });
    expect(await prisma.llmVisibilityRecord.count()).toBe(3);
  });

  it("runs each CLI locked down, in an empty directory, with a scrubbed environment", async () => {
    fakeCli("claude", claudeOut); fakeCli("codex", codexOut); fakeCli("agy", agyOut);
    const site = await newSite();
    await post(site.id, { queries: ["-- best oil"], models: ["claude", "chatgpt", "gemini"] });
    for (const name of ["claude", "codex", "agy"]) {
      const text = rec(name);
      expect(text).toContain("CWD:");
      expect(text.match(/CWD:(.*)/)![1]).toContain("geo-cli-");
      expect(text.match(/CWD:(.*)/)![1]).not.toContain(process.cwd());
      const envLines = text.split("\n").map((l) => l.split("=")[0]);
      expect(envLines).toContain("PATH");
      for (const secret of ["API_TOKEN", "DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) expect(envLines).not.toContain(secret);
      expect(text).not.toContain("secret-not-to-leak");
      // The tracked site is never part of the prompt (organic measurement).
      expect(text).not.toContain("Acme");
      expect(text).not.toContain("example.com");
    }
    expect(rec("claude")).toContain("--restricted");
    expect(rec("claude")).toContain("--tools WebSearch --allowedTools WebSearch");
    expect(rec("claude")).toMatch(/STDIN:\n-- best oil/);
    expect(rec("codex")).toContain("--search exec --disable shell_tool --disable unified_exec --ignore-user-config");
    expect(rec("codex")).toContain("-s read-only");
    expect(rec("agy")).toContain("--print=-- best oil");
    expect(rec("agy")).toContain("--sandbox");
    for (const name of ["claude", "codex", "agy"]) expect(rec(name)).not.toContain("--dangerously");
  });

  it("passes the optional per-CLI model flag", async () => {
    fakeCli("claude", claudeOut); fakeCli("codex", codexOut); fakeCli("agy", agyOut);
    vi.stubEnv("CLAUDE_CLI_MODEL", "sonnet"); vi.stubEnv("CODEX_CLI_MODEL", "gpt-x"); vi.stubEnv("AGY_CLI_MODEL", "gemini-3.8-flash-low");
    const site = await newSite();
    const body = await (await post(site.id, { queries: ["q"], models: ["claude", "chatgpt", "gemini"] })).json();
    expect(rec("claude")).toContain("--model sonnet");
    expect(rec("codex")).toContain("-m gpt-x");
    expect(rec("agy")).toContain("--model gemini-3.8-flash-low");
    expect(body.items.map((i: { record: { responseMeta: { modelId: string } } }) => i.record.responseMeta.modelId).sort())
      .toEqual(["cli:agy:gemini-3.8-flash-low", "cli:claude:sonnet", "cli:codex:gpt-x"]);
  });

  it("caches CLI answers for 24 h and never mixes them with API answers", async () => {
    fakeCli("claude", claudeOut);
    const site = await newSite();
    const input = { queries: ["best oil"], models: ["claude"] };
    expect((await (await post(site.id, input)).json()).items[0].cached).toBe(false);
    expect((await (await post(site.id, input)).json()).items[0].cached).toBe(true);
    expect(calls("claude")).toBe(1);
    await post(site.id, { ...input, refresh: true });
    expect(calls("claude")).toBe(2);
    vi.stubEnv("CLAUDE_CLI_MODEL", "opus");
    await post(site.id, input);
    expect(calls("claude")).toBe(3);
  });

  it("reports sanitized failures: logged-out CLI, non-zero exit, missing binary, timeout", async () => {
    const site = await newSite();
    fakeCli("claude", JSON.stringify({ is_error: true, result: "Not logged in · Please run /login secret-not-to-leak" }), { code: 1 });
    fakeCli("codex", "boom secret-not-to-leak", { code: 2 });
    vi.stubEnv("AGY_CLI_BIN", path.join(dir, "does-not-exist"));
    const body = await (await post(site.id, { queries: ["q"], models: ["claude", "chatgpt", "gemini"] })).json();
    expect(body.items.map((i: { error: string }) => i.error)).toEqual(["unauthorized", "provider_error", "not_configured"]);
    expect(JSON.stringify(body)).not.toContain("secret-not-to-leak");
    expect(await prisma.llmVisibilityRecord.count()).toBe(0);

    vi.stubEnv("LLM_CLI_TIMEOUT_MS", "1000");
    fakeCli("claude", claudeOut, { sleep: 5 });
    const started = Date.now();
    const slow = await (await post(site.id, { queries: ["q"], models: ["claude"] })).json();
    expect(slow.items[0].error).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await prisma.llmVisibilityRecord.count()).toBe(0);
  });

  it("limits a CLI batch to what fits the route duration before spawning anything", async () => {
    fakeCli("claude", claudeOut); fakeCli("codex", codexOut); fakeCli("agy", agyOut);
    const site = await newSite();
    const models = ["claude", "chatgpt", "gemini"];
    const queries = (n: number) => Array.from({ length: n }, (_, i) => `query ${i}`);
    expect(cliMaxCalls()).toBe(10);
    const response = await post(site.id, { queries: queries(4), models });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("at most 10 checks per run (12 requested)");
    for (const name of ["claude", "codex", "agy"]) expect(calls(name)).toBe(0);
    expect((await post(site.id, { queries: queries(3), models })).status).toBe(200);
    // The batch lock was not taken by the rejected request.
    expect((await post(site.id, { queries: queries(1), models: ["claude"], refresh: true })).status).toBe(200);
    // A slower CLI budget shrinks the cap proportionally (two calls run at a time), never below one round.
    vi.stubEnv("LLM_CLI_TIMEOUT_MS", "200000");
    expect(cliMaxCalls()).toBe(4);
    vi.stubEnv("LLM_CLI_TIMEOUT_MS", "300000");
    expect(cliMaxCalls()).toBe(2);
  });
});

describe("transport selection", () => {
  const fixtures = { chatgpt: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: answer }] }] } };

  it("auto prefers a configured API key, falls back to the CLI, and `cli` ignores keys", async () => {
    fakeCli("codex", codexOut);
    vi.stubEnv("LLM_TRANSPORT", "auto");
    vi.stubEnv("OPENAI_MODEL", "test-model");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(fixtures.chatgpt)));
    const site = await newSite();
    const input = { queries: ["best oil"], models: ["chatgpt"] };
    const viaApi = await (await post(site.id, input)).json();
    expect(viaApi.items[0].record.responseMeta).toMatchObject({ transport: "api", modelId: "test-model" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls("codex")).toBe(0);

    vi.stubEnv("OPENAI_MODEL", "");
    const viaCli = await (await post(site.id, input)).json();
    expect(viaCli.items[0].record.responseMeta).toMatchObject({ transport: "cli", modelId: "cli:codex" });

    vi.stubEnv("OPENAI_MODEL", "test-model");
    const forced = await (await post(site.id, { ...input, transport: "cli", refresh: true })).json();
    expect(forced.items[0].record.responseMeta.transport).toBe("cli");
    expect(fetch).toHaveBeenCalledTimes(1);
    const api = await (await post(site.id, { ...input, transport: "api", refresh: true })).json();
    expect(api.items[0].record.responseMeta.transport).toBe("api");
  });

  it("`api` mode never spawns a CLI; the request can override LLM_TRANSPORT; bad modes are rejected", async () => {
    fakeCli("claude", claudeOut);
    const site = await newSite();
    vi.stubEnv("LLM_TRANSPORT", "api");
    const apiOnly = await (await post(site.id, { queries: ["q"], models: ["claude"] })).json();
    expect(apiOnly.items[0].error).toBe("not_configured");
    expect(calls("claude")).toBe(0);
    expect((await (await post(site.id, { queries: ["q"], models: ["claude"], transport: "cli" })).json()).successful).toBe(1);
    expect((await post(site.id, { queries: ["q"], transport: "shell" })).status).toBe(400);
  });

  it("GET reports which transport each model would use, without keys or paths", async () => {
    fakeCli("claude", claudeOut);
    vi.stubEnv("CODEX_CLI_BIN", path.join(dir, "missing"));
    vi.stubEnv("AGY_CLI_BIN", path.join(dir, "missing"));
    vi.stubEnv("OPENAI_MODEL", "m");
    vi.stubEnv("LLM_TRANSPORT", "auto");
    const site = await newSite();
    const body = await (await route.GET(req("/"), ctx(site.id))).json();
    const by = Object.fromEntries(body.providers.map((p: { model: string }) => [p.model, p]));
    expect(by.claude).toMatchObject({ cli: "claude", resolved: { auto: "cli", api: null, cli: "cli" } });
    expect(by.chatgpt).toMatchObject({ cli: "codex", resolved: { auto: "api", api: "api", cli: null } });
    expect(by.gemini).toMatchObject({ cli: "agy", resolved: { auto: null, api: null, cli: null } });
    expect(by.perplexity).toMatchObject({ cli: null, resolved: { auto: null, api: null, cli: null } });
    expect(body).toMatchObject({ defaultTransport: "auto", limits: { cliMaxCalls: cliMaxCalls() } });
    expect(JSON.stringify(body)).not.toContain(dir);
    expect(JSON.stringify(body)).not.toContain("secret-not-to-leak");
  });
});
