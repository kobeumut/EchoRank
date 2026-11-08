import { z } from "zod";
import { VISIBILITY_MODELS, type SearchAnswer, type VisibilityModel } from "./visibility-analysis";
import { askCli, CLI_FOR, cliModelFromEnv, resolveCli, type CliName } from "./visibility-cli";
import { ProviderError } from "./visibility-errors";

export { ProviderError };

const ENV = { chatgpt: "OPENAI", gemini: "GEMINI", claude: "ANTHROPIC", perplexity: "PERPLEXITY" } as const;

/** `auto` = API when key + model are set, otherwise the vendor's CLI (claude / codex / agy) if installed. */
export const TRANSPORT_MODES = ["auto", "api", "cli"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];
export type ProviderConfig =
  | { transport: "api"; modelId: string; key: string; model: string }
  | { transport: "cli"; modelId: string; cli: CliName; bin: string; model?: string };

export function defaultTransportMode(): TransportMode {
  const value = process.env.LLM_TRANSPORT?.trim().toLowerCase();
  return value === "api" || value === "cli" ? value : "auto";
}

function apiConfig(provider: VisibilityModel): ProviderConfig | null {
  const prefix = ENV[provider];
  const key = process.env[`${prefix}_API_KEY`]?.trim();
  const model = process.env[`${prefix}_MODEL`]?.trim();
  return key && model ? { transport: "api", modelId: model, key, model } : null;
}

function cliConfig(provider: VisibilityModel): ProviderConfig | null {
  const cli = CLI_FOR[provider];
  const bin = cli && resolveCli(cli);
  if (!cli || !bin) return null;
  const model = cliModelFromEnv(cli);
  return { transport: "cli", modelId: `cli:${cli}${model ? `:${model}` : ""}`, cli, bin, model };
}

export function providerConfig(provider: VisibilityModel, mode: TransportMode = defaultTransportMode()): ProviderConfig {
  const config = mode === "api" ? apiConfig(provider) : mode === "cli" ? cliConfig(provider) : apiConfig(provider) ?? cliConfig(provider);
  if (!config) throw new ProviderError("not_configured");
  return config;
}

/** What each transport mode would use per model right now. Names only: no keys, no filesystem paths. */
export function providerAvailability() {
  const resolve = (provider: VisibilityModel, mode: TransportMode) => {
    try { return providerConfig(provider, mode).transport; } catch { return null; }
  };
  return VISIBILITY_MODELS.map((model) => ({
    model,
    cli: CLI_FOR[model] ?? null,
    resolved: { auto: resolve(model, "auto"), api: resolve(model, "api"), cli: resolve(model, "cli") },
  }));
}

const citation = z.object({ url: z.string().optional() });
const textBlock = z.object({
  type: z.string().optional(), text: z.string().optional(), content: z.unknown().optional(),
  annotations: z.array(citation).optional(), citations: z.array(citation).nullish(),
});
const responses = z.object({ status: z.string().optional(), output: z.array(z.object({
  type: z.string(), content: z.array(textBlock).optional(),
})) });
const messages = z.object({ stop_reason: z.string().nullish(), content: z.array(textBlock) });
const gemini = z.object({ candidates: z.array(z.object({
  finishReason: z.string().optional(),
  content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })) }),
  groundingMetadata: z.object({ groundingChunks: z.array(z.object({
    web: z.object({ uri: z.string() }).optional(),
  })).optional() }).optional(),
})).min(1) });
const sonar = z.object({
  choices: z.array(z.object({ finish_reason: z.string().optional(), message: z.object({ content: z.string() }) })).min(1),
  citations: z.array(z.string()).optional(),
});

