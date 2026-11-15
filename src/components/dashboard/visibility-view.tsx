"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { aggregateCompetitors } from "@/lib/dashboard/competitors";
import { VISIBILITY_MODEL_ORDER } from "@/lib/dashboard/format";
import { highlightSegments, siteTerms } from "@/lib/dashboard/highlight";
import { apiFetch, ApiError, useApi } from "./api";
import { useSite } from "./site-shell";
import { useToast } from "./toast";
import type { ProviderStatus, QuerySuggestion, TransportMode, VisibilityList, VisibilityRecord, VisibilityRunResult } from "./types";
import { Badge, Button, Card, cx, EmptyState, ErrorState, inputClass, RichText, Segmented, SkeletonCard, Spinner } from "./ui";
import { useFormat } from "./use-format";

// Catalog keys for the stored enum values shown in this view (resolved with `t()` at render time).
const INTENT_KEYS: Record<QuerySuggestion["intent"], string> = {
  informational: "visibility.intent.informational",
  comparative: "visibility.intent.comparative",
  transactional: "visibility.intent.transactional",
  reputation: "visibility.intent.reputation",
};
const LEVEL_KEYS = { low: "visibility.level.low", medium: "visibility.level.medium", high: "visibility.level.high" } as const;

const STATUS_TONE = { cited: "good", mentioned: "warning", none: "critical" } as const;
/** Error codes returned per query/model by the visibility run → catalog keys. Unknown codes are shown as-is. */
const ERROR_KEYS: Record<string, string> = {
  not_configured: "visibility.error.notConfigured",
  unauthorized: "visibility.error.unauthorized",
  provider_error: "visibility.error.providerError",
  timeout: "visibility.error.timeout",
  rate_limited: "visibility.error.rateLimited",
  invalid_response: "visibility.error.invalidResponse",
};

