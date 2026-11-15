"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { markdownToHtml } from "@/lib/autogeo/markdown";
import type { Translator } from "@/lib/i18n/translate";
import {
  addedSignals,
  collectCapsules,
  collectTables,
  IMPACTS,
  impactLabel,
  impactOfGain,
  pagePath,
  ruleTypeLabel,
  signalLabel,
  simulateScore,
  STUDIO_RULE_TYPES,
  suggestionStatusLabel,
  placeholderCount,
  type Impact,
  type SignalTag,
} from "@/lib/dashboard/autogeo-studio";
import { scoreTone } from "@/lib/dashboard/format";
import { apiFetch, ApiError, errorMessage, useApi } from "./api";
import { rich } from "./rich-text";
import { useSite } from "./site-shell";
import { CapsuleGrid, TableList } from "./studio-capsules";
import { DiffViewer, SignalLegend, TAG_SWATCH, type DiffMode } from "./studio-diff";
import { useToast } from "./toast";
import type { AutoGeoOverview, AutoGeoSuggestionRow, CmsApplyResult } from "./types";
import { Badge, Button, copyText, cx, EmptyState, ErrorState, inputBase, Segmented, Skeleton, SkeletonCard, TONE_COLOR } from "./ui";
import { useFormat } from "./use-format";

type StatusView = "pending" | "applied" | "dismissed" | "all";
type Tab = "diff" | "capsules" | "tables";

const STATUS_TONE: Record<string, "good" | "neutral" | "warning"> = { applied: "good", dismissed: "neutral", pending: "warning" };

// ---------------------------------------------------------------- simulator

