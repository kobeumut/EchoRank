import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { parseAgyModels, parseCodexModels } from "@/lib/visibility-cli";
import * as settingsRoute from "@/app/api/settings/llm/route";
import * as visibilityRoute from "@/app/api/sites/[id]/visibility/route";
import * as chatRoute from "@/app/api/sites/[id]/chat/route";
import { ctx, req, resetDb } from "./helpers";

const answer = "1. Acme is an option: https://example.com/item";
const claudeOut = JSON.stringify({ is_error: false, terminal_reason: "completed", result: answer });
const codexModelsOut = `warning: banner\n${JSON.stringify({ models: [
  { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list" },
  { slug: "codex-auto-review", display_name: "Auto review", visibility: "hide" },
  { slug: "--evil", display_name: "Flag", visibility: "list" },
] })}`;
const agyModelsOut = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";

let dir: string;
const rec = (name: string) => readFileSync(path.join(dir, `${name}.rec`), "utf8");
function fakeCli(name: "claude" | "codex" | "agy", stdout: string) {
  const file = path.join(dir, name);
  writeFileSync(file, ["#!/bin/sh", `echo "ARGV:$*" > "${dir}/${name}.rec"`, "cat <<'__EOF__'", stdout, "__EOF__", ""].join("\n"));
  chmodSync(file, 0o755);
  vi.stubEnv(`${name.toUpperCase()}_CLI_BIN`, file);
}

beforeEach(async () => {
  await resetDb();
  dir = mkdtempSync(path.join(tmpdir(), "fake-cli-"));
  vi.stubEnv("API_TOKEN", "test-token");
  vi.stubEnv("LLM_TRANSPORT", "cli");
  for (const prefix of ["OPENAI", "GEMINI", "ANTHROPIC", "PERPLEXITY"]) {
    vi.stubEnv(`${prefix}_API_KEY`, "");
    vi.stubEnv(`${prefix}_MODEL`, "");
  }
  for (const name of ["CLAUDE", "CODEX", "AGY"]) {
    vi.stubEnv(`${name}_CLI_BIN`, path.join(dir, "missing", name));
    vi.stubEnv(`${name}_CLI_MODEL`, "");
  }
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
afterAll(() => prisma.$disconnect());

const sameOrigin = (request: Request) => { request.headers.set("origin", "http://localhost"); return request; };
const putSettings = (body: unknown, origin = true) => {
  const request = req("/api/settings/llm", { method: "PUT", body });
  return settingsRoute.PUT(origin ? sameOrigin(request) : request, undefined as never);
};
const getSettings = () => settingsRoute.GET(req("/api/settings/llm"), undefined as never).then((r) => r.json());
const newSite = () => prisma.site.create({ data: { url: "https://example.com", title: "Acme" } });
const runVisibility = (id: string, body: unknown, init: { token?: string; origin?: boolean } = {}) => {
  const request = req(`/api/sites/${id}/visibility`, { method: "POST", body, token: init.token });
  return visibilityRoute.POST(init.origin ? sameOrigin(request) : request, ctx(id));
};

describe("CLI model lists", () => {
  it("parse codex and agy listings, keeping listed models only", () => {
    expect(parseCodexModels(codexModelsOut)).toEqual([{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }, { id: "--evil", label: "Flag" }]);
    expect(parseAgyModels(agyModelsOut)).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    ]);
  });
});

