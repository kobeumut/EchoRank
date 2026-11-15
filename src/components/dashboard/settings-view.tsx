"use client";

import { useState } from "react";
import { apiFetch, errorMessage, useApi } from "./api";
import { useToast } from "./toast";
import { Badge, Button, Card, ErrorState, Field, inputClass, SkeletonCard } from "./ui";
import { useFormat } from "./use-format";

type CliName = "claude" | "codex" | "agy";
type CliSettings = { cli: CliName; installed: boolean; model: string; envModel: string | null; options: { id: string; label: string }[]; listError: boolean };
type LlmSettings = { clis: CliSettings[] };

const CLI_INFO: Record<CliName, { title: string; column: string }> = {
  claude: { title: "Claude Code (claude)", column: "Claude" },
  codex: { title: "Codex (codex)", column: "ChatGPT" },
  agy: { title: "Antigravity (agy)", column: "Gemini" },
};
const CUSTOM = "__custom__";

function CliModelField({ cli, value, onChange }: { cli: CliSettings; value: string; onChange: (v: string) => void }) {
  const known = cli.options.some((o) => o.id === value);
  const { t } = useFormat();
  const [custom, setCustom] = useState(!!value && !known);
  const fallback = cli.envModel ? t("settings.cli.defaultEnv", { model: cli.envModel }) : t("settings.cli.defaultCli");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{CLI_INFO[cli.cli].title}</span>
        <Badge tone={cli.installed ? "good" : "warning"} icon>{cli.installed ? t("settings.cli.installed") : t("settings.cli.notFound")}</Badge>
        <span className="text-xs text-zinc-500">{t("settings.cli.answers", { column: CLI_INFO[cli.cli].column })}</span>
      </div>
      <Field
        label={t("settings.cli.model")}
        hint={cli.listError ? t("settings.cli.listError") : cli.cli === "agy" ? t("settings.cli.agyHint") : undefined}
      >
        <select
          className={inputClass}
          disabled={!cli.installed}
          value={custom ? CUSTOM : value}
          onChange={(e) => {
            const next = e.target.value;
            setCustom(next === CUSTOM);
            if (next !== CUSTOM) onChange(next);
          }}
        >
          <option value="">{fallback}</option>
          {cli.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label === o.id ? o.id : `${o.label} — ${o.id}`}
            </option>
          ))}
          <option value={CUSTOM}>{t("settings.cli.custom")}</option>
        </select>
      </Field>
      {custom && (
        <input
          className={`${inputClass} font-mono`}
          placeholder={t("settings.cli.customPlaceholder")}
          value={value}
          maxLength={100}
          onChange={(e) => onChange(e.target.value.trim())}
          aria-label={t("settings.cli.customLabel", { title: CLI_INFO[cli.cli].title })}
        />
      )}
    </div>
  );
}

export function SettingsHeader() {
  const { t } = useFormat();
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{t("settings.title")}</h1>
      <p className="mt-1 text-sm text-zinc-500">{t("settings.subtitle")}</p>
    </div>
  );
}

export function SettingsView() {
  const { t } = useFormat();
  const toast = useToast();
  const [refresh, setRefresh] = useState(0);
  const settings = useApi<LlmSettings>(`/api/settings/llm${refresh ? "?refresh=1" : ""}`, { version: refresh });
  const [draft, setDraft] = useState<Partial<Record<CliName, string>> | null>(null);
  const [saving, setSaving] = useState(false);

  if (settings.loading) return <SkeletonCard lines={6} />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => void settings.reload()} />;
  const clis = settings.data!.clis;
  const value = (cli: CliName) => draft?.[cli] ?? clis.find((c) => c.cli === cli)?.model ?? "";
  const dirty = !!draft && clis.some((c) => value(c.cli) !== c.model);

  async function save() {
    setSaving(true);
    try {
      const next = await apiFetch<LlmSettings>("/api/settings/llm", {
        method: "PUT",
        json: { cliModels: Object.fromEntries(clis.map((c) => [c.cli, value(c.cli)])) },
      });
      settings.mutate(() => next);
      setDraft(null);
      toast.push("success", t("settings.cli.saved"));
    } catch (err) {
      toast.push("error", err instanceof Error ? errorMessage(err, t) : t("settings.cli.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title={t("settings.cli.title")}
      subtitle={t("settings.cli.subtitle")}
      action={
        <Button variant="ghost" size="sm" loading={settings.refreshing} onClick={() => setRefresh((n) => n + 1)}>
          {t("settings.cli.refresh")}
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {clis.map((c) => (
          <CliModelField key={`${c.cli}:${c.model}`} cli={c} value={value(c.cli)} onChange={(v) => setDraft((d) => ({ ...d, [c.cli]: v }))} />
        ))}
      </div>
      <p className="mt-4 text-xs text-zinc-500">
        {t("settings.cli.note")}
      </p>
      <div className="mt-4 flex gap-2">
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>
          {t("settings.cli.save")}
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(null)}>
            {t("settings.cli.cancel")}
          </Button>
        )}
      </div>
    </Card>
  );
}
