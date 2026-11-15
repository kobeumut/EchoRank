"use client";

import { useEffect, useMemo, useState } from "react";
import { TIERS } from "@/lib/dashboard/format";
import { apiFetch, errorMessage, useApi } from "./api";
import { useSite } from "./site-shell";
import { useToast } from "./toast";
import type { ActionItem } from "./types";
import { Badge, Button, CodeBlock, cx, EmptyState, ErrorState, inputBase, Segmented, SkeletonCard } from "./ui";
import { useFormat } from "./use-format";

type StatusView = "open" | "resolved" | "dismissed";
const STATUS_QUERY: Record<StatusView, string> = { open: "open,in_progress", resolved: "resolved", dismissed: "dismissed" };

function ActionCard({ item, onStatus, busy, highlighted }: { item: ActionItem; onStatus: (status: string) => void; busy: string | null; highlighted: boolean }) {
  const { t, formatDate, tierFor, label } = useFormat();
  const { startAudit, auditActive, startingAudit } = useSite();
  const [showUrls, setShowUrls] = useState(false);
  const tier = tierFor(item.impact);
  const d = item.details ?? {};
  const snippet = d.snippet?.code ? d.snippet : null;
  const urls = d.affected_urls ?? [];

  return (
    <article
      id={item.id}
      className={cx(
        "scroll-mt-24 rounded-xl border bg-white p-5 shadow-sm transition dark:bg-zinc-900",
        highlighted ? "border-indigo-400 ring-2 ring-indigo-400/40" : "border-zinc-200 dark:border-zinc-800",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tier.tone} icon>
          {tier.label}
        </Badge>
        <Badge>{label("category", item.category)}</Badge>
        {item.effort && <Badge>{label("effort", item.effort)}</Badge>}
        {item.status === "in_progress" && <Badge tone="warning">{label("actionStatus", "in_progress")}</Badge>}
        {typeof d.expected_gain === "number" && d.expected_gain > 0 && (
          <span className="ml-auto text-xs font-medium text-[#006300] dark:text-[#0ca30c]">{t("actions.card.expectedGain", { gain: d.expected_gain.toFixed(1) })}</span>
        )}
      </div>
      <h3 className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">{item.title}</h3>
      {item.description && <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{item.description}</p>}
      {item.targetUrl && (
        <a href={item.targetUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block max-w-full truncate font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400">
          {item.targetUrl}
        </a>
      )}

      {!!d.evidence?.length && (
        <div className="mt-3">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{t("actions.card.evidence")}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
            {d.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {urls.length > 0 && (
        <div className="mt-3">
          <button type="button" className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400" aria-expanded={showUrls} onClick={() => setShowUrls((s) => !s)}>
            {showUrls ? t("actions.card.hideUrls") : t("actions.card.showUrls", { count: d.affected_count ?? urls.length })}
          </button>
          {showUrls && (
            <ul className="mt-2 max-h-40 space-y-0.5 overflow-auto rounded-lg bg-zinc-50 p-2 font-mono text-xs dark:bg-zinc-950">
              {urls.map((u) => (
                <li key={u} className="truncate">
                  <a href={u} target="_blank" rel="noopener noreferrer" className="text-zinc-700 hover:text-indigo-600 dark:text-zinc-300">
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {snippet && (
        <div className="mt-4 space-y-2">
          {snippet.instructions && <p className="text-xs text-zinc-500">📌 {snippet.instructions}</p>}
          <CodeBlock code={snippet.code!} language={snippet.language} filename={snippet.filename} />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        {item.status === "open" || item.status === "in_progress" ? (
          <>
            <Button size="sm" variant="primary" loading={busy === "resolved"} disabled={!!busy} onClick={() => onStatus("resolved")}>
              {t("actions.card.markResolved")}
            </Button>
            {item.status === "open" ? (
              <Button size="sm" loading={busy === "in_progress"} disabled={!!busy} onClick={() => onStatus("in_progress")}>
                {t("actions.card.markInProgress")}
              </Button>
            ) : (
              <Button size="sm" loading={busy === "open"} disabled={!!busy} onClick={() => onStatus("open")}>
                {t("actions.card.markOpen")}
              </Button>
            )}
            <Button size="sm" variant="ghost" loading={busy === "dismissed"} disabled={!!busy} onClick={() => onStatus("dismissed")}>
              {t("actions.card.dismiss")}
            </Button>
          </>
        ) : item.status === "resolved" ? (
          <>
            <Button size="sm" variant="primary" loading={startingAudit} disabled={auditActive} onClick={() => void startAudit()} title={t("actions.card.recheckHint")}>
              {t("actions.card.recheck")}
            </Button>
            <Button size="sm" loading={busy === "open"} disabled={!!busy} onClick={() => onStatus("open")}>
              {t("actions.card.reopen")}
            </Button>
          </>
        ) : (
          <Button size="sm" loading={busy === "open"} disabled={!!busy} onClick={() => onStatus("open")}>
            {t("actions.card.undo")}
          </Button>
        )}
        <span className="ml-auto text-xs text-zinc-400">
          {item.status === "resolved" && item.resolvedAt ? t("actions.card.resolvedOn", { date: formatDate(item.resolvedAt) }) : t("actions.card.updatedOn", { date: formatDate(item.updatedAt) })}
        </span>
      </div>
    </article>
  );
}

export function ActionsView() {
  const { t, tierFor, label } = useFormat();
  const { siteId, version, startAudit, auditActive, startingAudit } = useSite();
  const toast = useToast();
  const [statusView, setStatusView] = useState<StatusView>("open");
  const [tier, setTier] = useState<string>("all");
  const [category, setCategory] = useState("");
  const [onlySnippets, setOnlySnippets] = useState(false);
  const [busy, setBusy] = useState<{ id: string; status: string } | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const list = useApi<{ items: ActionItem[] }>(`/api/sites/${siteId}/actions?status=${STATUS_QUERY[statusView]}&limit=500`, { version });

  useEffect(() => {
    if (!list.data) return;
    const h = window.location.hash.slice(1);
    if (!h) return;
    const el = document.getElementById(h);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // Syncs with external state (URL hash) once the target card exists.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHash(h);
    }
  }, [list.data]);

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const i of items) c[i.impact] = (c[i.impact] ?? 0) + 1;
    return c;
  }, [items]);
  const categories = useMemo(() => [...new Set(items.map((i) => i.category))].sort(), [items]);
  const visible = items.filter((i) => (tier === "all" || i.impact === tier) && (!category || i.category === category) && (!onlySnippets || !!i.details?.snippet?.code));

  async function setStatus(item: ActionItem, status: string) {
    setBusy({ id: item.id, status });
    try {
      await apiFetch(`/api/sites/${siteId}/actions/${item.id}`, { method: "PATCH", json: { status } });
      const stays = STATUS_QUERY[statusView].split(",").includes(status);
      list.mutate((prev) =>
        prev && { items: stays ? prev.items.map((i) => (i.id === item.id ? { ...i, status, updatedAt: new Date().toISOString() } : i)) : prev.items.filter((i) => i.id !== item.id) },
      );
      const msgKey: Record<string, string> = {
        resolved: "actions.toast.resolved",
        in_progress: "actions.toast.inProgress",
        dismissed: "actions.toast.dismissed",
        open: "actions.toast.reopened",
      };
      toast.push("success", t(msgKey[status] ?? "actions.toast.updated"));
    } catch (err) {
      toast.push("error", errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("actions.title")}</h2>
          <p className="text-sm text-zinc-500">{t("actions.subtitle")}</p>
        </div>
        <Button onClick={() => void startAudit()} loading={startingAudit} disabled={auditActive}>
          ↻ {auditActive ? t("actions.recheckRunning") : t("actions.recheckAll")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <Segmented
          label={t("actions.filter.status")}
          value={statusView}
          onChange={(v) => {
            setStatusView(v);
            setTier("all");
          }}
          options={[
            { value: "open", label: t("actions.filter.open") },
            { value: "resolved", label: t("actions.filter.resolved") },
            { value: "dismissed", label: t("actions.filter.dismissed") },
          ]}
        />
        <Segmented
          label={t("actions.filter.priority")}
          value={tier}
          onChange={setTier}
          options={[{ value: "all", label: t("actions.filter.all"), count: counts.all ?? 0 }, ...TIERS.map((entry) => ({ value: entry.impact as string, label: tierFor(entry.impact).label, count: counts[entry.impact] ?? 0 }))]}
        />
        <select aria-label={t("actions.filter.category")} value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputBase} w-auto py-1.5 text-xs`}>
          <option value="">{t("actions.filter.allCategories")}</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {label("category", c)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={onlySnippets} onChange={(e) => setOnlySnippets(e.target.checked)} className="accent-indigo-600" />
          {t("actions.filter.onlySnippets")}
        </label>
      </div>

      {list.loading ? (
        <div className="space-y-4">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.reload()} />
      ) : !visible.length ? (
        <EmptyState icon={statusView === "open" && !items.length ? "🎉" : "∅"} title={statusView === "open" && !items.length ? t("actions.empty.noOpen") : t("actions.empty.noMatch")}>
          {statusView === "open" && !items.length ? t("actions.empty.noOpenHint") : t("actions.empty.noMatchHint")}
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {visible.map((item) => (
            <ActionCard key={item.id} item={item} highlighted={hash === item.id} busy={busy?.id === item.id ? busy.status : null} onStatus={(s) => void setStatus(item, s)} />
          ))}
        </div>
      )}
    </div>
  );
}
