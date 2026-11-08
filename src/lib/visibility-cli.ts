import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { SearchAnswer, VisibilityModel } from "./visibility-analysis";
import { ProviderError } from "./visibility-errors";

/**
 * Key-less transport: the vendor's own agent CLI, signed in with the operator's subscription, answers the
 * query with its built-in web search. Each visibility slot maps to its vendor's CLI; perplexity has none.
 */
export const CLI_NAMES = ["claude", "codex", "agy"] as const;
export type CliName = (typeof CLI_NAMES)[number];
export const CLI_FOR: Partial<Record<VisibilityModel, CliName>> = { claude: "claude", chatgpt: "codex", gemini: "agy" };
export type CliConfig = { cli: CliName; bin: string; model?: string };

const ENV_PREFIX: Record<CliName, string> = { claude: "CLAUDE", codex: "CODEX", agy: "AGY" };
const MAX_OUTPUT = 4_000_000;
/** Wall-clock budget one batch may spend on CLI calls (two run at a time), see `cliMaxCalls`. */
const BATCH_BUDGET_MS = 400_000;

export function cliTimeoutMs() {
  const value = Number(process.env.LLM_CLI_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1_000 && value <= 300_000 ? value : 80_000;
}
/** Agent CLIs take 15–50 s per answer, so a batch is capped to keep it inside the route's duration. */
export const cliMaxCalls = () => 2 * Math.max(1, Math.floor(BATCH_BUDGET_MS / cliTimeoutMs()));

export const cliModelFromEnv = (cli: CliName) => process.env[`${ENV_PREFIX[cli]}_CLI_MODEL`]?.trim() || undefined;

/** Looks the binary up without running it (`<NAME>_CLI_BIN` may hold an absolute path). */
export function resolveCli(cli: CliName): string | null {
  const configured = process.env[`${ENV_PREFIX[cli]}_CLI_BIN`]?.trim() || cli;
  const candidates = configured.includes(path.sep)
    ? [configured]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, configured));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next candidate */ }
  }
  return null;
}

/**
 * Allow-list, not deny-list: no `*_API_KEY` (the CLI must use its subscription login, never bill an API key),
 * and no DATABASE_URL / API_TOKEN / SMTP secrets reachable by an agent that reads crawled, untrusted text.
 */
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z_]+|TERM|CODEX_HOME|CLAUDE_CONFIG_DIR|XDG_[A-Z_]+|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|ASDF_[A-Z_]+|MISE_[A-Z_]+)$/;
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && ENV_ALLOW.test(key))) as NodeJS.ProcessEnv;

/**
 * Every CLI runs headless, single turn, in an empty throw-away directory, with the tools that could touch
 * the machine switched off where the CLI allows it:
 * - claude: `--restricted` + only the WebSearch tool (no shell, files, WebFetch, MCP, skills, user settings).
 * - codex: shell tools disabled, read-only sandbox, user config ignored, native web_search on.
 * - agy: has no tool allow-list; `--sandbox` restricts terminal access and, without
 *   `--dangerously-skip-permissions`, headless runs deny anything that needs approval.
 */