function ScoreSimulator({
  sim,
  maxProjected,
  selectedCount,
  pendingCount,
  onSelectAll,
  onClear,
}: {
  sim: ReturnType<typeof simulateScore>;
  maxProjected: number;
  selectedCount: number;
  pendingCount: number;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const { t } = useFormat();
  const tone = scoreTone(sim.projected);
  const total = Math.round((sim.projected - sim.current) * 10) / 10;
  return (
    <section aria-label={t("studio.sim.aria")} className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t("studio.sim.title")}</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{t("studio.sim.intro")}</p>
        </div>
        <span aria-live="polite" className={cx("rounded-lg px-2.5 py-1 text-lg font-bold tabular-nums", total > 0 ? "bg-emerald-50 text-[#006300] dark:bg-emerald-950/50 dark:text-[#0ca30c]" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800")}>
          +{total.toFixed(1)}
        </span>
      </header>

      <div className="mt-4 flex items-baseline gap-2 tabular-nums">
        <span className="text-3xl font-bold" style={{ color: TONE_COLOR[tone] }}>
          {sim.projected.toFixed(1)}
        </span>
        <span className="text-sm text-zinc-500">{t("studio.sim.outOf", { current: sim.current.toFixed(1) })}</span>
      </div>

      {/* stacked progress: current | applied (awaiting re-audit) | selected; ghost = all pending */}
      <div
        className="relative mt-3 h-3 overflow-hidden rounded-full bg-[var(--chart-grid)]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={sim.projected}
        aria-label={t("studio.sim.meterLabel", { score: sim.projected })}
      >
        <div className="absolute inset-y-0 left-0 bg-zinc-300/70 dark:bg-zinc-700/70" style={{ width: `${maxProjected}%` }} />
        <div className="absolute inset-y-0 left-0 bg-zinc-500 dark:bg-zinc-400" style={{ width: `${sim.current}%`, transition: "width 400ms ease" }} />
        <div className="absolute inset-y-0 bg-emerald-300 dark:bg-emerald-700" style={{ left: `${sim.current}%`, width: `${sim.appliedGain}%`, transition: "all 400ms ease" }} />
        <div className="absolute inset-y-0 bg-emerald-600 dark:bg-emerald-400" style={{ left: `${sim.withApplied}%`, width: `${sim.selectedGain}%`, transition: "all 400ms ease" }} />
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="flex items-center gap-1 text-zinc-500">
            <span aria-hidden className="h-2 w-2 rounded-sm bg-zinc-500" /> {t("studio.sim.current")}
          </dt>
          <dd className="font-semibold tabular-nums">{sim.current.toFixed(1)}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-zinc-500">
            <span aria-hidden className="h-2 w-2 rounded-sm bg-emerald-300 dark:bg-emerald-700" /> {t("studio.sim.applied")}
          </dt>
          <dd className="font-semibold tabular-nums">+{sim.appliedGain.toFixed(1)}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-zinc-500">
            <span aria-hidden className="h-2 w-2 rounded-sm bg-emerald-600 dark:bg-emerald-400" /> {t("studio.sim.selected")}
          </dt>
          <dd className="font-semibold tabular-nums">+{sim.selectedGain.toFixed(1)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-zinc-500">{t("studio.sim.allPending", { value: maxProjected.toFixed(1) })}</p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" onClick={onSelectAll} disabled={!pendingCount}>
          {t("studio.sim.selectVisible")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClear} disabled={!selectedCount}>
          {t("studio.sim.clear", { count: selectedCount })}
        </Button>
      </div>

      {sim.pages.length > 0 && (
        <ul className="mt-4 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          {sim.pages.slice(0, 6).map((p) => (
            <li key={p.url} className="text-xs">
              <div className="flex justify-between gap-2">
                <span className="truncate font-mono text-zinc-600 dark:text-zinc-400" title={p.url}>
                  {pagePath(p.url)}
                </span>
                <span className="shrink-0 tabular-nums">
                  {p.current.toFixed(0)} → <b>{p.projected.toFixed(0)}</b>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] leading-snug text-zinc-400">
        {t("studio.sim.note")}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- suggestion card

function SuggestionCard({
  s,
  expanded,
  onToggle,
  selected,
  onSelect,
  mode,
  busy,
  onStatus,
  onApplyCms,
}: {
  s: AutoGeoSuggestionRow;
  expanded: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: (v: boolean) => void;
  mode: DiffMode;
  busy: string | null;
  onStatus: (status: "applied" | "dismissed" | "pending") => void;
  onApplyCms: () => void;
}) {
  const { t, intlLocale, formatDate } = useFormat();
  const toast = useToast();
  const impact = impactOfGain(s.expectedGain);
  const tier = IMPACTS.find((i) => i.value === impact)!;
  const signals = useMemo(() => addedSignals(s.originalSnippet, s.suggestedSnippet), [s.originalSnippet, s.suggestedSnippet]);
  const html = useMemo(() => (expanded ? markdownToHtml(s.suggestedSnippet) : ""), [expanded, s.suggestedSnippet]);
  const placeholders = placeholderCount(s.suggestedSnippet);
  const copy = async (text: string, what: string) => {
    const ok = await copyText(text);
    toast.push(ok ? "success" : "error", ok ? t("studio.toast.copied", { what }) : t("studio.toast.copyFailed"));
  };

  return (
    <article
      id={`s-${s.id}`}
      className={cx(
        "rounded-xl border bg-white shadow-sm transition dark:bg-zinc-900",
        expanded ? "border-indigo-300 ring-1 ring-indigo-300/50 dark:border-indigo-700" : "border-zinc-200 dark:border-zinc-800",
        s.status === "dismissed" && "opacity-70",
      )}
    >
      <div className="flex items-start gap-3 p-4">
        {s.status === "pending" && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(e.target.checked)}
            aria-label={t("studio.card.include")}
            title={t("studio.card.includeTitle")}
            className="mt-1 h-4 w-4 shrink-0 accent-indigo-600"
          />
        )}
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={tier.tone} icon>
              {t("studio.card.impact", { impact: impactLabel(t, tier.value) })}
            </Badge>
            <Badge>{ruleTypeLabel(t, s.ruleType)}</Badge>
            {s.status !== "pending" && <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{suggestionStatusLabel(t, s.status)}</Badge>}
            {placeholders > 0 && <Badge tone="warning">{t("studio.card.fieldsToFill", { count: placeholders })}</Badge>}
            <span className="ml-auto text-xs font-semibold tabular-nums text-[#006300] dark:text-[#0ca30c]">{t("studio.card.gain", { gain: s.expectedGain.toFixed(1) })}</span>
          </div>
          <h3 className="mt-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{s.title ?? ruleTypeLabel(t, s.ruleType, "")}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span className="truncate font-mono" title={s.pageUrl}>
              {pagePath(s.pageUrl)}
            </span>
            {(Object.keys(signals) as SignalTag[])
              .filter((tag) => tag !== "placeholder" && signals[tag] > 0)
              .map((tag) => (
                <span key={tag} className={cx("px-0.5", TAG_SWATCH[tag])}>
                  +{signals[tag]} {signalLabel(t, tag).toLocaleLowerCase(intlLocale)}
                </span>
              ))}
          </div>
        </button>
        <span aria-hidden className={cx("mt-1 text-zinc-400 transition-transform", expanded && "rotate-180")}>
          ▾
        </span>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-zinc-100 p-4 dark:border-zinc-800">
          <DiffViewer original={s.originalSnippet} suggested={s.suggestedSnippet} mode={mode} />
          <SignalLegend />
          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <Button size="sm" onClick={() => void copy(s.suggestedSnippet, "Markdown")}>
              {t("studio.card.copyMarkdown")}
            </Button>
            <Button size="sm" onClick={() => void copy(html, "HTML")}>
              {t("studio.card.copyHtml")}
            </Button>
            {s.diffMarkdown && (
              <Button size="sm" variant="ghost" onClick={() => void copy(s.diffMarkdown!, t("studio.toast.whatDiff"))}>
                {t("studio.card.copyDiff")}
              </Button>
            )}
            <span className="mx-1 hidden h-5 w-px bg-zinc-200 sm:block dark:bg-zinc-700" />
            {s.status === "pending" ? (
              <>
                <Button size="sm" variant="primary" loading={busy === "cms"} disabled={!!busy} onClick={onApplyCms} title={t("studio.card.applyCmsTitle")}>
                  {t("studio.card.applyCms")}
                </Button>
                <Button size="sm" loading={busy === "applied"} disabled={!!busy} onClick={() => onStatus("applied")}>
                  {t("studio.card.markApplied")}
                </Button>
                <Button size="sm" variant="ghost" loading={busy === "dismissed"} disabled={!!busy} onClick={() => onStatus("dismissed")}>
                  {t("studio.card.dismiss")}
                </Button>
              </>
            ) : (
              <Button size="sm" loading={busy === "pending"} disabled={!!busy} onClick={() => onStatus("pending")}>
                {t("studio.card.undo")}
              </Button>
            )}
            <span className="ml-auto text-[11px] text-zinc-400">{t("studio.card.updated", { date: formatDate(s.updatedAt) })}</span>
          </div>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------- view

function StudioSkeleton() {
  const { t } = useFormat();
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" role="status" aria-label={t("studio.loading")}>
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <SkeletonCard lines={3} />
        <SkeletonCard lines={5} />
        <SkeletonCard lines={3} />
      </div>
      <SkeletonCard lines={6} className="h-80" />
    </div>
  );
}

export function StudioView() {
  const { t, formatDate } = useFormat();
  const { siteId, version, auditActive, startAudit, startingAudit } = useSite();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("diff");
  const [statusView, setStatusView] = useState<StatusView>("pending");
  const [pageUrl, setPageUrl] = useState("");
  const [ruleTypes, setRuleTypes] = useState<Set<string>>(new Set());
  const [impact, setImpact] = useState<Impact | "all">("all");
  const [sort, setSort] = useState<"gain" | "recent">("gain");
  const [mode, setMode] = useState<DiffMode>("split");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<{ id: string; action: string } | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  // Live data: refetches when an audit finishes (version), polls while one is running.
  const data = useApi<AutoGeoOverview>(`/api/sites/${siteId}/autogeo?status=pending,applied,dismissed&sort=${sort}&limit=500`, {
    version,
    pollMs: auditActive ? 8_000 : 0,
  });

  const all = useMemo(() => data.data?.suggestions.items ?? [], [data.data]);
  const summary = data.data?.summary ?? null;
  const items = useMemo(() => data.data?.items ?? [], [data.data]);

  const pages = useMemo(() => {
    const urls = new Map<string, number | null>((summary?.pages ?? []).map((p) => [p.url, p.score]));
    for (const s of all) if (!urls.has(s.pageUrl)) urls.set(s.pageUrl, null);
    return [...urls.entries()].map(([url, score]) => ({ url, score })).sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
  }, [summary, all]);

  // Filters other than status (status is the view tab); counts follow the other filters.
  const baseFiltered = useMemo(
    () => all.filter((s) => (!pageUrl || s.pageUrl === pageUrl) && (!ruleTypes.size || ruleTypes.has(s.ruleType)) && (impact === "all" || impactOfGain(s.expectedGain) === impact)),
    [all, pageUrl, ruleTypes, impact],
  );
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = { all: baseFiltered.length };
    for (const s of baseFiltered) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [baseFiltered]);
  const visible = useMemo(() => baseFiltered.filter((s) => statusView === "all" || s.status === statusView), [baseFiltered, statusView]);
  const ruleCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of all) if ((!pageUrl || s.pageUrl === pageUrl) && s.status !== "dismissed") c[s.ruleType] = (c[s.ruleType] ?? 0) + 1;
    return c;
  }, [all, pageUrl]);

  const simPages = useMemo(() => (summary?.pages ?? []).map((p) => ({ url: p.url, score: p.score })), [summary]);
  const sim = useMemo(() => simulateScore(summary?.score, simPages, all, selected), [summary, simPages, all, selected]);
  const maxProjected = useMemo(
    () => simulateScore(summary?.score, simPages, all, new Set(all.filter((s) => s.status === "pending").map((s) => s.id))).projected,
    [summary, simPages, all],
  );

  const capsules = useMemo(() => collectCapsules(baseFiltered, pageUrl ? items.filter((i) => i.targetUrl === pageUrl) : items), [baseFiltered, items, pageUrl]);
  const tables = useMemo(() => collectTables(baseFiltered, pageUrl ? items.filter((i) => i.targetUrl === pageUrl) : items, t), [baseFiltered, items, pageUrl, t]);

  const expandedId = expanded ?? visible[0]?.id ?? null;

  function patchLocal(row: Pick<AutoGeoSuggestionRow, "id" | "status" | "updatedAt">) {
    data.mutate((prev) => {
      if (!prev) return prev;
      const old = prev.suggestions.items.find((i) => i.id === row.id);
      const byStatus = { ...prev.suggestions.byStatus };
      if (old && old.status !== row.status) {
        byStatus[old.status] = Math.max(0, (byStatus[old.status] ?? 1) - 1);
        byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      }
      return { ...prev, suggestions: { ...prev.suggestions, byStatus, items: prev.suggestions.items.map((i) => (i.id === row.id ? { ...i, status: row.status, updatedAt: row.updatedAt } : i)) } };
    });
    if (row.status !== "pending")
      setSelected((prev) => {
        if (!prev.has(row.id)) return prev;
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
  }

  async function setStatus(s: AutoGeoSuggestionRow, status: "applied" | "dismissed" | "pending") {
    setBusy({ id: s.id, action: status });
    try {
      const row = await apiFetch<AutoGeoSuggestionRow>(`/api/sites/${siteId}/autogeo/${s.id}`, { method: "PATCH", json: { status } });
      patchLocal(row);
      toast.push("success", t(`studio.toast.${status}`));
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function applyCms(s: AutoGeoSuggestionRow) {
    setBusy({ id: s.id, action: "cms" });
    try {
      const res = await apiFetch<CmsApplyResult>(`/api/sites/${siteId}/autogeo/${s.id}/apply`, { method: "POST" });
      if (!res.configured) {
        const ok = await copyText(markdownToHtml(s.suggestedSnippet));
        toast.push("info", t(ok ? "studio.toast.cmsNotConfiguredCopied" : "studio.toast.cmsNotConfigured"));
        return;
      }
      patchLocal(res.suggestion);
      const sent = res.deliveries.filter((d) => d.status === "sent").length;
      toast.push("success", t("studio.toast.cmsSent", { sent, total: res.deliveries.length }));
    } catch (err) {
      toast.push("error", err instanceof ApiError && err.status === 502 ? t("studio.toast.cmsRejected") : errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function rebuild() {
    setRebuilding(true);
    try {
      const res = await apiFetch<{ created: number; updated: number; superseded: number }>(`/api/sites/${siteId}/autogeo`, { method: "POST", json: {} });
      toast.push("success", t("studio.toast.rebuilt", { created: res.created, updated: res.updated, superseded: res.superseded }));
      await data.reload();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setRebuilding(false);
    }
  }

  const toggleRule = (r: string) =>
    setRuleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold">{t("studio.header.title")}</h2>
        <p className="text-sm text-zinc-500">
          {t("studio.header.intro")}
          {data.data?.completedAt && <> {t("studio.header.lastAnalysis", { date: formatDate(data.data.completedAt) })}</>}
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void rebuild()} loading={rebuilding} disabled={data.loading} title={t("studio.header.refreshTitle")}>
          {t("studio.header.refresh")}
        </Button>
        <Button variant="primary" onClick={() => void startAudit()} loading={startingAudit} disabled={auditActive}>
          {auditActive ? t("studio.header.analyzing") : t("studio.header.reanalyze")}
        </Button>
      </div>
    </div>
  );

  if (data.loading)
    return (
      <div className="space-y-4">
        {header}
        <StudioSkeleton />
      </div>
    );
  if (data.error)
    return (
      <div className="space-y-4">
        {header}
        <ErrorState error={data.error} onRetry={() => void data.reload()} />
      </div>
    );
  if (!all.length && !summary)
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          icon="✎"
          title={t("studio.empty.title")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => void startAudit()} loading={startingAudit} disabled={auditActive}>
                {auditActive ? t("studio.header.analyzing") : t("studio.empty.start")}
              </Button>
              {items.length > 0 && (
                <Button onClick={() => void rebuild()} loading={rebuilding}>
                  {t("studio.empty.fromActions")}
                </Button>
              )}
            </div>
          }
        >
          {t("studio.empty.hint")}
        </EmptyState>
      </div>
    );

  const truncated = (data.data?.suggestions.total ?? 0) > all.length;

  return (
    <div className="space-y-4">
      {header}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {/* filters */}
          <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label={t("studio.filter.page")} value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} className={`${inputBase} w-full py-1.5 text-xs sm:w-72`}>
                <option value="">{t("studio.filter.allPages", { count: pages.length })}</option>
                {pages.map((p) => (
                  <option key={p.url} value={p.url}>
                    {pagePath(p.url)}
                    {p.score != null ? t("studio.filter.pageScore", { score: p.score }) : ""}
                  </option>
                ))}
              </select>
              <Segmented
                label={t("studio.filter.impact")}
                value={impact}
                onChange={setImpact}
                options={[{ value: "all" as const, label: t("studio.filter.allImpacts") }, ...IMPACTS.map((i) => ({ value: i.value, label: impactLabel(t, i.value) }))]}
              />
              <select aria-label={t("studio.filter.sort")} value={sort} onChange={(e) => setSort(e.target.value as "gain" | "recent")} className={`${inputBase} w-auto py-1.5 text-xs`}>
                <option value="gain">{t("studio.filter.sortGain")}</option>
                <option value="recent">{t("studio.filter.sortRecent")}</option>
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("studio.filter.ruleGroup")}>
              <span className="mr-1 text-xs text-zinc-500">{t("studio.filter.rule")}</span>
              {STUDIO_RULE_TYPES.filter((r) => ruleCounts[r] || ruleTypes.has(r)).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={ruleTypes.has(r)}
                  onClick={() => toggleRule(r)}
                  className={cx(
                    "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                    ruleTypes.has(r)
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-200"
                      : "border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300",
                  )}
                >
                  {ruleTypeLabel(t, r)} <span className="tabular-nums text-zinc-400">{ruleCounts[r] ?? 0}</span>
                </button>
              ))}
              {(ruleTypes.size > 0 || pageUrl || impact !== "all") && (
                <button
                  type="button"
                  className="ml-1 text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                  onClick={() => {
                    setRuleTypes(new Set());
                    setPageUrl("");
                    setImpact("all");
                  }}
                >
                  {t("studio.filter.clear")}
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              label={t("studio.tabs.label")}
              value={tab}
              onChange={setTab}
              options={[
                { value: "diff" as const, label: t("studio.tabs.diff"), count: visible.length },
                { value: "capsules" as const, label: t("studio.tabs.capsules"), count: capsules.length },
                { value: "tables" as const, label: t("studio.tabs.tables"), count: tables.length },
              ]}
            />
            {tab === "diff" && (
              <div className="flex flex-wrap gap-2">
                <Segmented
                  label={t("studio.statusView.label")}
                  value={statusView}
                  onChange={(v) => {
                    setStatusView(v);
                    setExpanded(null);
                  }}
                  options={[
                    { value: "pending" as const, label: t("studio.statusView.pending"), count: statusCounts.pending ?? 0 },
                    { value: "applied" as const, label: t("studio.statusView.applied"), count: statusCounts.applied ?? 0 },
                    { value: "dismissed" as const, label: t("studio.statusView.dismissed"), count: statusCounts.dismissed ?? 0 },
                    { value: "all" as const, label: t("studio.statusView.all"), count: statusCounts.all ?? 0 },
                  ]}
                />
                <Segmented
                  label={t("studio.diffMode.label")}
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "split" as const, label: t("studio.diffMode.split") },
                    { value: "unified" as const, label: t("studio.diffMode.unified") },
                  ]}
                />
              </div>
            )}
          </div>

          {truncated && <p className="text-xs text-amber-700 dark:text-amber-400">{t("studio.truncated", { shown: all.length, total: data.data?.suggestions.total ?? all.length })}</p>}

          {tab === "capsules" ? (
            <CapsuleGrid capsules={capsules} />
          ) : tab === "tables" ? (
            <TableList tables={tables} />
          ) : !visible.length ? (
            statusView === "pending" && !baseFiltered.some((s) => s.status === "pending") && !pageUrl && !ruleTypes.size && impact === "all" ? (
              <EmptyState icon="🎉" title={t("studio.empty.noPendingTitle")} action={<Button variant="primary" onClick={() => void startAudit()} loading={startingAudit} disabled={auditActive}>{t("studio.header.reanalyze")}</Button>}>
                {t("studio.empty.noPendingHint")}
              </EmptyState>
            ) : (
              <EmptyState icon="∅" title={t("studio.empty.noMatchTitle")}>
                {t("studio.empty.noMatchHint")}
              </EmptyState>
            )
          ) : (
            <div className="space-y-3">
              {visible.map((s) => (
                <SuggestionCard
                  key={s.id}
                  s={s}
                  expanded={expandedId === s.id}
                  onToggle={() => setExpanded(expandedId === s.id ? "" : s.id)}
                  selected={selected.has(s.id)}
                  onSelect={(v) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (v) next.add(s.id);
                      else next.delete(s.id);
                      return next;
                    })
                  }
                  mode={mode}
                  busy={busy?.id === s.id ? busy.action : null}
                  onStatus={(st) => void setStatus(s, st)}
                  onApplyCms={() => void applyCms(s)}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-4">
          <ScoreSimulator
            sim={sim}
            maxProjected={maxProjected}
            selectedCount={selected.size}
            pendingCount={visible.filter((s) => s.status === "pending").length}
            onSelectAll={() => setSelected((prev) => new Set([...prev, ...visible.filter((s) => s.status === "pending").map((s) => s.id)]))}
            onClear={() => setSelected(new Set())}
          />
          {summary && (
            <section className="rounded-xl border border-zinc-200 bg-white p-4 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-2 text-sm font-semibold">{t("studio.sim.metricsTitle")}</h2>
              <ul className="space-y-1.5">
                {Object.entries(summary.metrics).map(([k, v]) => (
                  <li key={k} className="flex items-center gap-2">
                    <span className="w-32 truncate text-zinc-600 dark:text-zinc-400">{metricLabel(t, k)}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--chart-grid)]">
                      <span className="block h-full rounded-full" style={{ width: `${Math.max(2, v)}%`, background: TONE_COLOR[scoreTone(v)] }} />
                    </span>
                    <span className="w-7 text-right tabular-nums">{v}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-zinc-500">
                {rich(t("studio.cmsHelp", { apply: t("studio.card.applyCms") }), {
                  link: (
                    <Link href={`/sites/${siteId}/distribution`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                      {t("studio.cmsHelp.linkLabel")}
                    </Link>
                  ),
                  code: <code>autogeo.suggestion.applied</code>,
                })}
              </p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

const METRIC_KEYS = ["statistics", "quotations", "citations", "answer_capsules", "authority_fluency", "keyword_stuffing"];
/** Label of an AutoGEO metric (`studio.metric.*`); unknown metrics are shown as-is. */
const metricLabel = (t: Translator, metric: string) => (METRIC_KEYS.includes(metric) ? t(`studio.metric.${metric}`) : metric);
