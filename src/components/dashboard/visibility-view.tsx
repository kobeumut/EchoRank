"use client";

import { useMemo, useState } from "react";
import { aggregateCompetitors } from "@/lib/dashboard/competitors";
import { CITATION_LABELS, formatDate, MODEL_LABELS, timeAgo, VISIBILITY_MODEL_ORDER } from "@/lib/dashboard/format";
import { highlightSegments, siteTerms } from "@/lib/dashboard/highlight";
import { apiFetch, ApiError, useApi } from "./api";
import { useSite } from "./site-shell";
import { useToast } from "./toast";
import type { QuerySuggestion, VisibilityList, VisibilityRecord, VisibilityRunResult } from "./types";
import { Badge, Button, Card, cx, EmptyState, ErrorState, inputClass, Segmented, SkeletonCard, Spinner } from "./ui";

const INTENT_LABELS: Record<QuerySuggestion["intent"], string> = {
  informational: "Bilgi",
  comparative: "Karşılaştırma",
  transactional: "Satın alma",
  reputation: "İtibar",
};
const LEVEL_LABELS = { low: "düşük", medium: "orta", high: "yüksek" } as const;

const STATUS_TONE = { cited: "good", mentioned: "warning", none: "critical" } as const;
const ERROR_LABELS: Record<string, string> = {
  not_configured: "API anahtarı / model tanımlı değil",
  provider_error: "Sağlayıcı hatası",
  timeout: "Zaman aşımı",
  rate_limited: "Hız limiti",
  invalid_response: "Geçersiz yanıt",
};

