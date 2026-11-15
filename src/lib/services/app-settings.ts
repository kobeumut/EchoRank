// Server-wide dashboard settings (AppSetting rows). `llm` holds the model each agent CLI runs with; it wins over
// `<NAME>_CLI_MODEL` from the environment, and an empty value falls back to that env var, then the CLI's default.
import { z } from "zod";
import { prisma } from "../db";
import { CLI_MODEL_PATTERN, CLI_NAMES, cliModelFromEnv, listCliModels, resolveCli, type CliModelOption, type CliModels, type CliName } from "../visibility-cli";

const LLM_KEY = "llm";
const cliModel = z.union([z.literal(""), z.string().trim().regex(CLI_MODEL_PATTERN, "Invalid model name")]);

export const llmSettingsInput = z.object({
  cliModels: z.object({ claude: cliModel.optional(), codex: cliModel.optional(), agy: cliModel.optional() }).strict(),
}).strict();

const stored = z.object({ cliModels: z.record(z.string(), z.unknown()).optional() }).passthrough();

/** Saved per-CLI models; malformed or unsafe rows are ignored rather than passed to a CLI. */
export async function getCliModels(): Promise<CliModels> {
  const row = await prisma.appSetting.findUnique({ where: { key: LLM_KEY } });
  const parsed = stored.safeParse(row?.value);
  const models: CliModels = {};
  for (const cli of CLI_NAMES) {
    const value = parsed.success ? parsed.data.cliModels?.[cli] : undefined;
    if (typeof value === "string" && CLI_MODEL_PATTERN.test(value)) models[cli] = value;
  }
  return models;
}

export async function saveLlmSettings(input: z.infer<typeof llmSettingsInput>) {
  const cliModels = Object.fromEntries(Object.entries(input.cliModels).filter(([, v]) => v)) as CliModels;
  await prisma.appSetting.upsert({ where: { key: LLM_KEY }, create: { key: LLM_KEY, value: { cliModels } }, update: { value: { cliModels } } });
  return getLlmSettings();
}

// Listing spawns the CLI (codex prints ~600 KB), so lists are cached per binary for a while.
const LIST_TTL_MS = 10 * 60 * 1000;
const listCache = new Map<string, { at: number; options: Promise<CliModelOption[]> }>();
function cachedModels(cli: CliName, bin: string, refresh: boolean) {
  const key = `${cli}:${bin}`;
  const hit = listCache.get(key);
  if (hit && !refresh && Date.now() - hit.at < LIST_TTL_MS) return hit.options;
  const options = listCliModels(cli, bin);
  listCache.set(key, { at: Date.now(), options });
  options.catch(() => listCache.delete(key));
  return options;
}

/** Per CLI: installed or not, the saved choice, the env fallback and the models it offers. Names only, no paths. */
export async function getLlmSettings({ refresh = false } = {}) {
  const saved = await getCliModels();
  const clis = await Promise.all(CLI_NAMES.map(async (cli) => {
    const bin = resolveCli(cli);
    let options: CliModelOption[] = [];
    let listError = false;
    if (bin) {
      try { options = await cachedModels(cli, bin, refresh); } catch { listError = true; }
    }
    return { cli, installed: !!bin, model: saved[cli] ?? "", envModel: cliModelFromEnv(cli) ?? null, options, listError };
  }));
  return { clis };
}