describe("LLM settings API", () => {
  it("lists what each installed CLI offers, dropping names that could be read as flags", async () => {
    fakeCli("claude", claudeOut); fakeCli("codex", codexModelsOut); fakeCli("agy", agyModelsOut);
    const { clis } = await getSettings();
    expect(clis.map((c: { cli: string; installed: boolean }) => [c.cli, c.installed])).toEqual([["claude", true], ["codex", true], ["agy", true]]);
    expect(clis[0].options.map((o: { id: string }) => o.id)).toContain("opus");
    expect(clis[1].options).toEqual([{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }]);
    expect(rec("codex")).toContain("ARGV:debug models");
    expect(clis[2].options[0].id).toBe("gemini-3.8-flash-high");
    expect(JSON.stringify(clis)).not.toContain(dir);
  });

  it("validates and saves the per-CLI model; without a token only the dashboard may change it", async () => {
    for (const bad of [{ cliModels: { claude: "--dangerously-skip-permissions" } }, { cliModels: { claude: "a b" } }, { cliModels: { other: "x" } }]) {
      expect((await putSettings(bad)).status).toBe(400);
    }
    const saved = await (await putSettings({ cliModels: { claude: "opus", codex: "", agy: "gemini-3.8-flash-high" } })).json();
    expect(saved.clis.map((c: { model: string }) => c.model)).toEqual(["opus", "", "gemini-3.8-flash-high"]);
    vi.stubEnv("API_TOKEN", "");
    expect((await putSettings({ cliModels: { claude: "haiku" } }, false)).status).toBe(403);
    expect((await putSettings({ cliModels: { claude: "haiku" } })).status).toBe(200);
  });

  it("runs the CLI with the saved model, over the env model, and keys the cache by it", async () => {
    fakeCli("claude", claudeOut);
    vi.stubEnv("CLAUDE_CLI_MODEL", "sonnet");
    await putSettings({ cliModels: { claude: "opus" } });
    const site = await newSite();
    const body = await (await runVisibility(site.id, { queries: ["best oil"], models: ["claude"] }, { token: "test-token" })).json();
    expect(rec("claude")).toContain("--model opus");
    expect(body.items[0].record.responseMeta).toMatchObject({ transport: "cli", modelId: "cli:claude:opus" });
    const list = await (await visibilityRoute.GET(req(`/api/sites/${site.id}/visibility`), ctx(site.id))).json();
    expect(list.providers.find((p: { model: string }) => p.model === "claude")).toMatchObject({ cli: "claude", cliModel: "opus" });
  });
});

describe("model calls without API_TOKEN", () => {
  it("allows key-less CLI runs from the dashboard only, and refuses anything billed to an API key", async () => {
    vi.stubEnv("API_TOKEN", "");
    fakeCli("claude", claudeOut);
    const site = await newSite();
    const ok = await runVisibility(site.id, { queries: ["best oil"], models: ["claude"] }, { origin: true });
    expect(ok.status).toBe(200);
    expect((await ok.json()).successful).toBe(1);
    expect((await runVisibility(site.id, { queries: ["best oil"], models: ["claude"] })).status).toBe(403);

    vi.stubEnv("LLM_TRANSPORT", "auto");
    vi.stubEnv("ANTHROPIC_API_KEY", "secret");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-test");
    const paid = await runVisibility(site.id, { queries: ["best oil"], models: ["claude"] }, { origin: true });
    expect(paid.status).toBe(503);
    expect((await paid.json()).details.code).toBe("api_token_required");
    expect((await runVisibility(site.id, { queries: ["best oil"], models: ["claude"], transport: "cli" }, { origin: true })).status).toBe(200);
  });

  it("enables the site assistant for CLI models and refuses API-key questions", async () => {
    vi.stubEnv("API_TOKEN", "");
    const site = await newSite();
    const ask = (body: unknown) => chatRoute.POST(sameOrigin(req(`/api/sites/${site.id}/chat`, { method: "POST", body })), ctx(site.id));
    const options = () => chatRoute.GET(req(`/api/sites/${site.id}/chat`), ctx(site.id)).then((r) => r.json());
    expect(await options()).toMatchObject({ enabled: false, apiAllowed: false });
    fakeCli("claude", claudeOut);
    expect(await options()).toMatchObject({ enabled: true, apiAllowed: false, defaultProvider: "claude" });
    expect((await ask({ messages: [{ role: "user", content: "GEO?" }] })).status).toBe(200);
    const perplexity = { messages: [{ role: "user", content: "GEO?" }], provider: "perplexity", transport: "api" };
    expect((await (await ask(perplexity)).json()).details.code).toBe("not_configured");
    vi.stubEnv("PERPLEXITY_API_KEY", "secret");
    vi.stubEnv("PERPLEXITY_MODEL", "sonar");
    const paid = await ask(perplexity);
    expect(paid.status).toBe(503);
    expect((await paid.json()).details.code).toBe("api_token_required");
  });
});
