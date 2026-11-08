"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  brandRows, citeMagnetTip, dominantSentiment, filterGaps, type GapFilter, gapDomains, gapFactors, gapsCsv, INTENT_LABELS, INTENT_ORDER,
  SENTIMENT_LABELS, SENTIMENT_TONE, siteRank, siteTrendDelta, somCsv, trendSeries,
} from "@/lib/dashboard/competitor-intel";
import { formatDate, hostOf, MODEL_LABELS, timeAgo, VISIBILITY_MODEL_ORDER } from "@/lib/dashboard/format";
import { apiFetch, errorMessage, useApi } from "./api";
import { useSite } from "./site-shell";
import { ModelShareBars, ShareDonut, ShareTrendChart } from "./som-charts";
import { useToast } from "./toast";
import type { CitationGap, CompetitorReport, QueryIntent, SentimentLabel, VisibilityList } from "./types";
import { Badge, Button, Card, cx, downloadText, EmptyState, ErrorState, inputBase, Segmented, SkeletonCard, Spinner, TONE_COLOR } from "./ui";
import { RunPanel } from "./visibility-view";

type Competitor = { title: string; url: string };
const object = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `%${Math.round(v * 10) / 10}`);
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
      toast.push("success", "Rakip listesi güncellendi.");
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
    <Card title="Takip edilen rakipler" subtitle="Model payı yalnızca siteniz ve buradaki rakipler arasında hesaplanır (tüm AI pazarı değil).">
      {configured.length ? (
        <ul className="mb-3 flex flex-wrap gap-2">
          {configured.map((c) => (
            <li key={c.url} className="flex items-center gap-1.5 rounded-full border border-zinc-200 py-1 pl-3 pr-1 text-sm dark:border-zinc-700">
              <span className="font-medium">{c.title}</span>
              <span className="text-xs text-zinc-500">{hostOf(c.url)}</span>
              <button
                type="button"
                className="ml-1 rounded-full px-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800"
                aria-label={`${c.title} rakibini kaldır`}
                disabled={saving}
                onClick={() => void save(configured.filter((x) => x.url !== c.url))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-zinc-500">Henüz rakip eklenmedi.</p>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !duplicate) void save([...configured, { title: title.trim() || hostOf(normalized), url: normalized }]);
        }}
      >
        <input className={cx(inputBase, "w-40")} placeholder="Marka adı" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Rakip marka adı" maxLength={200} />
        <input className={cx(inputBase, "min-w-0 flex-1")} placeholder="rakip.com" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Rakip web adresi" />
        <Button type="submit" variant="secondary" loading={saving} disabled={!valid || duplicate || configured.length >= 20}>
          Rakip ekle
        </Button>
      </form>
      {duplicate && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Bu alan adı zaten listede.</p>}
    </Card>
  );
}

// ---------------------------------------------------------------- new test

function NewTestPanel({ onDone }: { onDone: () => void }) {
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
      toast.push("success", `${res.created ?? 0} yeni sentetik sorgu kaydedildi.`);
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
          {synthetic.length ? `${synthetic.length} kayıtlı sentetik sorgu (dört niyet) listenin başında.` : "Kayıtlı sentetik sorgu yok."} Sonuçlar tamamlanınca model payı yeniden hesaplanır.
        </span>
        <Button size="sm" variant="secondary" loading={generating} onClick={() => void generate()}>
          Sentetik sorgu üret
        </Button>
      </div>
      <RunPanel key={suggestions.join("|")} suggestions={suggestions} details={list.data!.querySuggestions} onDone={onDone} />
    </div>
  );
}

// ---------------------------------------------------------------- citation gaps

function GapRow({ gap, columns, open, onToggle }: { gap: CitationGap; columns: string[]; open: boolean; onToggle: () => void }) {
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
            <Badge>{INTENT_LABELS[gap.intent]}</Badge>
            <Badge>{MODEL_LABELS[gap.model] ?? gap.model}</Badge>
            {factors.length > 0 && <Badge tone="warning">{factors.length} Cite-Magnet ipucu</Badge>}
          </div>
        </td>
        <td className="py-2 pr-3 text-center">
          <Badge tone={gap.targetMentioned ? "warning" : "critical"} icon>
            {gap.targetMentioned ? "Bahsedildi" : "Yok"}
          </Badge>
        </td>
        {columns.map((d) => (
          <td key={d} className="py-2 pr-3 text-center">
            {cited.has(d) ? (
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-700 dark:bg-red-900/50 dark:text-red-200" title={`${d} atıf aldı:\n${cited.get(d)!.urls.join("\n")}`}>
                {cited.get(d)!.urls.length || "●"}
              </span>
            ) : (
              <span className="text-zinc-300 dark:text-zinc-700" aria-label="Atıf yok">·</span>
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
                <div className="mb-1 font-medium uppercase tracking-wide text-zinc-500">Atıf alan rakip sayfalar</div>
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
                  En yakın sayfanız:{" "}
                  {gap.targetPage ? (
                    <a href={gap.targetPage} target="_blank" rel="noopener noreferrer" className="break-all text-indigo-600 hover:underline dark:text-indigo-400">
                      {gap.targetPage}
                    </a>
                  ) : (
                    "eşleşen taranmış sayfa yok — bu sorgu için içerik boşluğu olabilir."
                  )}
                </p>
                <p className="mt-1 text-zinc-400">
                  {formatDate(gap.checkedAt)} · niyet {gap.intentSource === "synthetic_query" ? "kayıtlı sentetik sorgudan" : "anahtar kelime sınıflandırıcısından"}
                </p>
              </div>
              <div>
                <div className="mb-1 font-medium uppercase tracking-wide text-zinc-500">Cite-Magnet ipuçları — rakip neden seçildi?</div>
                {factors.length ? (
                  <ul className="space-y-2">
                    {factors.map((f) => {
                      const t = citeMagnetTip(f);
                      return (
                        <li key={f} className="rounded-md border border-amber-200 bg-amber-50 p-2 dark:border-amber-900/60 dark:bg-amber-950/30">
                          <div className="font-medium text-amber-900 dark:text-amber-200">{t.label}</div>
                          <div className="text-amber-800/90 dark:text-amber-200/80">{t.tip}</div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-zinc-500">
                    Karşılaştırma için rakip sayfa anlık görüntüsü yok. Rakip sayfaları <code>visibilityAnalysis.referencePages</code> olarak ekleyin; kelime kapsamı, şema, tablo ve istatistik
                    yoğunluğu otomatik kıyaslanır.
                  </p>
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
      title="Rakip atıf boşlukları"
      subtitle={`Rakiplerin kaynak gösterilip sitenizin gösterilmediği yanıtlar · toplam ${report.citationGapTotal}${report.citationGapTotal > gaps.length ? ` (ilk ${gaps.length} listeleniyor)` : ""}`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          label="Sorgu niyeti"
          value={intent}
          onChange={(v) => set({ intent: v })}
          options={[{ value: "all" as const, label: "Tümü", count: gaps.length }, ...INTENT_ORDER.map((i) => ({ value: i, label: INTENT_LABELS[i], count: localCounts[i] }))]}
        />
        <select className={cx(inputBase, "py-1.5 text-xs")} value={model} onChange={(e) => set({ model: e.target.value })} aria-label="Model filtresi">
          <option value="all">Tüm modeller</option>
          {VISIBILITY_MODEL_ORDER.map((m) => (
            <option key={m} value={m}>
              {MODEL_LABELS[m]}
            </option>
          ))}
        </select>
        <select className={cx(inputBase, "py-1.5 text-xs")} value={competitor} onChange={(e) => set({ competitor: e.target.value })} aria-label="Rakip filtresi">
          <option value="all">Tüm rakipler</option>
          {domains.map((d) => (
            <option key={d.domain} value={d.domain}>
              {d.domain} ({d.count})
            </option>
          ))}
        </select>
        <input className={cx(inputBase, "min-w-0 flex-1 py-1.5 text-xs")} placeholder="Sorgu ara…" value={search} onChange={(e) => set({ search: e.target.value })} aria-label="Sorgu ara" />
      </div>
      {!filtered.length ? (
        <EmptyState icon="✓" title={gaps.length ? "Filtreye uyan boşluk yok" : "Atıf boşluğu bulunamadı"}>
          {gaps.length ? "Filtreleri genişletin." : "Bu pencerede rakiplerin öne geçtiği bir yanıt yok."}
        </EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">Sorgu</th>
                  <th className="py-2 pr-3 text-center font-medium">Siz</th>
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
                Daha fazla göster ({filtered.length - limit})
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
  const polarity = new Map(terms.map((t) => [t.term.toLocaleLowerCase("tr"), t.polarity]));
  return (
    <>
      {text.split(/([\p{L}']+)/u).map((part, i) => {
        const p = polarity.get(part.toLocaleLowerCase("tr"));
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
  const bs = report.brandSafety;
  const [tone, setTone] = useState<SentimentLabel | "all">("all");
  const known = bs.sentiment.positive + bs.sentiment.neutral + bs.sentiment.negative;
  const evidence = bs.evidence.filter((e) => tone === "all" || e.label === tone);
  const h = bs.hallucinations;
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3" title="Duygu durumu" subtitle="Yanıtlarda markanızın geçtiği cümlelerin tonu (EN/TR sözlük; insan incelemesi için kanıt)">
        <div className="grid grid-cols-3 gap-2">
          {(["positive", "neutral", "negative"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setTone((t) => (t === l ? "all" : l))}
              aria-pressed={tone === l}
              className={cx("rounded-lg border p-3 text-left transition-shadow", SENTIMENT_CARD[l], tone === l && "ring-2 ring-indigo-500/60")}
            >
              <div className="text-xs font-medium">{SENTIMENT_LABELS[l]}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{bs.sentiment[l]}</div>
              <div className="text-xs opacity-75">{known ? `%${Math.round((bs.sentiment[l] / known) * 100)} yanıt` : "—"}</div>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          {bs.sentiment.unknown} yanıtta marka cümlesi bulunamadı
          {bs.sentiment.averageScore != null && <> · ortalama skor {bs.sentiment.averageScore} (-1…1)</>}
          {bs.textCoverage.truncated > 0 && <> · {bs.textCoverage.truncated} yanıt kısaltılmış metinden analiz edildi</>}
        </p>
        <div className="mt-4 space-y-2">
          {VISIBILITY_MODEL_ORDER.map((m) => {
            const c = bs.perModel[m];
            const total = c ? c.positive + c.neutral + c.negative : 0;
            const dom = c ? dominantSentiment(c) : "unknown";
            return (
              <div key={m} className="flex items-center gap-3 text-sm">
                <span className="w-24 shrink-0 font-medium">{MODEL_LABELS[m]}</span>
                <div className="flex h-2.5 flex-1 gap-[2px] overflow-hidden rounded">
                  {total ? (
                    (["positive", "neutral", "negative"] as const).map((l) =>
                      c![l] ? <div key={l} title={`${SENTIMENT_LABELS[l]}: ${c![l]}`} style={{ width: `${(c![l] / total) * 100}%`, background: SENTIMENT_BAR[l] }} /> : null,
                    )
                  ) : (
                    <div className="w-full bg-[var(--chart-grid)]" />
                  )}
                </div>
                <Badge tone={SENTIMENT_TONE[dom]} icon className="w-28 justify-center">
                  {total ? SENTIMENT_LABELS[dom] : "Veri yok"}
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
                    {SENTIMENT_LABELS[e.label]}
                  </Badge>
                  <span className="font-medium">{MODEL_LABELS[e.model] ?? e.model}</span>
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
          <p className="mt-4 text-xs text-zinc-500">{tone === "all" ? "Marka hakkında tonu belirlenebilen cümle yok." : "Bu tonda kanıt yok."}</p>
        )}
      </Card>

      <Card
        className="lg:col-span-2"
        title={
          <span className="flex items-center gap-2">
            Halüsinasyon uyarı merkezi
            {h.findingCount > 0 && (
              <Badge tone="critical" icon>
                {h.findingCount}
              </Badge>
            )}
          </span>
        }
        subtitle="Doğrulanmış marka gerçekleriyle çelişen model iddiaları"
      >
        {h.checkedFacts === 0 ? (
          <EmptyState icon="ⓘ" title="Doğrulanmış gerçek tanımlı değil">
            Fiyat, kuruluş yılı, merkez gibi doğrulanmış bilgileri ve çelişen ifadeleri site ayarlarında <code>visibilityAnalysis.facts</code> altında tanımlayın; model yanıtları bu kurallarla
            otomatik denetlenir.
          </EmptyState>
        ) : !h.items.length ? (
          <EmptyState icon="✓" title="Olası halüsinasyon yok">
            {h.checkedFacts} doğrulanmış gerçek, {bs.samples} yanıtta kontrol edildi.
          </EmptyState>
        ) : (
          <>
            <p className="mb-2 text-xs text-zinc-500">
              {h.affectedAnswers} yanıtta {h.findingCount} olası yanlış bilgi · {h.checkedFacts} gerçek denetlendi
            </p>
            <ul className="max-h-[32rem] space-y-2 overflow-auto pr-1">
              {h.items.map((f, i) => (
                <li key={`${f.recordId}-${i}`} className="rounded-lg border border-red-200 bg-red-50/60 p-3 text-xs dark:border-red-900/60 dark:bg-red-950/30">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge tone="critical" icon>
                      Olası halüsinasyon
                    </Badge>
                    <span className="font-medium">{MODEL_LABELS[f.model] ?? f.model}</span>
                    <span className="ml-auto text-zinc-400">{timeAgo(f.checkedAt)}</span>
                  </div>
                  <blockquote className="border-l-2 border-red-300 pl-2 italic leading-relaxed text-zinc-800 dark:border-red-800 dark:text-zinc-200">“{f.text}”</blockquote>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                    <dt className="text-zinc-500">Konu</dt>
                    <dd>{f.subject}</dd>
                    <dt className="text-zinc-500">Çelişen iddia</dt>
                    <dd className="font-medium text-red-700 dark:text-red-300">{f.conflictingClaim}</dd>
                    <dt className="text-zinc-500">Doğrusu</dt>
                    <dd className="text-emerald-800 dark:text-emerald-300">{f.expected}</dd>
                    <dt className="text-zinc-500">Sorgu</dt>
                    <dd className="truncate" title={f.query}>
                      {f.query}
                    </dd>
                  </dl>
                  <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-indigo-600 hover:underline dark:text-indigo-400">
                    Kanıt kaynağı ↗
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
          label="Zaman penceresi"
          value={days}
          onChange={setDays}
          options={[
            { value: "7", label: "7 gün" },
            { value: "30", label: "30 gün" },
            { value: "90", label: "90 gün" },
          ]}
        />
        {busy && (
          <span className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Spinner className="h-3 w-3" /> Yeniden hesaplanıyor…
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={empty} onClick={() => downloadText(somCsv(data, VISIBILITY_MODEL_ORDER), `${slug}-model-payi-${stamp}.csv`, "text/csv;charset=utf-8")}>
            ⇩ SoM CSV
          </Button>
          <Button size="sm" variant="ghost" disabled={!gapsForExport.length} title="Geçerli filtreyle atıf boşlukları" onClick={() => downloadText(gapsCsv(gapsForExport), `${slug}-atif-bosluklari-${stamp}.csv`, "text/csv;charset=utf-8")}>
            ⇩ Boşluklar CSV
          </Button>
          <Button size="sm" variant="ghost" onClick={() => downloadText(JSON.stringify(data, null, 2), `${slug}-rakip-raporu-${stamp}.json`, "application/json")}>
            ⇩ JSON
          </Button>
          <Button size="sm" variant={testing ? "secondary" : "primary"} onClick={() => setTesting((t) => !t)} aria-expanded={testing}>
            {testing ? "Testi gizle" : "＋ Yeni SoM testi"}
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
          {!data.settingsValid && <div>Site ayarlarındaki visibilityAnalysis geçersiz; varsayılanlarla hesaplandı.</div>}
          {data.window.truncated && <div>Penceredeki {data.window.total} yanıttan en yeni {data.window.limit} tanesi analiz edildi.</div>}
          {data.warnings.map((w) => (
            <div key={w}>{w.replace("Overlapping competitor ignored", "Siteyle çakışan rakip yok sayıldı")}</div>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          label="Model payınız"
          value={fmtPct(data.site.shareOfModel)}
          tone={rank === 1 && !empty ? "good" : rank && rank > 2 ? "critical" : "warning"}
          sub={
            <>
              {rank ? `${rows.length} marka içinde #${rank}` : "—"}
              {delta != null && delta !== 0 && (
                <span className={delta > 0 ? "ml-1 text-[#006300] dark:text-[#0ca30c]" : "ml-1 text-red-700 dark:text-red-400"}>
                  {delta > 0 ? "▲" : "▼"} {Math.abs(delta)} puan
                </span>
              )}
            </>
          }
        />
        <Stat label="Bahsedilme payı" value={fmtPct(data.site.mentionShare)} sub={`${data.site.citedQueriesCount} sorguda atıf`} />
        <Stat label="Atıf boşluğu" value={data.citationGapTotal} tone={data.citationGapTotal ? "serious" : "good"} sub="rakibin öne geçtiği yanıt" />
        <Stat label="Marka tonu" value={<span className="text-lg">{SENTIMENT_LABELS[mood]}</span>} tone={mood === "unknown" ? "neutral" : SENTIMENT_TONE[mood]} sub={`${bs.samples - bs.sentiment.unknown}/${bs.samples} yanıtta ton bulundu`} />
        <Stat
          label="Halüsinasyon"
          value={bs.hallucinations.findingCount}
          tone={bs.hallucinations.findingCount ? "critical" : bs.hallucinations.checkedFacts ? "good" : "neutral"}
          sub={bs.hallucinations.checkedFacts ? `${bs.hallucinations.checkedFacts} gerçek denetlendi` : "doğrulanmış gerçek yok"}
        />
      </div>

      {noCompetitors && (
        <EmptyState icon="⚔" title="Rakip tanımlanmadı">
          Model payını karşılaştırmak için aşağıdan rakip markaları ekleyin. Paylar yalnızca siteniz ve tanımlı rakipler arasında hesaplanır.
        </EmptyState>
      )}
      {empty ? (
        <EmptyState
          icon="🤖"
          title={`Son ${data.window.days} günde model yanıtı yok`}
          action={
            !testing && (
              <Button variant="primary" onClick={() => setTesting(true)}>
                Yeni SoM testi başlat
              </Button>
            )
          }
        >
          Sentetik veya kendi sorgularınızla ChatGPT, Gemini, Claude ve Perplexity yanıtlarını toplayın; model payı, atıf boşlukları ve marka tonu burada görünür.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Genel model payı (Share of Model)" subtitle={`Atıf payı · ${data.site.samples} yanıt · son ${data.window.days} gün`}>
              <ShareDonut rows={rows} />
            </Card>
            <Card title="Model bazında pay" subtitle="Her modelde markalar arası atıf dağılımı (çerçeveli dilim: siteniz)">
              <ModelShareBars perModel={data.perModel} rows={rows} models={VISIBILITY_MODEL_ORDER} />
            </Card>
          </div>

          <Card
            title="Model payı trendi"
            subtitle="Her dönem kendi yanıtları üzerinden hesaplanır"
            action={
              <Segmented
                label="Trend aralığı"
                value={granularity}
                onChange={setGranularity}
                options={[
                  { value: "day", label: "Günlük" },
                  { value: "week", label: "Haftalık" },
                ]}
              />
            }
          >
            {data.trend.points.length ? (
              <ShareTrendChart dates={data.trend.points.map((p) => p.start)} series={series} granularity={data.trend.granularity} />
            ) : (
              <p className="text-sm text-zinc-500">Trend için yeterli veri yok.</p>
            )}
          </Card>

          {!noCompetitors && <GapMatrix report={data} filter={gapFilter} onFilter={setGapFilter} />}

          <BrandSafety report={data} />

          {rows.some((r) => !r.isSite && r.topCitedUrls.length) && (
            <Card title="Rakiplerin en çok atıf alan sayfaları" subtitle="Bu sayfaları inceleyerek modellerin hangi içerik formatını ödüllendirdiğini görün">
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {rows
                  .filter((r) => !r.isSite && r.topCitedUrls.length)
                  .map((r) => (
                    <div key={r.domain} className="min-w-0">
                      <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                        <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: r.color }} />
                        {r.name}
                        <span className="text-xs font-normal text-zinc-500">· {r.gapQueries} boşluk</span>
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
        Yöntem: {data.method} · {formatDate(data.site.lastCheckedAt)} · Paylar tanımlı markalar arasındadır; tüm AI pazarını temsil etmez.
      </p>
    </div>
  );
}

