"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  brandRows, citeMagnetTip, dominantSentiment, filterGaps, type GapFilter, gapDomains, gapFactors, gapsCsv, intentLabel, INTENT_ORDER,
  sentimentLabel, SENTIMENT_TONE, siteRank, siteTrendDelta, somCsv, trendSeries,
} from "@/lib/dashboard/competitor-intel";
import { hostOf, VISIBILITY_MODEL_ORDER } from "@/lib/dashboard/format";
import { foldCase } from "@/lib/dashboard/highlight";
import { apiFetch, errorMessage, useApi } from "./api";
import { rich } from "./rich-text";
import { useSite } from "./site-shell";
import { ModelShareBars, ShareDonut, ShareTrendChart } from "./som-charts";
import { useToast } from "./toast";
import type { CitationGap, CompetitorReport, QueryIntent, SentimentLabel, VisibilityList } from "./types";
import { Badge, Button, Card, cx, downloadText, EmptyState, ErrorState, inputBase, Segmented, SkeletonCard, Spinner, TONE_COLOR } from "./ui";
import { RunPanel } from "./visibility-view";
import { useFormat } from "./use-format";

type Competitor = { title: string; url: string };
const object = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** Percentage for a 0-100 value, in the locale's own style ("25%" / "%25"). */
const fmtPct = (intlLocale: string, v: number | null | undefined, digits = 1) =>
  v == null ? "—" : new Intl.NumberFormat(intlLocale, { style: "percent", maximumFractionDigits: digits }).format(v / 100);
