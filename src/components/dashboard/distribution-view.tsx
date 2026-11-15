"use client";

import { useState } from "react";
import { apiFetch, errorMessage, useApi } from "./api";
import { useSite } from "./site-shell";
import { useToast } from "./toast";
import type { DistributionOverview, KeyFile, Submission } from "./types";
import { Badge, Button, Card, CodeBlock, cx, downloadText, EmptyState, ErrorState, inputClass, Segmented, Skeleton, SkeletonCard } from "./ui";
import { useFormat } from "./use-format";

/** AI output name → catalog key of its display label (unknown names are shown as-is). */
const OUTPUT_KEYS: Record<string, string> = {
  llms: "distribution.output.llms",
  llmsFull: "distribution.output.llmsFull",
  sitemap: "distribution.output.sitemap",
  rss: "distribution.output.rss",
  atom: "distribution.output.atom",
  json: "distribution.output.json",
};
/** Notification queue statuses, in column order (labels: `distribution.queue.status.<status>`). */
const QUEUE_STATUSES = ["pending", "processing", "sent", "failed", "skipped"] as const;

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50", checked ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-700")}
    >
      <span className={cx("inline-block h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

function ReadyRow({ ok, label, children }: { ok: boolean; label: string; children?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span aria-hidden className={ok ? "text-[#0ca30c]" : "text-[#d03b3b]"}>
        {ok ? "✓" : "✕"}
      </span>
      <div className="min-w-0">
        <span className="text-zinc-800 dark:text-zinc-200">{label}</span>
        {children && <div className="text-xs text-zinc-500">{children}</div>}
      </div>
    </li>
  );
}

function submissionDetail(s: Submission): string {
  const r = s.response;
  if (!r || typeof r !== "object") return "";
  const o = r as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.status === "number") parts.push(`HTTP ${o.status}`);
  if (typeof o.httpStatus === "number") parts.push(`HTTP ${o.httpStatus}`);
  if (typeof o.error === "string") parts.push(o.error);
  if (typeof o.message === "string") parts.push(o.message);
  return parts.join(" · ");
}

function LlmsPreview({ siteId, outputs, siteUrl }: { siteId: string; outputs: DistributionOverview["outputs"]; siteUrl: string }) {
  const { t } = useFormat();
  const [which, setWhich] = useState<"llms" | "llmsFull">("llms");
  const out = outputs[which] ?? { api: `/api/sites/${siteId}/ai/${which === "llms" ? "llms.txt" : "llms-full.txt"}`, publicPath: which === "llms" ? "/llms.txt" : "/llms-full.txt" };
  const file = useApi<string>(out.api, { parse: "text" });
  const filename = out.publicPath.replace(/^\//, "");
  return (
    <Card
      title={t("distribution.llms.title")}
      subtitle={t("distribution.llms.subtitle", { url: `${siteUrl}${out.publicPath}` })}
      action={
        <Segmented
          label={t("distribution.llms.file")}
          value={which}
          onChange={setWhich}
          options={[
            { value: "llms", label: "llms.txt" },
            { value: "llmsFull", label: "llms-full.txt" },
          ]}
        />
      }
    >
      {file.loading ? (
        <Skeleton className="h-64" />
      ) : file.error ? (
        <ErrorState error={file.error} onRetry={() => void file.reload()} />
      ) : !file.data?.trim() ? (
        <EmptyState title={t("distribution.llms.empty.title")}>{t("distribution.llms.empty.hint")}</EmptyState>
      ) : (
        <>
          <CodeBlock code={file.data} language="markdown" filename={filename} maxHeight="26rem" />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => downloadText(file.data!, filename, "text/markdown;charset=utf-8")}>
              {t("distribution.llms.download", { filename })}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void file.reload()} loading={file.refreshing}>
              {t("distribution.llms.regenerate")}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export function DistributionView() {
  const { t, formatDate, timeAgo, label } = useFormat();
  const { siteId, site, version } = useSite();
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const overview = useApi<DistributionOverview>(`/api/sites/${siteId}/distribution`, { version: `${version}:${tick}` });
  const [busy, setBusy] = useState<string | null>(null);
  const [urls, setUrls] = useState("");
  const refresh = () => setTick((n) => n + 1);

  async function act<T>(name: string, fn: () => Promise<T>, success: (r: T) => string) {
    setBusy(name);
    try {
      const r = await fn();
      toast.push("success", success(r));
      refresh();
    } catch (err) {
      toast.push("error", errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }

  const patch = (body: Record<string, unknown>) =>
    act("settings", () => apiFetch(`/api/sites/${siteId}/distribution`, { method: "PATCH", json: body }), () => t("distribution.toast.settingsSaved"));

  if (overview.loading)
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <SkeletonCard lines={5} />
        <SkeletonCard lines={5} />
        <SkeletonCard lines={5} />
        <SkeletonCard lines={8} className="lg:col-span-3" />
      </div>
    );
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => void overview.reload()} />;
  const o = overview.data!;
  const r = o.readiness;
  const queue = (o.queue && typeof o.queue === "object" ? o.queue : {}) as Record<string, Record<string, number>>;
  const pending = Object.values(queue).reduce((sum, s) => sum + (s.pending ?? 0) + (s.failed ?? 0), 0);
  const key = r.indexnow.keyFile as KeyFile | null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="IndexNow" subtitle={t("distribution.indexnow.subtitle")} action={<Toggle label={t("distribution.indexnow.channel")} checked={r.indexnow.enabled} disabled={busy === "settings"} onChange={(v) => void patch({ channels: { indexnow: v } })} />}>
          <ul className="space-y-2">
            <ReadyRow ok={r.indexnow.keyConfigured} label={r.indexnow.keyConfigured ? t("distribution.indexnow.keyConfigured") : t("distribution.indexnow.noKey")}>
              {key && <span className="break-all font-mono">{String(key.keyLocation ?? "")}</span>}
            </ReadyRow>
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            {!r.indexnow.keyConfigured ? (
              <Button size="sm" variant="primary" loading={busy === "key"} onClick={() => void act("key", () => apiFetch(`/api/sites/${siteId}/distribution/indexnow-key`, { method: "POST", json: {} }), () => t("distribution.toast.keyCreated"))}>
                {t("distribution.indexnow.generateKey")}
              </Button>
            ) : (
              <>
                {key && (
                  <Button size="sm" onClick={() => downloadText(key.fileContent, key.fileName)}>
                    {t("distribution.indexnow.keyFile")}
                  </Button>
                )}
                <Button
                  size="sm"
                  loading={busy === "verify"}
                  onClick={() =>
                    void act(
                      "verify",
                      () => apiFetch<{ valid: boolean; reason: string | null }>(`/api/sites/${siteId}/distribution/indexnow-key/verify`, { method: "POST" }),
                      (res) => (res.valid ? t("distribution.toast.keyVerified") : t("distribution.toast.keyInvalid", { reason: res.reason ?? t("distribution.indexnow.unknownReason") })),
                    )
                  }
                >
                  {t("distribution.indexnow.verify")}
                </Button>
              </>
            )}
          </div>
        </Card>
        <Card title="Google" subtitle={t("distribution.google.subtitle")}>
          <ul className="space-y-3">
            <li className="flex items-center justify-between gap-3">
              <ReadyRow ok={r.googleSearchConsole.serviceAccount} label="Search Console">
                {r.googleSearchConsole.serviceAccount ? t("distribution.google.accountConfigured") : t("distribution.google.accountRequired")}
              </ReadyRow>
              <Toggle label={t("distribution.google.consoleChannel")} checked={r.googleSearchConsole.enabled} disabled={busy === "settings"} onChange={(v) => void patch({ channels: { googleSearchConsole: v } })} />
            </li>
            <li className="flex items-center justify-between gap-3">
              <ReadyRow ok={r.googleIndexingApi.serviceAccount} label="Indexing API">
                {t("distribution.google.indexingNote")}
              </ReadyRow>
              <Toggle label={t("distribution.google.indexingChannel")} checked={r.googleIndexingApi.enabled} disabled={busy === "settings"} onChange={(v) => void patch({ channels: { googleIndexingApi: v } })} />
            </li>
          </ul>
        </Card>
        <Card title={t("distribution.automation.title")} subtitle={t("distribution.automation.subtitle")}>
          <ul className="space-y-3">
            <li className="flex items-center justify-between gap-3 text-sm">
              <span>{t("distribution.automation.engine")}</span>
              <Toggle label={t("distribution.automation.engine")} checked={o.settings.enabled} disabled={busy === "settings"} onChange={(v) => void patch({ enabled: v })} />
            </li>
            <li className="flex items-center justify-between gap-3 text-sm">
              <span>{t("distribution.automation.autoDispatchLabel")}</span>
              <Toggle label={t("distribution.automation.autoDispatch")} checked={o.settings.autoDispatch} disabled={busy === "settings"} onChange={(v) => void patch({ autoDispatch: v })} />
            </li>
            <ReadyRow ok={r.webhooks.count > 0} label={t("distribution.automation.webhooks", { count: r.webhooks.count })}>
              {r.webhooks.count ? (r.webhooks.signed ? t("distribution.automation.signed") : t("distribution.automation.unsigned")) : t("distribution.automation.noWebhook")}
            </ReadyRow>
          </ul>
        </Card>
      </div>

      <Card
        title={t("distribution.queue.title")}
        subtitle={pending ? t("distribution.queue.pending", { count: pending }) : t("distribution.queue.noPending")}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              loading={busy === "sync"}
              onClick={() =>
                void act(
                  "sync",
                  () => apiFetch<{ created: number; updated: number; deleted: number }>(`/api/sites/${siteId}/distribution/sync`, { method: "POST", json: { mode: "notify" } }),
                  (s) => t("distribution.toast.synced", { created: s.created, updated: s.updated, deleted: s.deleted }),
                )
              }
            >
              {t("distribution.queue.sync")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy === "dispatch"}
              onClick={() =>
                void act(
                  "dispatch",
                  () => apiFetch<{ claimed: number }>(`/api/sites/${siteId}/distribution/dispatch`, { method: "POST", json: {} }),
                  (d) => (d.claimed ? t("distribution.toast.dispatched", { count: d.claimed }) : t("distribution.toast.nothingToDispatch")),
                )
              }
            >
              {t("distribution.queue.dispatch")}
            </Button>
          </div>
        }
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            {Object.keys(queue).length ? (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-zinc-500">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">{t("distribution.queue.channel")}</th>
                    {QUEUE_STATUSES.map((s) => (
                      <th key={s} className="py-1.5 pr-2 text-right font-medium">
                        {t(`distribution.queue.status.${s}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {Object.entries(queue).map(([ch, stats]) => (
                    <tr key={ch} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-1.5 pr-3">{label("platform", ch)}</td>
                      {QUEUE_STATUSES.map((s) => (
                        <td key={s} className={cx("py-1.5 pr-2 text-right", s === "failed" && !!stats[s] && "text-red-600 dark:text-red-400")}>
                          {stats[s] ?? 0}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-zinc-500">{t("distribution.queue.empty")}</p>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const list = urls
                .split(/\s+/)
                .map((u) => u.trim())
                .filter(Boolean);
              if (!list.length) return;
              void act(
                "enqueue",
                () => apiFetch<{ accepted: number; rejected: string[] }>(`/api/sites/${siteId}/distribution/queue`, { method: "POST", json: { urls: list, reason: "updated" } }),
                (res) => {
                  setUrls("");
                  const parts = [t("distribution.toast.enqueued", { count: res.accepted })];
                  if (res.rejected?.length) parts.push(t("distribution.toast.rejected", { count: res.rejected.length }));
                  return `${parts.join(", ")}.`;
                },
              );
            }}
          >
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-500" htmlFor="enqueue-urls">
              {t("distribution.queue.manual")}
            </label>
            <textarea id="enqueue-urls" rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={t("distribution.queue.urlsPlaceholder", { url: site.url })} className={`${inputClass} mt-1 font-mono text-xs`} />
            <Button type="submit" size="sm" className="mt-2" loading={busy === "enqueue"} disabled={!urls.trim()}>
              {t("distribution.queue.enqueue")}
            </Button>
          </form>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <LlmsPreview siteId={siteId} outputs={o.outputs} siteUrl={site.url} />
        </div>
        <Card title={t("distribution.history.title")} subtitle={t("distribution.history.subtitle")} className="xl:col-span-2">
          {o.recentSubmissions.length ? (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {o.recentSubmissions.map((s) => (
                <li key={s.id} className="flex items-start gap-3 py-2 text-sm">
                  <Badge tone={s.status === "sent" ? "good" : s.status === "failed" ? "critical" : "neutral"} icon>
                    {s.status === "sent" ? t("distribution.history.sent") : s.status === "failed" ? t("distribution.history.failed") : t("distribution.history.queued")}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {label("platform", s.platform)} <span className="font-normal text-zinc-500">· {t("distribution.history.urlCount", { count: s.urlCount })}</span>
                    </div>
                    {submissionDetail(s) && <div className="truncate text-xs text-zinc-500">{submissionDetail(s)}</div>}
                  </div>
                  <span className="whitespace-nowrap text-xs text-zinc-400" title={formatDate(s.createdAt)}>
                    {timeAgo(s.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="📭" title={t("distribution.history.empty.title")} className="py-6">
              {t("distribution.history.empty.hint")}
            </EmptyState>
          )}
          <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{t("distribution.outputs.title")}</div>
            <ul className="space-y-1 text-sm">
              {Object.entries(o.outputs).map(([name, out]) => (
                <li key={name} className="flex items-center justify-between gap-2">
                  <span>{OUTPUT_KEYS[name] ? t(OUTPUT_KEYS[name]) : name}</span>
                  <a href={out.api} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400">
                    {out.publicPath} ↗
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
    </div>
  );
}