export function parseSearchAnswer(provider: VisibilityModel, data: unknown): SearchAnswer {
  try {
    let text = "";
    let citations: string[] = [];
    if (provider === "chatgpt") {
      const body = responses.parse(data);
      if (body.status && body.status !== "completed") throw new Error();
      const blocks = body.output.filter((b) => b.type === "message").flatMap((b) => b.content ?? []);
      text = blocks.map((b) => b.text ?? "").join("\n");
      citations = blocks.flatMap((b) => b.annotations ?? []).flatMap((c) => c.url ? [c.url] : []);
    } else if (provider === "claude") {
      const body = messages.parse(data);
      if (body.stop_reason && body.stop_reason !== "end_turn") throw new Error();
      for (const block of body.content) {
        if (block.type !== "web_search_tool_result") continue;
        const result = z.object({ type: z.literal("web_search_tool_result_error"), error_code: z.string() }).safeParse(block.content);
        if (result.success) throw new ProviderError(result.data.error_code === "too_many_requests" ? "rate_limited" : "provider_error");
      }
      const blocks = body.content.filter((b) => b.type === "text");
      text = blocks.map((b) => b.text ?? "").join("\n");
      citations = blocks.flatMap((b) => b.citations ?? []).flatMap((c) => c.url ? [c.url] : []);
    } else if (provider === "gemini") {
      const candidate = gemini.parse(data).candidates[0];
      if (candidate.finishReason && candidate.finishReason !== "STOP") throw new Error();
      text = candidate.content.parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("\n");
      citations = (candidate.groundingMetadata?.groundingChunks ?? []).flatMap((c) => c.web ? [c.web.uri] : []);
    } else {
      const body = sonar.parse(data);
      if (body.choices[0].finish_reason && body.choices[0].finish_reason !== "stop") throw new Error();
      text = body.choices[0].message.content;
      citations = body.citations ?? [];
    }
    if (!text.trim()) throw new Error();
    return { text, citations };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("invalid_response");
  }
}

/** Same prompt for every transport. Do not insert the tracked site/brand: that would bias an organic visibility measurement. */
const searchPrompt = (query: string) => `${query}\nSearch the web for current information. Cite source URLs. If recommending alternatives, use a numbered list.`;

export async function askSearchProvider(provider: VisibilityModel, query: string, mode?: TransportMode): Promise<SearchAnswer> {
  const config = providerConfig(provider, mode);
  const prompt = searchPrompt(query);
  return config.transport === "cli" ? askCli(prompt, config) : askApi(provider, prompt, config);
}

/** Native fetch only. Never follows citation URLs or provider redirects; secrets stay server-side. */
async function askApi(provider: VisibilityModel, prompt: string, { key, model }: { key: string; model: string }): Promise<SearchAnswer> {
  let url: string;
  let body: object;
  let headers: Record<string, string> = { "content-type": "application/json" };
  switch (provider) {
    case "chatgpt":
      url = "https://api.openai.com/v1/responses";
      headers.Authorization = `Bearer ${key}`;
      body = { model, input: prompt, tools: [{ type: "web_search" }], max_output_tokens: 2000 };
      break;
    case "gemini":
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      headers["x-goog-api-key"] = key;
      body = { contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 2000 } };
      break;
    case "claude":
      url = "https://api.anthropic.com/v1/messages";
      headers = { ...headers, "x-api-key": key, "anthropic-version": "2023-06-01" };
      body = { model, max_tokens: 2000, messages: [{ role: "user", content: prompt }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] };
      break;
    case "perplexity":
      // Sonar compatibility endpoint; isolate migration to Agent API in this adapter.
      url = "https://api.perplexity.ai/chat/completions";
      headers.Authorization = `Bearer ${key}`;
      body = { model, messages: [{ role: "user", content: prompt }], max_tokens: 2000 };
  }
  const signal = AbortSignal.timeout(20_000);
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(response.status === 429 ? "rate_limited" : "provider_error");
    }
    // Bound both successful and malformed provider payloads without retaining raw provider metadata.
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError("invalid_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_000_000) { await reader.cancel(); throw new ProviderError("invalid_response"); }
      chunks.push(value);
    }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new ProviderError("invalid_response"); }
    return parseSearchAnswer(provider, data);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(signal.aborted ? "timeout" : "provider_error");
  }
}