function meta(r: VisibilityRecord) {
  const m = r.responseMeta && typeof r.responseMeta === "object" && !Array.isArray(r.responseMeta) ? (r.responseMeta as Record<string, unknown>) : {};
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { citedUrls: arr(m.citedUrls), citations: arr(m.citations), competitors: arr(m.competitorDomains), modelId: typeof m.modelId === "string" ? m.modelId : null, transport: m.transport === "cli" ? ("cli" as const) : ("api" as const) };
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
  const { t, formatDate, timeAgo, label } = useFormat();
  const [open, setOpen] = useState(false);
  const m = meta(record);
  const terms = siteTerms(site, m.citedUrls);
  const tone = STATUS_TONE[record.citationStatus as keyof typeof STATUS_TONE] ?? "neutral";
  const text = record.excerpt ?? "";
  const long = text.length > 420;
  return (
    <div className="flex flex-col rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{label("model", record.model)}</span>
        <Badge tone={tone} icon>
          {label("citation", record.citationStatus)}
        </Badge>
        {m.transport === "cli" && (
          <span title={t("visibility.answer.cliTitle")}>
            <Badge>CLI</Badge>
          </span>
        )}
        {record.position != null && <Badge>{t("visibility.answer.position", { position: record.position })}</Badge>}
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
        <p className="mt-2 text-xs italic text-zinc-400">{t("visibility.answer.noText")}</p>
      )}
      {long && (
        <button type="button" className="mt-1 self-start text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? t("visibility.answer.collapse") : t("visibility.answer.expand")}
        </button>
      )}
      {(m.citedUrls.length > 0 || m.competitors.length > 0) && (
        <div className="mt-2 space-y-1 border-t border-zinc-100 pt-2 text-xs dark:border-zinc-800">
          {m.citedUrls.length > 0 && (
            <div>
              <span className="text-zinc-500">{t("visibility.answer.siteSources")} </span>
              {m.citedUrls.slice(0, 3).map((u) => (
                <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="mr-2 break-all text-[#006300] hover:underline dark:text-[#0ca30c]">
                  {u}
                </a>
              ))}
            </div>
          )}
          {m.competitors.length > 0 && (
            <div className="text-zinc-500">
              {t("visibility.answer.otherSources")} <span className="text-zinc-700 dark:text-zinc-300">{m.competitors.slice(0, 6).join(", ")}</span>
              {m.competitors.length > 6 && ` +${m.competitors.length - 6}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TRANSPORT_MODES: { value: TransportMode; labelKey: string }[] = [
  { value: "auto", labelKey: "visibility.transport.auto" },
  { value: "api", labelKey: "visibility.transport.api" },
  { value: "cli", labelKey: "visibility.transport.cli" },
];

export function RunPanel({ suggestions, details = [], providers, defaultTransport = "auto", cliMaxCalls, onDone }: { suggestions: string[]; details?: QuerySuggestion[]; providers?: ProviderStatus[]; defaultTransport?: TransportMode; cliMaxCalls?: number; onDone: () => void }) {
  const { t, label } = useFormat();
  const suggestionInfo = useMemo(() => new Map(details.map((d) => [d.text, d])), [details]);
  const { siteId } = useSite();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(suggestions.slice(0, 3)));
  const [custom, setCustom] = useState("");
  const [models, setModels] = useState<Set<string>>(new Set(VISIBILITY_MODEL_ORDER));
  const [refresh, setRefresh] = useState(false);
  const [transport, setTransport] = useState<TransportMode>(defaultTransport);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<VisibilityRunResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  const customQueries = custom
    .split("\n")
    .map((q) => q.trim())
    .filter(Boolean);
  const queries = [...new Set([...selected, ...customQueries])];
  const tooMany = queries.length > 10;
  // Older servers send no provider status: they only know API keys.
  const via = (m: string) => (providers ? providers.find((p) => p.model === m)?.resolved[transport] ?? null : "api");
  const selectedModels = VISIBILITY_MODEL_ORDER.filter((m) => models.has(m));
  const apiCalls = queries.length * selectedModels.filter((m) => via(m) === "api").length;
  const cliCalls = queries.length * selectedModels.filter((m) => via(m) === "cli").length;
  const skipped = selectedModels.filter((m) => via(m) === null);
  const tooManyCli = cliMaxCalls != null && cliCalls > cliMaxCalls;

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<VisibilityRunResult>(`/api/sites/${siteId}/visibility`, {
        method: "POST",
        json: { queries, models: selectedModels, refresh, ...(providers ? { transport } : {}) },
      });
      setResult(res);
      toast.push(res.successful ? "success" : "error", res.successful ? t("visibility.run.toast.done", { successful: res.successful, attempted: res.attempted }) : t("visibility.run.toast.none"));
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  }

  const failures = result?.items.filter((i) => i.error) ?? [];
  const failureSummary = [...new Set(failures.map((f) => `${label("model", f.model)}: ${ERROR_KEYS[f.error!] ? t(ERROR_KEYS[f.error!]) : f.error}`))];

  return (
    <Card title={t("visibility.run.title")} subtitle={t("visibility.run.subtitle")}>
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{t("visibility.run.queries")}</div>
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
                      {suggestionInfo.get(q) && (
                        <span
                          className="ml-2 inline-flex gap-1 align-middle"
                          title={
                            t("visibility.run.queryTooltip", { difficulty: t(LEVEL_KEYS[suggestionInfo.get(q)!.difficulty.level]), volume: t(LEVEL_KEYS[suggestionInfo.get(q)!.volume.level]) }) +
                            (suggestionInfo.get(q)!.branded ? ` · ${t("visibility.run.containsBrand")}` : "")
                          }
                        >
                          <Badge>{t(INTENT_KEYS[suggestionInfo.get(q)!.intent])}</Badge>
                          <Badge>{suggestionInfo.get(q)!.language.toUpperCase()}</Badge>
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">{t("visibility.run.noSuggestions")}</p>
          )}
          <textarea rows={3} placeholder={t("visibility.run.customPlaceholder")} value={custom} onChange={(e) => setCustom(e.target.value)} className={`${inputClass} mt-3`} aria-label={t("visibility.run.customLabel")} />
        </div>
        <div className="flex flex-col">
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{t("visibility.models")}</div>
            {providers && <Segmented label={t("visibility.transport.label")} value={transport} onChange={setTransport} options={TRANSPORT_MODES.map((o) => ({ value: o.value, label: t(o.labelKey) }))} />}
            {providers && transport !== "api" && (
              <Link href="/settings" className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">
                {t("visibility.transport.cliModels")}
              </Link>
            )}
          </div>
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
                <span>
                  {label("model", m)}
                  {providers && <TransportHint provider={providers.find((p) => p.model === m)} via={via(m)} />}
                </span>
              </label>
            ))}
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" className="accent-indigo-600" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} />
            {t("visibility.run.skipCache")}
          </label>
          <div className="mt-auto pt-4">
            <p className="mb-2 text-xs text-zinc-500">
              {t("visibility.run.queryCount", { count: queries.length })} × {t("visibility.run.modelCount", { count: models.size })} = <b>{queries.length * models.size}</b>{" "}
              {providers ? (
                <>
                  {t("visibility.run.calls", { count: queries.length * models.size })}{" "}
                  <RichText message={t("visibility.run.callSplit")} slots={{ api: <b>{apiCalls}</b>, cli: <b>{cliCalls}</b> }} />
                </>
              ) : (
                t("visibility.run.paidCalls", { count: queries.length * models.size })
              )}
              {skipped.length > 0 && <span className="text-amber-700 dark:text-amber-300"> {t("visibility.run.skippedModels", { models: skipped.map((m) => label("model", m)).join(", ") })}</span>}
              {tooMany && <span className="text-red-600 dark:text-red-400"> {t("visibility.run.tooMany")}</span>}
              {tooManyCli && <span className="text-red-600 dark:text-red-400"> {t("visibility.run.tooManyCli", { max: cliMaxCalls ?? 0 })}</span>}
            </p>
            <Button variant="primary" onClick={() => void run()} loading={running} disabled={!queries.length || !models.size || tooMany || tooManyCli}>
              {t("visibility.run.start")}
            </Button>
            {running && (
              <p className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
                <Spinner className="h-3 w-3" /> {t(cliCalls > 0 ? "visibility.run.runningCli" : "visibility.run.running")}
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
                ? new Error(t("visibility.run.error.503"))
                : error instanceof ApiError && error.status === 409
                  ? new Error(t("visibility.run.error.409"))
                  : error
            }
          />
        </div>
      )}
      {result && (
        <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-950">
          <RichText message={t("visibility.run.result", { attempted: result.attempted })} slots={{ successful: <b>{result.successful}</b> }} />
          {result.citationRate != null && (
            <>
              {" · "}
              <RichText message={t("visibility.run.citationRate")} slots={{ rate: <b>{t("shared.percent", { value: result.citationRate })}</b> }} />
            </>
          )}
          {failureSummary.length > 0 && <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t("visibility.run.skipped", { items: failureSummary.join(" · ") })}</div>}
        </div>
      )}
    </Card>
  );
}

/** Which route a model takes right now: API key, the vendor's CLI (claude / codex / agy), or neither. */
function TransportHint({ provider, via }: { provider?: ProviderStatus; via: "api" | "cli" | null }) {
  const { t } = useFormat();
  const text =
    via === "api"
      ? t("visibility.transport.viaApi")
      : via === "cli"
        ? provider?.cliModel ? t("visibility.transport.viaCliModel", { cli: provider.cli ?? "", model: provider.cliModel }) : t("visibility.transport.viaCli", { cli: provider?.cli ?? "" })
        : provider?.cli ? t("visibility.transport.cliMissing", { cli: provider.cli }) : t("visibility.transport.noKey");
  return <span className={cx("ml-2 text-xs", via ? "text-zinc-500" : "text-amber-700 dark:text-amber-300")}>{text}</span>;
}

export function VisibilityView() {
  const { t, label } = useFormat();
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
      <RunPanel
        key={list.data!.queries.join("|")}
        suggestions={list.data!.queries}
        details={list.data!.querySuggestions}
        providers={list.data!.providers}
        defaultTransport={list.data!.defaultTransport}
        cliMaxCalls={list.data!.limits?.cliMaxCalls}
        onDone={() => setReload((r) => r + 1)}
      />

      {!items.length ? (
        <EmptyState icon="🤖" title={t("visibility.empty.title")}>
          {t("visibility.empty.hint")}
        </EmptyState>
      ) : (
        <>
          <Card title={t("visibility.competitors.title")} subtitle={t("visibility.competitors.subtitle", { count: items.length })}>
            {competitors.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-zinc-500">
                    <tr>
                      <th className="py-2 pr-3 font-medium">{t("visibility.competitors.domain")}</th>
                      <th className="py-2 pr-3 text-right font-medium">{t("visibility.competitors.answers")}</th>
                      <th className="py-2 pr-3 font-medium">{t("visibility.competitors.share")}</th>
                      <th className="py-2 pr-3 font-medium">{t("visibility.models")}</th>
                      <th className="py-2 font-medium">{t("visibility.competitors.sampleQuery")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {competitors.map((c) => (
                      <tr key={c.domain} className={cx("border-t border-zinc-100 dark:border-zinc-800", c.isSite && "bg-emerald-50/60 dark:bg-emerald-950/30")}>
                        <td className="py-2 pr-3 font-medium">
                          {c.domain} {c.isSite && <Badge tone="good">{t("shared.yourSite")}</Badge>}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{c.answers}</td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-24 overflow-hidden rounded-full bg-[var(--chart-grid)]">
                              <div className="h-full rounded-full" style={{ width: `${c.share}%`, background: c.isSite ? "#0ca30c" : "var(--series-1)" }} />
                            </div>
                            <span className="text-xs tabular-nums text-zinc-500">{t("shared.percent", { value: c.share })}</span>
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-xs text-zinc-500">{c.models.map((m) => label("model", m)).join(", ")}</td>
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
              <p className="text-sm text-zinc-500">{t("visibility.competitors.none")}</p>
            )}
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold">{t("visibility.byQuery")}</h2>
            <Segmented
              label={t("visibility.filter.model")}
              value={model}
              onChange={setModel}
              options={[{ value: "all", label: t("visibility.filter.allModels") }, ...VISIBILITY_MODEL_ORDER.map((m) => ({ value: m as string, label: label("model", m) }))]}
            />
            <Segmented
              label={t("visibility.filter.result")}
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: t("visibility.filter.allResults") },
                { value: "cited", label: t("visibility.filter.cited") },
                { value: "mentioned", label: t("visibility.filter.mentioned") },
                { value: "none", label: t("visibility.filter.none") },
              ]}
            />
            <span className="ml-auto text-xs text-zinc-500">{t("visibility.recordCount", { count: list.data!.total })}</span>
          </div>
          {byQuery.length === 0 ? (
            <EmptyState title={t("visibility.filter.noMatch")} />
          ) : (
            byQuery.map(([query, records]) => (
              <Card key={query} title={<>“{query}”</>} subtitle={t("visibility.modelAnswers", { count: records.length })}>
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