const PAGE = 25;
const MATRIX_COLUMNS = 6;

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: keyof typeof TONE_COLOR }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        {tone && <span aria-hidden className="inline-block h-2 w-2 self-center rounded-full" style={{ background: TONE_COLOR[tone] }} />}
        <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</span>
      </div>
      {sub && <div className="mt-1 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- competitor settings

function CompetitorManager({ onSaved }: { onSaved: () => void }) {
  const { t } = useFormat();
  const { siteId, site } = useSite();
  const toast = useToast();
  const settings = object(site.settings);
  const analysis = object(settings.visibilityAnalysis);
  const configured = (Array.isArray(analysis.competitors) ? analysis.competitors : []) as Competitor[];
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(next: Competitor[]) {
    setSaving(true);
    try {
      await apiFetch(`/api/sites/${siteId}`, { method: "PATCH", json: { settings: { ...settings, visibilityAnalysis: { ...analysis, competitors: next } } } });
      toast.push("success", t("competitors.manager.saved"));
      setTitle("");
      setUrl("");
      onSaved();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const normalized = /^https?:\/\//i.test(url.trim()) ? url.trim() : url.trim() ? `https://${url.trim()}` : "";
  const valid = (() => {
    try {
      return !!normalized && !!new URL(normalized).hostname.includes(".");
    } catch {
      return false;
    }
  })();
  const duplicate = valid && configured.some((c) => hostOf(c.url) === hostOf(normalized));

  return (
    <Card title={t("competitors.manager.title")} subtitle={t("competitors.manager.subtitle")}>
      {configured.length ? (
        <ul className="mb-3 flex flex-wrap gap-2">
          {configured.map((c) => (
            <li key={c.url} className="flex items-center gap-1.5 rounded-full border border-zinc-200 py-1 pl-3 pr-1 text-sm dark:border-zinc-700">
              <span className="font-medium">{c.title}</span>
              <span className="text-xs text-zinc-500">{hostOf(c.url)}</span>
              <button
                type="button"
                className="ml-1 rounded-full px-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800"
                aria-label={t("competitors.manager.remove", { name: c.title })}
                disabled={saving}
                onClick={() => void save(configured.filter((x) => x.url !== c.url))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-zinc-500">{t("competitors.manager.empty")}</p>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !duplicate) void save([...configured, { title: title.trim() || hostOf(normalized), url: normalized }]);
        }}
      >
        <input className={cx(inputBase, "w-40")} placeholder={t("competitors.manager.namePlaceholder")} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t("competitors.manager.nameLabel")} maxLength={200} />
        <input className={cx(inputBase, "min-w-0 flex-1")} placeholder={t("competitors.manager.urlPlaceholder")} value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t("competitors.manager.urlLabel")} />
        <Button type="submit" variant="secondary" loading={saving} disabled={!valid || duplicate || configured.length >= 20}>
          {t("competitors.manager.add")}
        </Button>
      </form>
      {duplicate && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t("competitors.manager.duplicate")}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------- new test

function NewTestPanel({ onDone }: { onDone: () => void }) {
  const { t } = useFormat();
  const { siteId } = useSite();
  const toast = useToast();
  const [reload, setReload] = useState(0);
  const list = useApi<VisibilityList>(`/api/sites/${siteId}/visibility?limit=1`);
  const stored = useApi<{ items: { query: string; intent: QueryIntent }[] }>(`/api/sites/${siteId}/queries/synthetic?limit=100`, { version: reload });
  const [generating, setGenerating] = useState(false);

  async function generate() {
    setGenerating(true);
    try {
      const res = await apiFetch<{ created?: number }>(`/api/sites/${siteId}/queries/synthetic`, { method: "POST", json: { mode: "generate", maxPerIntent: 5 } });
      toast.push("success", t("competitors.test.generated", { count: res.created ?? 0 }));
      setReload((r) => r + 1);
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setGenerating(false);
    }
  }

  if (list.loading || stored.loading) return <SkeletonCard lines={5} />;
  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.reload()} />;
  const synthetic = stored.data?.items.map((q) => q.query) ?? [];
  const suggestions = [...new Set([...synthetic, ...list.data!.queries])];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-200">
        <span>
          {synthetic.length ? t("competitors.test.stored", { count: synthetic.length }) : t("competitors.test.noneStored")} {t("competitors.test.recalc")}
        </span>
        <Button size="sm" variant="secondary" loading={generating} onClick={() => void generate()}>
          {t("competitors.test.generate")}
        </Button>
      </div>
      <RunPanel key={suggestions.join("|")} suggestions={suggestions} details={list.data!.querySuggestions} onDone={onDone} />
    </div>
  );
}

// ---------------------------------------------------------------- citation gaps

function GapRow({ gap, columns, open, onToggle }: { gap: CitationGap; columns: string[]; open: boolean; onToggle: () => void }) {
  const { t, label, formatDate } = useFormat();
  const factors = gapFactors(gap);
  const cited = new Map(gap.competitors.map((c) => [c.domain, c]));
  const extra = gap.competitors.filter((c) => !columns.includes(c.domain)).length;
  return (
    <>
      <tr className={cx("border-t border-zinc-100 align-top dark:border-zinc-800", open && "bg-zinc-50 dark:bg-zinc-950/60")}>
        <td className="py-2 pr-3">
          <button type="button" onClick={onToggle} aria-expanded={open} className="text-left font-medium hover:text-indigo-600 dark:hover:text-indigo-400">
            <span aria-hidden className="mr-1 inline-block w-3 text-zinc-400">{open ? "▾" : "▸"}</span>
            {gap.query}
          </button>
          <div className="mt-1 flex flex-wrap gap-1 pl-4">
            <Badge>{intentLabel(t, gap.intent)}</Badge>
            <Badge>{label("model", gap.model)}</Badge>
            {factors.length > 0 && <Badge tone="warning">{t("competitors.gap.hints", { count: factors.length })}</Badge>}
          </div>
        </td>
        <td className="py-2 pr-3 text-center">
          <Badge tone={gap.targetMentioned ? "warning" : "critical"} icon>
            {gap.targetMentioned ? t("competitors.gap.mentioned") : t("competitors.gap.absent")}
          </Badge>
        </td>
        {columns.map((d) => (
          <td key={d} className="py-2 pr-3 text-center">
            {cited.has(d) ? (
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-700 dark:bg-red-900/50 dark:text-red-200" title={t("competitors.gap.citedTitle", { domain: d, urls: cited.get(d)!.urls.join("\n") })}>
                {cited.get(d)!.urls.length || "●"}
              </span>
            ) : (
              <span className="text-zinc-300 dark:text-zinc-700" aria-label={t("competitors.gap.notCited")}>·</span>
            )}
          </td>
        ))}
        {extra > 0 ? <td className="py-2 text-xs text-zinc-500">+{extra}</td> : columns.length > 0 && <td />}
      </tr>
      {open && (
        <tr className="bg-zinc-50 dark:bg-zinc-950/60">
          <td colSpan={columns.length + 3} className="px-4 pb-4 pt-1">
            <div className="grid gap-4 text-xs md:grid-cols-2">
              <div>
                <div className="mb-1 font-medium uppercase tracking-wide text-zinc-500">{t("competitors.gap.citedPages")}</div>
                <ul className="space-y-1">
                  {gap.competitors.map((c) => (
                    <li key={c.domain}>
                      <span className="font-medium">{c.domain}</span>
                      {c.urls.map((u) => (
                        <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="block break-all text-indigo-600 hover:underline dark:text-indigo-400">
                          {u}
                        </a>
                      ))}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-zinc-500">
                  {t("competitors.gap.closestPage")}{" "}
                  {gap.targetPage ? (
                    <a href={gap.targetPage} target="_blank" rel="noopener noreferrer" className="break-all text-indigo-600 hover:underline dark:text-indigo-400">
                      {gap.targetPage}
                    </a>
                  ) : (
                    t("competitors.gap.noMatchingPage")
                  )}
                </p>
                <p className="mt-1 text-zinc-400">
                  {formatDate(gap.checkedAt)} · {t(gap.intentSource === "synthetic_query" ? "competitors.gap.intentSource.synthetic_query" : "competitors.gap.intentSource.classifier")}
                </p>
              </div>
              <div>
                <div className="mb-1 font-medium uppercase tracking-wide text-zinc-500">{t("competitors.gap.hintsHeading")}</div>
                {factors.length ? (
                  <ul className="space-y-2">
                    {factors.map((f) => {
                      const hint = citeMagnetTip(f, t);
                      return (
                        <li key={f} className="rounded-md border border-amber-200 bg-amber-50 p-2 dark:border-amber-900/60 dark:bg-amber-950/30">
                          <div className="font-medium text-amber-900 dark:text-amber-200">{hint.label}</div>
                          <div className="text-amber-800/90 dark:text-amber-200/80">{hint.tip}</div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-zinc-500">{rich(t("competitors.gap.noSnapshot"), { code: <code>visibilityAnalysis.referencePages</code> })}</p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export type GapFilterState = Required<GapFilter>;
export const NO_GAP_FILTER: GapFilterState = { intent: "all", model: "all", competitor: "all", search: "" };

function GapMatrix({ report, filter, onFilter }: { report: CompetitorReport; filter: GapFilterState; onFilter: (f: GapFilterState) => void }) {
  const { t, label } = useFormat();
  const gaps = report.citationGaps;
  const { intent, model, competitor, search } = filter;
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const set = (patch: Partial<GapFilterState>) => {
    onFilter({ ...filter, ...patch });
    setLimit(PAGE);
  };
  const filtered = useMemo(() => filterGaps(gaps, filter), [gaps, filter]);
  const domains = useMemo(() => gapDomains(gaps), [gaps]);
  const columns = useMemo(() => {
    const visible = gapDomains(filtered).map((d) => d.domain);
    return (competitor !== "all" ? [competitor, ...visible.filter((d) => d !== competitor)] : visible).slice(0, MATRIX_COLUMNS);
  }, [filtered, competitor]);
  const key = (g: CitationGap) => `${g.query}|${g.model}|${g.checkedAt}`;
  const localCounts = useMemo(() => Object.fromEntries(INTENT_ORDER.map((i) => [i, gaps.filter((g) => g.intent === i).length])), [gaps]);

  return (
    <Card
      title={t("competitors.gap.title")}
      subtitle={
        report.citationGapTotal > gaps.length
          ? t("competitors.gap.subtitleTruncated", { total: report.citationGapTotal, shown: gaps.length })
          : t("competitors.gap.subtitle", { total: report.citationGapTotal })
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          label={t("competitors.gap.intentLabel")}
          value={intent}
          onChange={(v) => set({ intent: v })}
          options={[{ value: "all" as const, label: t("competitors.gap.all"), count: gaps.length }, ...INTENT_ORDER.map((i) => ({ value: i, label: intentLabel(t, i), count: localCounts[i] }))]}
        />
        <select className={cx(inputBase, "py-1.5 text-xs")} value={model} onChange={(e) => set({ model: e.target.value })} aria-label={t("competitors.gap.modelFilter")}>
          <option value="all">{t("competitors.gap.allModels")}</option>
          {VISIBILITY_MODEL_ORDER.map((m) => (
            <option key={m} value={m}>
              {label("model", m)}
            </option>
          ))}
        </select>
        <select className={cx(inputBase, "py-1.5 text-xs")} value={competitor} onChange={(e) => set({ competitor: e.target.value })} aria-label={t("competitors.gap.competitorFilter")}>
          <option value="all">{t("competitors.gap.allCompetitors")}</option>
          {domains.map((d) => (
            <option key={d.domain} value={d.domain}>
              {d.domain} ({d.count})
            </option>
          ))}
        </select>
        <input className={cx(inputBase, "min-w-0 flex-1 py-1.5 text-xs")} placeholder={t("competitors.gap.searchPlaceholder")} value={search} onChange={(e) => set({ search: e.target.value })} aria-label={t("competitors.gap.searchLabel")} />
      </div>
      {!filtered.length ? (
        <EmptyState icon="✓" title={gaps.length ? t("competitors.gap.emptyFiltered") : t("competitors.gap.emptyNone")}>
          {gaps.length ? t("competitors.gap.emptyFilteredHint") : t("competitors.gap.emptyNoneHint")}
        </EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">{t("competitors.gap.colQuery")}</th>
                  <th className="py-2 pr-3 text-center font-medium">{t("competitors.gap.colYou")}</th>
                  {columns.map((d) => (
                    <th key={d} className="max-w-[8rem] truncate py-2 pr-3 text-center font-medium" title={d}>
                      {d}
                    </th>
                  ))}
                  {columns.length > 0 && <th className="py-2" />}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, limit).map((g) => (
                  <GapRow
                    key={key(g)}
                    gap={g}
                    columns={columns}
                    open={open.has(key(g))}
                    onToggle={() =>
                      setOpen((prev) => {
                        const next = new Set(prev);
                        if (next.has(key(g))) next.delete(key(g));
                        else next.add(key(g));
                        return next;
                      })
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > limit && (
            <div className="mt-3 text-center">
              <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>
                {t("competitors.gap.showMore", { count: filtered.length - limit })}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- brand safety

const SENTIMENT_CARD: Record<Exclude<SentimentLabel, "unknown">, string> = {
  positive: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-100",
  neutral: "border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-100",
  negative: "border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100",
};
const SENTIMENT_BAR: Record<Exclude<SentimentLabel, "unknown">, string> = { positive: TONE_COLOR.good, neutral: TONE_COLOR.neutral, negative: TONE_COLOR.critical };

function Quote({ text, terms }: { text: string; terms: { term: string; polarity: number }[] }) {
  // Sentiment terms are matched case-insensitively with the Turkish-aware fold (see foldCase), so EN and TR words both match.
  const polarity = new Map(terms.map((x) => [foldCase(x.term), x.polarity]));
  return (
    <>
      {text.split(/([\p{L}']+)/u).map((part, i) => {
        const p = polarity.get(foldCase(part));
        return p ? (
          <mark key={i} className={cx("rounded px-0.5", p > 0 ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100" : "bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100")}>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

function BrandSafety({ report }: { report: CompetitorReport }) {
  const { t, label, timeAgo, intlLocale } = useFormat();
  const bs = report.brandSafety;
  const [tone, setTone] = useState<SentimentLabel | "all">("all");
  const known = bs.sentiment.positive + bs.sentiment.neutral + bs.sentiment.negative;
  const evidence = bs.evidence.filter((e) => tone === "all" || e.label === tone);
  const h = bs.hallucinations;
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3" title={t("competitors.brand.sentimentTitle")} subtitle={t("competitors.brand.sentimentSubtitle")}>
        <div className="grid grid-cols-3 gap-2">
          {(["positive", "neutral", "negative"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setTone((cur) => (cur === l ? "all" : l))}
              aria-pressed={tone === l}
              className={cx("rounded-lg border p-3 text-left transition-shadow", SENTIMENT_CARD[l], tone === l && "ring-2 ring-indigo-500/60")}
            >
              <div className="text-xs font-medium">{sentimentLabel(t, l)}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{bs.sentiment[l]}</div>
              <div className="text-xs opacity-75">{known ? t("competitors.brand.answerShare", { percent: fmtPct(intlLocale, (bs.sentiment[l] / known) * 100, 0) }) : "—"}</div>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          {t("competitors.brand.noBrandSentence", { count: bs.sentiment.unknown })}
          {bs.sentiment.averageScore != null && t("competitors.brand.averageScore", { score: bs.sentiment.averageScore })}
          {bs.textCoverage.truncated > 0 && t("competitors.brand.truncatedAnswers", { count: bs.textCoverage.truncated })}
        </p>
        <div className="mt-4 space-y-2">
          {VISIBILITY_MODEL_ORDER.map((m) => {
            const c = bs.perModel[m];
            const total = c ? c.positive + c.neutral + c.negative : 0;
            const dom = c ? dominantSentiment(c) : "unknown";
            return (
              <div key={m} className="flex items-center gap-3 text-sm">
                <span className="w-24 shrink-0 font-medium">{label("model", m)}</span>
                <div className="flex h-2.5 flex-1 gap-[2px] overflow-hidden rounded">
                  {total ? (
                    (["positive", "neutral", "negative"] as const).map((l) =>
                      c![l] ? <div key={l} title={`${sentimentLabel(t, l)}: ${c![l]}`} style={{ width: `${(c![l] / total) * 100}%`, background: SENTIMENT_BAR[l] }} /> : null,
                    )
                  ) : (
                    <div className="w-full bg-[var(--chart-grid)]" />
                  )}
                </div>
                <Badge tone={SENTIMENT_TONE[dom]} icon className="w-28 justify-center">
                  {total ? sentimentLabel(t, dom) : t("competitors.brand.noData")}
                </Badge>
              </div>
            );
          })}
        </div>
        {evidence.length > 0 ? (
          <ul className="mt-4 max-h-80 space-y-2 overflow-auto pr-1">
            {evidence.map((e) => (
              <li key={e.recordId} className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge tone={SENTIMENT_TONE[e.label]} icon>
                    {sentimentLabel(t, e.label)}
                  </Badge>
                  <span className="font-medium">{label("model", e.model)}</span>
                  <span className="truncate text-zinc-500" title={e.query}>
                    “{e.query}”
                  </span>
                  <span className="ml-auto text-zinc-400">{timeAgo(e.checkedAt)}</span>
                </div>
                {e.quotes.map((q, i) => (
                  <blockquote key={i} className="mt-1 border-l-2 border-zinc-200 pl-2 leading-relaxed text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
                    <Quote text={q.text} terms={q.terms} />
                  </blockquote>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-xs text-zinc-500">{tone === "all" ? t("competitors.brand.noSentences") : t("competitors.brand.noEvidence")}</p>
        )}
      </Card>

      <Card
        className="lg:col-span-2"
        title={
          <span className="flex items-center gap-2">
            {t("competitors.brand.hallucinationTitle")}
            {h.findingCount > 0 && (
              <Badge tone="critical" icon>
                {h.findingCount}
              </Badge>
            )}
          </span>
        }
        subtitle={t("competitors.brand.hallucinationSubtitle")}
      >
        {h.checkedFacts === 0 ? (
          <EmptyState icon="ⓘ" title={t("competitors.brand.noFactsTitle")}>
            {rich(t("competitors.brand.noFactsHint"), { code: <code>visibilityAnalysis.facts</code> })}
          </EmptyState>
        ) : !h.items.length ? (
          <EmptyState icon="✓" title={t("competitors.brand.noHallucinationTitle")}>
            {t("competitors.brand.noHallucinationHint", { facts: h.checkedFacts, samples: bs.samples })}
          </EmptyState>
        ) : (
          <>
            <p className="mb-2 text-xs text-zinc-500">
              {t("competitors.brand.findingsSummary", { answers: h.affectedAnswers, findings: h.findingCount, facts: h.checkedFacts })}
            </p>
            <ul className="max-h-[32rem] space-y-2 overflow-auto pr-1">
              {h.items.map((f, i) => (
                <li key={`${f.recordId}-${i}`} className="rounded-lg border border-red-200 bg-red-50/60 p-3 text-xs dark:border-red-900/60 dark:bg-red-950/30">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge tone="critical" icon>
                      {t("competitors.brand.likelyHallucination")}
                    </Badge>
                    <span className="font-medium">{label("model", f.model)}</span>
                    <span className="ml-auto text-zinc-400">{timeAgo(f.checkedAt)}</span>
                  </div>
                  <blockquote className="border-l-2 border-red-300 pl-2 italic leading-relaxed text-zinc-800 dark:border-red-800 dark:text-zinc-200">“{f.text}”</blockquote>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                    <dt className="text-zinc-500">{t("competitors.brand.subject")}</dt>
                    <dd>{f.subject}</dd>
                    <dt className="text-zinc-500">{t("competitors.brand.conflictingClaim")}</dt>
                    <dd className="font-medium text-red-700 dark:text-red-300">{f.conflictingClaim}</dd>
                    <dt className="text-zinc-500">{t("competitors.brand.correctValue")}</dt>
                    <dd className="text-emerald-800 dark:text-emerald-300">{f.expected}</dd>
                    <dt className="text-zinc-500">{t("competitors.brand.query")}</dt>
                    <dd className="truncate" title={f.query}>
                      {f.query}
                    </dd>
                  </dl>
                  <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-indigo-600 hover:underline dark:text-indigo-400">
                    {t("competitors.brand.evidenceSource")}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- page

export function CompetitorsView() {
  const { t, intlLocale, formatDate } = useFormat();
  const { siteId, site, version, bump } = useSite();
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [granularity, setGranularity] = useState<"day" | "week">("day");
  const [reload, setReload] = useState(0);
  const [testing, setTesting] = useState(false);
  const [last, setLast] = useState<CompetitorReport>();
  const [gapFilter, setGapFilter] = useState<GapFilterState>(NO_GAP_FILTER);
  const report = useApi<CompetitorReport>(`/api/sites/${siteId}/competitors?days=${days}&granularity=${granularity}&gapLimit=200&evidenceLimit=50`, {
    version: `${version}:${reload}`,
    onData: (_prev, next) => setLast(next),
  });
  // Keep the previous report on screen while a new window / granularity loads.
  const data = report.data ?? last;
  const rows = useMemo(() => (data ? brandRows(data) : []), [data]);
  const series = useMemo(() => (data ? trendSeries(data, rows) : []), [data, rows]);

  if (!data) {
    if (report.error) return <ErrorState error={report.error} onRetry={() => void report.reload()} />;
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <SkeletonCard key={i} lines={1} />
          ))}
        </div>
        <SkeletonCard lines={6} />
        <SkeletonCard lines={6} />
      </div>
    );
  }

  const busy = report.loading || report.refreshing;
  const rank = siteRank(rows);
  const delta = siteTrendDelta(series);
  const bs = data.brandSafety;
  const mood = dominantSentiment(bs.sentiment);
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = hostOf(site.url).replace(/[^a-z0-9.-]/gi, "_");
  const noCompetitors = data.competitors.length === 0;
  const empty = data.site.samples === 0;
  const gapsForExport = filterGaps(data.citationGaps, gapFilter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label={t("competitors.window.label")}
          value={days}
          onChange={setDays}
          options={(["7", "30", "90"] as const).map((d) => ({ value: d, label: t("competitors.window.days", { count: Number(d) }) }))}
        />
        {busy && (
          <span className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Spinner className="h-3 w-3" /> {t("competitors.recalculating")}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={empty} onClick={() => downloadText(somCsv(data, VISIBILITY_MODEL_ORDER), `${slug}-share-of-model-${stamp}.csv`, "text/csv;charset=utf-8")}>
            ⇩ SoM CSV
          </Button>
          <Button size="sm" variant="ghost" disabled={!gapsForExport.length} title={t("competitors.export.gapsCsvTitle")} onClick={() => downloadText(gapsCsv(gapsForExport), `${slug}-citation-gaps-${stamp}.csv`, "text/csv;charset=utf-8")}>
            {t("competitors.export.gapsCsv")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => downloadText(JSON.stringify(data, null, 2), `${slug}-competitor-report-${stamp}.json`, "application/json")}>
            ⇩ JSON
          </Button>
          <Button size="sm" variant={testing ? "secondary" : "primary"} onClick={() => setTesting((t) => !t)} aria-expanded={testing}>
            {testing ? t("competitors.test.hide") : t("competitors.test.new")}
          </Button>
        </div>
      </div>

      {testing && (
        <NewTestPanel
          onDone={() => {
            setReload((r) => r + 1);
          }}
        />
      )}

      {(data.warnings.length > 0 || !data.settingsValid || data.window.truncated) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          {!data.settingsValid && <div>{t("competitors.warning.invalidSettings")}</div>}
          {data.window.truncated && <div>{t("competitors.warning.truncated", { limit: data.window.limit, total: data.window.total })}</div>}
          {data.warnings.map((w) => (
            <div key={w}>{w.replace("Overlapping competitor ignored", t("competitors.warning.overlap"))}</div>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          label={t("competitors.stat.shareOfModel")}
          value={fmtPct(intlLocale, data.site.shareOfModel)}
          tone={rank === 1 && !empty ? "good" : rank && rank > 2 ? "critical" : "warning"}
          sub={
            <>
              {rank ? t("competitors.stat.rank", { rank, count: rows.length }) : "—"}
              {delta != null && delta !== 0 && (
                <span className={delta > 0 ? "ml-1 text-[#006300] dark:text-[#0ca30c]" : "ml-1 text-red-700 dark:text-red-400"}>
                  {delta > 0 ? "▲" : "▼"} {t("competitors.stat.points", { delta: Math.abs(delta) })}
                </span>
              )}
            </>
          }
        />
        <Stat label={t("competitors.stat.mentionShare")} value={fmtPct(intlLocale, data.site.mentionShare)} sub={t("competitors.stat.citedInQueries", { count: data.site.citedQueriesCount })} />
        <Stat label={t("competitors.stat.citationGap")} value={data.citationGapTotal} tone={data.citationGapTotal ? "serious" : "good"} sub={t("competitors.stat.citationGapSub")} />
        <Stat
          label={t("competitors.stat.brandTone")}
          value={<span className="text-lg">{sentimentLabel(t, mood)}</span>}
          tone={mood === "unknown" ? "neutral" : SENTIMENT_TONE[mood]}
          sub={t("competitors.stat.toneFound", { found: bs.samples - bs.sentiment.unknown, total: bs.samples })}
        />
        <Stat
          label={t("competitors.stat.hallucination")}
          value={bs.hallucinations.findingCount}
          tone={bs.hallucinations.findingCount ? "critical" : bs.hallucinations.checkedFacts ? "good" : "neutral"}
          sub={bs.hallucinations.checkedFacts ? t("competitors.stat.factsChecked", { count: bs.hallucinations.checkedFacts }) : t("competitors.stat.noFacts")}
        />
      </div>

      {noCompetitors && (
        <EmptyState icon="⚔" title={t("competitors.empty.noCompetitorsTitle")}>
          {t("competitors.empty.noCompetitorsHint")}
        </EmptyState>
      )}
      {empty ? (
        <EmptyState
          icon="🤖"
          title={t("competitors.empty.noAnswersTitle", { count: data.window.days })}
          action={
            !testing && (
              <Button variant="primary" onClick={() => setTesting(true)}>
                {t("competitors.empty.startTest")}
              </Button>
            )
          }
        >
          {t("competitors.empty.noAnswersHint")}
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t("competitors.card.overallTitle")} subtitle={t("competitors.card.overallSubtitle", { count: data.site.samples, days: data.window.days })}>
              <ShareDonut rows={rows} />
            </Card>
            <Card title={t("competitors.card.perModelTitle")} subtitle={t("competitors.card.perModelSubtitle")}>
              <ModelShareBars perModel={data.perModel} rows={rows} models={VISIBILITY_MODEL_ORDER} />
            </Card>
          </div>

          <Card
            title={t("competitors.card.trendTitle")}
            subtitle={t("competitors.card.trendSubtitle")}
            action={
              <Segmented
                label={t("competitors.card.trendRange")}
                value={granularity}
                onChange={setGranularity}
                options={[
                  { value: "day", label: t("competitors.card.daily") },
                  { value: "week", label: t("competitors.card.weekly") },
                ]}
              />
            }
          >
            {data.trend.points.length ? (
              <ShareTrendChart dates={data.trend.points.map((p) => p.start)} series={series} granularity={data.trend.granularity} />
            ) : (
              <p className="text-sm text-zinc-500">{t("competitors.card.noTrend")}</p>
            )}
          </Card>

          {!noCompetitors && <GapMatrix report={data} filter={gapFilter} onFilter={setGapFilter} />}

          <BrandSafety report={data} />

          {rows.some((r) => !r.isSite && r.topCitedUrls.length) && (
            <Card title={t("competitors.card.topPagesTitle")} subtitle={t("competitors.card.topPagesSubtitle")}>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {rows
                  .filter((r) => !r.isSite && r.topCitedUrls.length)
                  .map((r) => (
                    <div key={r.domain} className="min-w-0">
                      <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                        <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: r.color }} />
                        {r.name}
                        <span className="text-xs font-normal text-zinc-500">{t("competitors.card.gapsCount", { count: r.gapQueries })}</span>
                      </div>
                      <ol className="space-y-0.5 text-xs">
                        {r.topCitedUrls.slice(0, 5).map((u) => (
                          <li key={u.url} className="flex gap-2">
                            <span className="tabular-nums text-zinc-400">{u.count}×</span>
                            <a href={u.url} target="_blank" rel="noopener noreferrer" className="truncate text-indigo-600 hover:underline dark:text-indigo-400" title={u.url}>
                              {u.url.replace(/^https?:\/\/(www\.)?/, "")}
                            </a>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
              </div>
            </Card>
          )}
        </>
      )}

      <CompetitorManager onSaved={bump} />
      <p className="text-xs text-zinc-400">
        {t("competitors.footer", { method: data.method, date: formatDate(data.site.lastCheckedAt) })}
      </p>
    </div>
  );
}