function meta(r: VisibilityRecord) {
  const m = r.responseMeta && typeof r.responseMeta === "object" && !Array.isArray(r.responseMeta) ? (r.responseMeta as Record<string, unknown>) : {};
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { citedUrls: arr(m.citedUrls), citations: arr(m.citations), competitors: arr(m.competitorDomains), modelId: typeof m.modelId === "string" ? m.modelId : null };
}

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  const segs = highlightSegments(text, terms);
  return (
    <>
      {segs.map((s, i) =>
        s.match ? (
          <mark key={i} className="site-hit">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function AnswerCard({ record, site }: { record: VisibilityRecord; site: { url: string; title: string } }) {
  const [open, setOpen] = useState(false);
  const m = meta(record);
  const terms = siteTerms(site, m.citedUrls);
  const tone = STATUS_TONE[record.citationStatus as keyof typeof STATUS_TONE] ?? "neutral";
  const text = record.excerpt ?? "";
  const long = text.length > 420;
  return (
    <div className="flex flex-col rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{MODEL_LABELS[record.model] ?? record.model}</span>
        <Badge tone={tone} icon>
          {CITATION_LABELS[record.citationStatus] ?? record.citationStatus}
        </Badge>
        {record.position != null && <Badge>#{record.position}. sırada</Badge>}
        <span className="ml-auto text-xs text-zinc-400" title={formatDate(record.checkedAt)}>
          {timeAgo(record.checkedAt)}
        </span>
      </div>
      {text ? (
        <div className={cx("relative mt-2 whitespace-pre-wrap text-xs leading-relaxed text-zinc-700 dark:text-zinc-300", !open && long && "max-h-32 overflow-hidden")}>
          <Highlighted text={text} terms={terms} />
          {!open && long && <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white dark:from-zinc-900" />}
        </div>
      ) : (
        <p className="mt-2 text-xs italic text-zinc-400">Yanıt metni kaydedilmemiş.</p>
      )}
      {long && (
        <button type="button" className="mt-1 self-start text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Daralt" : "Yanıtın tamamı"}
        </button>
      )}
      {(m.citedUrls.length > 0 || m.competitors.length > 0) && (
        <div className="mt-2 space-y-1 border-t border-zinc-100 pt-2 text-xs dark:border-zinc-800">
          {m.citedUrls.length > 0 && (
            <div>
              <span className="text-zinc-500">Sitenizden kaynak: </span>
              {m.citedUrls.slice(0, 3).map((u) => (
                <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="mr-2 break-all text-[#006300] hover:underline dark:text-[#0ca30c]">
                  {u}
                </a>
              ))}
            </div>
          )}
          {m.competitors.length > 0 && (
            <div className="text-zinc-500">
              Diğer kaynaklar: <span className="text-zinc-700 dark:text-zinc-300">{m.competitors.slice(0, 6).join(", ")}</span>
              {m.competitors.length > 6 && ` +${m.competitors.length - 6}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunPanel({ suggestions, details = [], onDone }: { suggestions: string[]; details?: QuerySuggestion[]; onDone: () => void }) {
  const labels = useMemo(() => new Map(details.map((d) => [d.text, d])), [details]);
  const { siteId } = useSite();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(suggestions.slice(0, 3)));
  const [custom, setCustom] = useState("");
  const [models, setModels] = useState<Set<string>>(new Set(VISIBILITY_MODEL_ORDER));
  const [refresh, setRefresh] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<VisibilityRunResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  const customQueries = custom
    .split("\n")
    .map((q) => q.trim())
    .filter(Boolean);
  const queries = [...new Set([...selected, ...customQueries])];
  const tooMany = queries.length > 10;

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<VisibilityRunResult>(`/api/sites/${siteId}/visibility`, {
        method: "POST",
        json: { queries, models: VISIBILITY_MODEL_ORDER.filter((m) => models.has(m)), refresh },
      });
      setResult(res);
      toast.push(res.successful ? "success" : "error", res.successful ? `${res.successful}/${res.attempted} kontrol tamamlandı.` : "Hiçbir kontrol tamamlanamadı.");
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  }

  const failures = result?.items.filter((i) => i.error) ?? [];
  const failureSummary = [...new Set(failures.map((f) => `${MODEL_LABELS[f.model] ?? f.model}: ${ERROR_LABELS[f.error!] ?? f.error}`))];

  return (
    <Card title="Görünürlük simülasyonu" subtitle="Seçilen sorguları modellerin web aramalı yanıtlarına sorar; sitenin atıf alıp almadığını ve sıralamasını kaydeder.">
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Sorgular</div>
          {suggestions.length ? (
            <ul className="max-h-48 space-y-1 overflow-auto pr-1">
              {suggestions.map((q) => (
                <li key={q}>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 accent-indigo-600"
                      checked={selected.has(q)}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(q);
                          else next.delete(q);
                          return next;
                        })
                      }
                    />
                    <span>
                      {q}
                      {labels.get(q) && (
                        <span
                          className="ml-2 inline-flex gap-1 align-middle"
                          title={`Rekabet: ${LEVEL_LABELS[labels.get(q)!.difficulty.level]} · Tahmini hacim: ${LEVEL_LABELS[labels.get(q)!.volume.level]}${labels.get(q)!.branded ? " · Marka adı içerir" : ""}`}
                        >
                          <Badge>{INTENT_LABELS[labels.get(q)!.intent]}</Badge>
                          <Badge>{labels.get(q)!.language.toUpperCase()}</Badge>
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">Öneri yok: hedef anahtar kelime ekleyin veya önce analiz çalıştırın.</p>
          )}
          <textarea rows={3} placeholder="Kendi sorgularınız (her satıra bir tane)" value={custom} onChange={(e) => setCustom(e.target.value)} className={`${inputClass} mt-3`} aria-label="Özel sorgular" />
        </div>
        <div className="flex flex-col">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Modeller</div>
          <div className="flex flex-wrap gap-2">
            {VISIBILITY_MODEL_ORDER.map((m) => (
              <label key={m} className={cx("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", models.has(m) ? "border-indigo-400 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950/50" : "border-zinc-200 dark:border-zinc-700")}>
                <input
                  type="checkbox"
                  className="accent-indigo-600"
                  checked={models.has(m)}
                  onChange={(e) =>
                    setModels((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(m);
                      else next.delete(m);
                      return next;
                    })
                  }
                />
                {MODEL_LABELS[m]}
              </label>
            ))}
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" className="accent-indigo-600" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} />
            24 saatlik önbelleği atla (yeniden sor)
          </label>
          <div className="mt-auto pt-4">
            <p className="mb-2 text-xs text-zinc-500">
              {queries.length} sorgu × {models.size} model = <b>{queries.length * models.size}</b> ücretli API çağrısı (önbellekteki sonuçlar hariç).
              {tooMany && <span className="text-red-600 dark:text-red-400"> En fazla 10 sorgu seçilebilir.</span>}
            </p>
            <Button variant="primary" onClick={() => void run()} loading={running} disabled={!queries.length || !models.size || tooMany}>
              Testi Başlat
            </Button>
            {running && (
              <p className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
                <Spinner className="h-3 w-3" /> Modeller sorgulanıyor; bu işlem birkaç dakika sürebilir. Sayfadan ayrılmayın.
              </p>
            )}
          </div>
        </div>
      </div>
      {error != null && (
        <div className="mt-4">
          <ErrorState
            error={
              error instanceof ApiError && error.status === 503
                ? new Error("Ücretli görünürlük testleri için sunucuda API_TOKEN tanımlanmalı ve panele giriş yapılmalı.")
                : error instanceof ApiError && error.status === 409
                  ? new Error("Şu anda başka bir görünürlük testi çalışıyor. Bitince tekrar deneyin.")
                  : error
            }
          />
        </div>
      )}
      {result && (
        <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-950">
          <b>{result.successful}</b>/{result.attempted} kontrol başarılı{result.citationRate != null && <> · atıf oranı <b>%{result.citationRate}</b></>}
          {failureSummary.length > 0 && <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">Atlananlar: {failureSummary.join(" · ")}</div>}
        </div>
      )}
    </Card>
  );
}

export function VisibilityView() {
  const { siteId, site, version } = useSite();
  const [reload, setReload] = useState(0);
  const list = useApi<VisibilityList>(`/api/sites/${siteId}/visibility?limit=100`, { version: `${version}:${reload}` });
  const [model, setModel] = useState("all");
  const [status, setStatus] = useState("all");

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const competitors = useMemo(() => aggregateCompetitors(items, site.url), [items, site.url]);
  const filtered = items.filter((r) => (model === "all" || r.model === model) && (status === "all" || r.citationStatus === status));
  const byQuery = useMemo(() => {
    const groups = new Map<string, VisibilityRecord[]>();
    for (const r of filtered) {
      const g = groups.get(r.query) ?? [];
      // Latest answer per model for each query (items are newest first).
      if (!g.some((x) => x.model === r.model)) g.push(r);
      groups.set(r.query, g);
    }
    const order = (m: string) => {
      const i = (VISIBILITY_MODEL_ORDER as readonly string[]).indexOf(m);
      return i === -1 ? 99 : i;
    };
    return [...groups.entries()].map(([q, rs]) => [q, rs.sort((a, b) => order(a.model) - order(b.model))] as const);
  }, [filtered]);

  if (list.loading)
    return (
      <div className="space-y-4">
        <SkeletonCard lines={6} />
        <SkeletonCard lines={4} />
      </div>
    );
  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.reload()} />;

  return (
    <div className="space-y-4">
      <RunPanel key={list.data!.queries.join("|")} suggestions={list.data!.queries} details={list.data!.querySuggestions} onDone={() => setReload((r) => r + 1)} />

      {!items.length ? (
        <EmptyState icon="🤖" title="Henüz görünürlük kaydı yok">
          Yukarıdan sorgu ve model seçip testi başlatın. Her yanıtta sitenizin geçtiği kısımlar vurgulanır ve rakip kaynaklar listelenir.
        </EmptyState>
      ) : (
        <>
          <Card title="Rakip atıf analizi" subtitle={`Son ${items.length} yanıtta kaynak gösterilen alan adları — sitenizle karşılaştırmalı`}>
            {competitors.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-zinc-500">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Alan adı</th>
                      <th className="py-2 pr-3 text-right font-medium">Atıf alan yanıt</th>
                      <th className="py-2 pr-3 font-medium">Pay</th>
                      <th className="py-2 pr-3 font-medium">Modeller</th>
                      <th className="py-2 font-medium">Örnek sorgu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {competitors.map((c) => (
                      <tr key={c.domain} className={cx("border-t border-zinc-100 dark:border-zinc-800", c.isSite && "bg-emerald-50/60 dark:bg-emerald-950/30")}>
                        <td className="py-2 pr-3 font-medium">
                          {c.domain} {c.isSite && <Badge tone="good">Siteniz</Badge>}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{c.answers}</td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-24 overflow-hidden rounded-full bg-[var(--chart-grid)]">
                              <div className="h-full rounded-full" style={{ width: `${c.share}%`, background: c.isSite ? "#0ca30c" : "var(--series-1)" }} />
                            </div>
                            <span className="text-xs tabular-nums text-zinc-500">%{c.share}</span>
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-xs text-zinc-500">{c.models.map((m) => MODEL_LABELS[m] ?? m).join(", ")}</td>
                        <td className="max-w-xs truncate py-2 text-xs text-zinc-500" title={c.queries.join("\n")}>
                          {c.queries[0]}
                          {c.queries.length > 1 && ` +${c.queries.length - 1}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">Yanıtlarda kaynak alan adı bulunamadı.</p>
            )}
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold">Sorgu bazında yanıtlar</h2>
            <Segmented
              label="Model"
              value={model}
              onChange={setModel}
              options={[{ value: "all", label: "Tümü" }, ...VISIBILITY_MODEL_ORDER.map((m) => ({ value: m as string, label: MODEL_LABELS[m] }))]}
            />
            <Segmented
              label="Sonuç"
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: "Hepsi" },
                { value: "cited", label: "Atıf" },
                { value: "mentioned", label: "Bahsedildi" },
                { value: "none", label: "Yok" },
              ]}
            />
            <span className="ml-auto text-xs text-zinc-500">{list.data!.total} kayıt</span>
          </div>
          {byQuery.length === 0 ? (
            <EmptyState title="Filtreye uyan yanıt yok" />
          ) : (
            byQuery.map(([query, records]) => (
              <Card key={query} title={<>“{query}”</>} subtitle={`${records.length} model yanıtı`}>
                <div className="grid gap-3 md:grid-cols-2">
                  {records.map((r) => (
                    <AnswerCard key={r.id} record={r} site={site} />
                  ))}
                </div>
              </Card>
            ))
          )}
        </>
      )}
    </div>
  );
}