function invocation({ cli, model }: CliConfig, prompt: string, cwd: string, timeoutMs: number): { args: string[]; stdin?: string } {
  switch (cli) {
    case "claude":
      return { stdin: prompt, args: ["-p", "--output-format", "json", "--no-session-persistence", "--restricted", "--strict-mcp-config", "--disable-slash-commands", ...(model ? ["--model", model] : []), "--tools", "WebSearch", "--allowedTools", "WebSearch"] };
    case "codex":
      return { stdin: prompt, args: ["--search", "exec", "--disable", "shell_tool", "--disable", "unified_exec", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--json", "-C", cwd, ...(model ? ["-m", model] : []), "-"] };
    case "agy":
      // `--print=<prompt>` keeps a prompt that starts with "-" from being read as a flag.
      return { args: [`--print=${prompt}`, "--output-format", "json", "--sandbox", "--print-timeout", `${Math.max(1, Math.floor(timeoutMs / 1000) - 2)}s`, ...(model ? ["--model", model] : [])] };
  }
}

const LIMIT = /rate.?limit|usage limit|quota|too many requests|\b429\b|overloaded/i;
const AUTH = /not logged in|log ?in|sign ?in|unauthori[sz]ed|authenticat|\b401\b/i;
function failure(text: string) {
  return new ProviderError(LIMIT.test(text) ? "rate_limited" : AUTH.test(text) ? "unauthorized" : "provider_error");
}

/** Last parsable JSON object: CLIs may print banners or warnings before the result. */
function lastJson(stdout: string): unknown {
  for (const line of stdout.split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try { return JSON.parse(line); } catch { /* keep looking */ }
  }
  throw new ProviderError("invalid_response");
}
const answer = (text: string | undefined): SearchAnswer => {
  if (!text?.trim()) throw new ProviderError("invalid_response");
  // Sources are the links inside the answer text, which `analyzeAnswer` already extracts.
  return { text, citations: [] };
};
const parse = <T extends z.ZodType>(schema: T, data: unknown): z.infer<T> => {
  const result = schema.safeParse(data);
  if (!result.success) throw new ProviderError("invalid_response");
  return result.data;
};

const claudeResult = z.object({ is_error: z.boolean().optional(), result: z.string().optional(), api_error_status: z.number().nullish(), terminal_reason: z.string().optional() });
export function parseClaudeOutput(stdout: string): SearchAnswer {
  const body = parse(claudeResult, lastJson(stdout));
  if (body.is_error || (body.terminal_reason && body.terminal_reason !== "completed")) throw failure(`${body.api_error_status ?? ""} ${body.result ?? ""}`);
  return answer(body.result);
}

const codexEvent = z.object({ type: z.string(), message: z.string().optional(), error: z.object({ message: z.string().optional() }).optional(), item: z.object({ type: z.string(), text: z.string().optional() }).optional() });
export function parseCodexOutput(stdout: string): SearchAnswer {
  let text: string | undefined;
  let completed = false;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: z.infer<typeof codexEvent>;
    try { event = codexEvent.parse(JSON.parse(line)); } catch { continue; }
    if (event.type === "error" || event.type === "turn.failed") throw failure(event.error?.message ?? event.message ?? "");
    if (event.type === "turn.completed") completed = true;
    // The final agent_message is the answer; earlier ones are progress narration ("I'll check ...").
    if (event.type === "item.completed" && event.item?.type === "agent_message") text = event.item.text;
  }
  if (!completed) throw new ProviderError("invalid_response");
  return answer(text);
}

const agyResult = z.object({ status: z.string(), response: z.string().optional(), error: z.string().optional() });
export function parseAgyOutput(stdout: string): SearchAnswer {
  const body = parse(agyResult, lastJson(stdout));
  if (body.status !== "SUCCESS") throw failure(body.error ?? "");
  return answer(body.response);
}

const PARSERS: Record<CliName, (stdout: string) => SearchAnswer> = { claude: parseClaudeOutput, codex: parseCodexOutput, agy: parseAgyOutput };

function run(bin: string, args: string[], { cwd, stdin, timeoutMs }: { cwd: string; stdin?: string; timeoutMs: number }) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    // Own process group so a timeout also takes down whatever the CLI spawned.
    const child = spawn(bin, args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const finish = (done: () => void) => { if (settled) return; settled = true; clearTimeout(timer); done(); };
    const timer = setTimeout(() => { kill(); finish(() => reject(new ProviderError("timeout"))); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT) { kill(); finish(() => reject(new ProviderError("invalid_response"))); }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < 8_000) stderr += chunk; });
    child.stdin.on("error", () => { /* the CLI exited before reading the prompt: reported through its exit */ });
    child.on("error", (error: NodeJS.ErrnoException) => finish(() => reject(new ProviderError(error.code === "ENOENT" ? "not_configured" : "provider_error"))));
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code })));
    child.stdin.end(stdin ?? "");
  });
}

export async function askCli(prompt: string, config: CliConfig): Promise<SearchAnswer> {
  const timeoutMs = cliTimeoutMs();
  const cwd = mkdtempSync(path.join(tmpdir(), "geo-cli-"));
  try {
    const { args, stdin } = invocation(config, prompt, cwd, timeoutMs);
    const { stdout, stderr, code } = await run(config.bin, args, { cwd, stdin, timeoutMs });
    if (code !== 0) {
      // Failed CLIs (claude exits 1 with an `is_error` JSON) still explain themselves on stdout or stderr.
      try { PARSERS[config.cli](stdout); } catch (error) { if (error instanceof ProviderError && error.code !== "invalid_response") throw error; }
      throw failure(stderr);
    }
    return PARSERS[config.cli](stdout);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
