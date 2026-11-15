"use client";

import { useEffect, useMemo, useState } from "react";
import type { Translator } from "@/lib/i18n/translate";
import { apiFetch, ApiError, errorMessage, useApi } from "./api";
import { rich } from "./rich-text";
import { useToast } from "./toast";
import type { EnrichmentList, EntityEnrichment, ReconcileResult, SiteJsonLd, WikidataCandidate } from "./types";
import { Badge, Button, CodeBlock, cx, EmptyState, ErrorState, inputBase, Modal, Segmented, Skeleton, Spinner } from "./ui";
import { useFormat } from "./use-format";

/** Entity types the Wikidata reconciler handles (mirrors RECONCILABLE_TYPES on the server). */
export const RECONCILABLE = new Set(["Organization", "Brand", "Person", "Product", "Concept"]);

const ENRICHMENT_STATUSES = ["verified", "matched", "declared", "review", "unmatched", "rejected", "pending", "error"];

/** Localised enrichment status (`entities.status.*`); unknown statuses are shown as-is. */
export const statusLabel = (t: Translator, status: string) => (ENRICHMENT_STATUSES.includes(status) ? t(`entities.status.${status}`) : status);

const QID_RX = /^Q[1-9]\d*$/;
const wikidataUrl = (qid: string) => `https://www.wikidata.org/wiki/${qid}`;
/** Percentage for a 0-1 value, in the locale's own style ("92%" / "%92"). */
const pct = (intlLocale: string, n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat(intlLocale, { style: "percent", maximumFractionDigits: 0 }).format(n);

/** URL without the scheme, percent-decoded for display; malformed escapes fall back to the raw text instead of throwing. */
function readableUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, "");
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

export type ReconcileTarget = { id: string; name: string; type: string };

export function sameAsOf(e: EntityEnrichment): string[] {
  return Array.isArray(e.sameAsLinks) ? e.sameAsLinks.filter((u): u is string => typeof u === "string") : [];
}

/** Green "Wikidata QID" pill linking straight to wikidata.org. */
export function QidBadge({ qid, verified = true, className }: { qid: string; verified?: boolean; className?: string }) {
  const { t } = useFormat();
  return (
    <a
      href={wikidataUrl(qid)}
      target="_blank"
      rel="noopener noreferrer"
      title={verified ? t("entities.qid.verifiedTitle") : t("entities.qid.candidateTitle")}
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs font-medium whitespace-nowrap transition hover:underline",
        verified
          ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
          : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
        className,
      )}
    >
      <span aria-hidden>{verified ? "✓" : "?"}</span>
      Wikidata {qid}
      <span aria-hidden>↗</span>
    </a>
  );
}

export function statusTone(e: EntityEnrichment) {
  if (e.isVerified) return "good" as const;
  if (e.status === "review" || e.status === "matched" || e.status === "declared") return "warning" as const;
  if (e.status === "rejected" || e.status === "error") return "critical" as const;
  return "neutral" as const;
}

/** Wikidata block inside the graph node detail panel. */
export function WikidataSection({ enrichment, reconcilable, onReconcile }: { enrichment: EntityEnrichment | undefined; reconcilable: boolean; onReconcile: () => void }) {
  const { t, intlLocale } = useFormat();
  if (!reconcilable) return null;
  const links = enrichment ? sameAsOf(enrichment).filter((u) => !u.includes("wikidata.org")) : [];
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Wikidata</span>
        {enrichment && (
          <Badge tone={statusTone(enrichment)}>
            {statusLabel(t, enrichment.status)}
            {enrichment.matchConfidence > 0 && !enrichment.isVerified ? ` · ${pct(intlLocale, enrichment.matchConfidence)}` : ""}
          </Badge>
        )}
      </div>
      {enrichment?.wikidataId ? (
        <div className="space-y-2">
          <QidBadge qid={enrichment.wikidataId} verified={enrichment.isVerified} />
          {enrichment.wikipediaUrl && (
            <a href={enrichment.wikipediaUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-xs text-indigo-600 hover:underline dark:text-indigo-400">
              Wikipedia: {readableUrl(enrichment.wikipediaUrl)} ↗
            </a>
          )}
          {links.length > 0 && <div className="text-xs text-zinc-500">{t("entities.section.sameAsLinks", { count: links.length })}</div>}
          {!enrichment.isVerified && (
            <Button size="sm" variant="primary" onClick={onReconcile}>
              {t("entities.section.verify")}
            </Button>
          )}
          {enrichment.isVerified && (
            <Button size="sm" variant="ghost" onClick={onReconcile}>
              {t("entities.section.change")}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">{t("entities.section.unmatchedHint")}</p>
          <Button size="sm" variant="primary" onClick={onReconcile}>
            {t("entities.section.searchAndMatch")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- reconcile modal

export function ReconcileModal({
  siteId,
  target,
  enrichment,
  onClose,
  onChanged,
}: {
  siteId: string;
  target: ReconcileTarget | null;
  enrichment: EntityEnrichment | undefined;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, label } = useFormat();
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      size="lg"
      title={target ? t("entities.reconcile.titleFor", { name: target.name }) : t("entities.reconcile.title")}
      subtitle={target ? t("entities.reconcile.subtitle", { type: label("entity", target.type) }) : undefined}
    >
      {target && <ReconcileBody key={target.id} siteId={siteId} target={target} enrichment={enrichment} onClose={onClose} onChanged={onChanged} />}
    </Modal>
  );
}

function ReconcileBody({
  siteId,
  target,
  enrichment,
  onClose,
  onChanged,
}: {
  siteId: string;
  target: ReconcileTarget;
  enrichment: EntityEnrichment | undefined;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, locale, intlLocale } = useFormat();
  const toast = useToast();
  const [query, setQuery] = useState(target.name);
  // Wikidata search language: start with the UI language; the select below lets the user switch (tr | en).
  const [lang, setLang] = useState<"tr" | "en">(locale === "tr" ? "tr" : "en");
  const [candidates, setCandidates] = useState<WikidataCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualQid, setManualQid] = useState("");
  const endpoint = `/api/sites/${siteId}/entities/reconcile`;

  const currentQid = enrichment?.wikidataId ?? null;
  const search = async (q: string, l: string) => {
    setSearching(true);
    setSearchError(null);
    try {
      const res = await apiFetch<ReconcileResult>(endpoint, { method: "POST", json: { action: "requery", entityId: target.id, query: q.trim() || undefined, lang: l } });
      setCandidates(res.entity?.candidates ?? []);
      // A confident hit is matched automatically by the reconciler — refresh the graph badges.
      if ((res.enrichment?.wikidataId ?? null) !== currentQid) onChanged();
    } catch (err) {
      setSearchError(err);
    } finally {
      setSearching(false);
    }
  };

  // One click from the graph = search immediately, unless a human already pinned the match (requery would drop it).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (enrichment?.status !== "verified") void search(target.name, lang);
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (key: string, body: Record<string, unknown>, okMessage: string) => {
    setBusy(key);
    try {
      await apiFetch<ReconcileResult>(endpoint, { method: "POST", json: { entityId: target.id, ...body } });
      toast.push("success", okMessage);
      onChanged();
      onClose();
    } catch (err) {
      toast.push("error", err instanceof ApiError && err.status === 422 ? t("entities.reconcile.qidNotFound") : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const verify = (qid: string) => act(qid, { action: "verify", qid }, t("entities.reconcile.verified", { name: target.name, qid }));
  const manualOk = QID_RX.test(manualQid.trim().toUpperCase());

  return (
    <div className="space-y-4">
      {enrichment?.wikidataId && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-950">
          <span className="text-zinc-500">{t("entities.reconcile.currentMatch")}</span>
          <QidBadge qid={enrichment.wikidataId} verified={enrichment.isVerified} />
          <Badge tone={statusTone(enrichment)}>{statusLabel(t, enrichment.status)}</Badge>
          <Button size="sm" variant="danger" className="ml-auto" loading={busy === "reject"} disabled={!!busy} onClick={() => void act("reject", { action: "reject" }, t("entities.reconcile.rejected"))}>
            {t("entities.reconcile.reject")}
          </Button>
        </div>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search(query, lang);
        }}
      >
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {t("entities.reconcile.searchTerm")}
          <input className={`${inputBase} w-full`} value={query} onChange={(e) => setQuery(e.target.value)} maxLength={250} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {t("entities.reconcile.language")}
          <select className={inputBase} value={lang} onChange={(e) => setLang(e.target.value as "tr" | "en")}>
            <option value="tr">{t("entities.reconcile.lang.tr")}</option>
            <option value="en">{t("entities.reconcile.lang.en")}</option>
          </select>
        </label>
        <Button type="submit" variant="primary" loading={searching} disabled={!!busy}>
          {t("entities.reconcile.search")}
        </Button>
      </form>

      {searchError ? (
        <ErrorState error={searchError} onRetry={() => void search(query, lang)} />
      ) : searching && !candidates ? (
        <div className="space-y-2" role="status" aria-label={t("entities.reconcile.searching")}>
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : candidates === null ? (
        <p className="text-sm text-zinc-500">{t("entities.reconcile.alreadyVerified")}</p>
      ) : candidates.length === 0 ? (
        <EmptyState icon="∅" title={t("entities.reconcile.noCandidates")} className="py-6">
          {t("entities.reconcile.noCandidatesHint")}
        </EmptyState>
      ) : (
        <ul className={cx("space-y-2", searching && "opacity-60")} aria-busy={searching}>
          {candidates.map((c) => {
            const current = c.qid === enrichment?.wikidataId;
            return (
              <li key={c.qid} className={cx("flex items-start gap-3 rounded-lg border p-3", current ? "border-emerald-300 dark:border-emerald-800" : "border-zinc-200 dark:border-zinc-800")}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.label}</span>
                    <a href={c.url} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400">
                      {c.qid} ↗
                    </a>
                    {current && <Badge tone="good">{t("entities.reconcile.current")}</Badge>}
                  </div>
                  {c.description && <p className="mt-0.5 text-xs text-zinc-500">{c.description}</p>}
                  <ConfidenceBar score={c.score} intlLocale={intlLocale} />
                </div>
                <Button size="sm" variant={current && enrichment?.isVerified ? "secondary" : "primary"} loading={busy === c.qid} disabled={!!busy || (current && enrichment?.status === "verified")} onClick={() => void verify(c.qid)}>
                  {current && enrichment?.status === "verified" ? t("entities.reconcile.verifiedButton") : t("entities.reconcile.thisEntity")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="flex flex-wrap items-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
        onSubmit={(e) => {
          e.preventDefault();
          if (manualOk) void verify(manualQid.trim().toUpperCase());
        }}
      >
        <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {t("entities.reconcile.manualQid")}
          <input className={`${inputBase} w-full font-mono`} placeholder="Q42" value={manualQid} onChange={(e) => setManualQid(e.target.value)} aria-invalid={!!manualQid && !manualOk} />
        </label>
        <Button type="submit" disabled={!manualOk || !!busy} loading={busy === manualQid.trim().toUpperCase()}>
          {t("entities.reconcile.verifyWithQid")}
        </Button>
      </form>
    </div>
  );
}

function ConfidenceBar({ score, intlLocale }: { score: number; intlLocale: string }) {
  const { t } = useFormat();
  const value = Math.max(0, Math.min(1, score));
  const color = value >= 0.8 ? "#0ca30c" : value >= 0.55 ? "#fab219" : "#898781";
  return (
    <div className="mt-1.5 flex items-center gap-2" title={t("entities.reconcile.confidenceTitle")}>
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="h-full rounded-full" style={{ width: `${value * 100}%`, background: color }} />
      </div>
      <span className="text-xs tabular-nums text-zinc-500">{t("entities.reconcile.confidence", { percent: pct(intlLocale, value) })}</span>
    </div>
  );
}

// ---------------------------------------------------------------- JSON-LD preview

export function JsonLdModal({ siteId, open, onClose, version }: { siteId: string; open: boolean; onClose: () => void; version?: unknown }) {
  const { t } = useFormat();
  const data = useApi<SiteJsonLd>(open ? `/api/sites/${siteId}/jsonld` : null, { version });
  const [tab, setTab] = useState<"json" | "script">("json");
  const json = useMemo(() => (data.data ? JSON.stringify(data.data.jsonld, null, 2) : ""), [data.data]);
  const sameAsCount = useMemo(() => {
    const graph = (data.data?.jsonld?.["@graph"] ?? []) as { sameAs?: unknown }[];
    return graph.filter((n) => Array.isArray(n.sameAs) ? n.sameAs.length : !!n.sameAs).length;
  }, [data.data]);
  return (
    <Modal open={open} onClose={onClose} size="lg" title={t("entities.jsonld.title")} subtitle={t("entities.jsonld.subtitle")}>
      {data.loading ? (
        <div className="space-y-3" role="status" aria-label={t("entities.loading")}>
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-80" />
        </div>
      ) : data.error ? (
        <ErrorState error={data.error} onRetry={() => void data.reload()} />
      ) : data.data ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={data.data.valid ? "good" : "critical"} icon>
              {data.data.valid ? t("entities.jsonld.valid") : t("entities.jsonld.errors", { count: data.data.errors.length })}
            </Badge>
            <Badge>{t("entities.jsonld.nodes", { count: data.data.nodes })}</Badge>
            <Badge tone={sameAsCount ? "good" : "neutral"}>{t("entities.jsonld.sameAsNodes", { count: sameAsCount })}</Badge>
            {data.refreshing && <Spinner className="h-3.5 w-3.5" />}
            <div className="ml-auto">
              <Segmented
                label={t("entities.jsonld.view")}
                value={tab}
                onChange={setTab}
                options={[
                  { value: "json", label: t("entities.jsonld.tabJson") },
                  { value: "script", label: t("entities.jsonld.tabScript") },
                ]}
              />
            </div>
          </div>
          {!data.data.valid && (
            <ul className="list-disc space-y-0.5 rounded-lg bg-red-50 py-2 pr-3 pl-7 text-xs text-red-900 dark:bg-red-950/40 dark:text-red-200">
              {data.data.errors.slice(0, 10).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {tab === "json" ? (
            <CodeBlock code={json} language="json" filename="schema-graph.jsonld" maxHeight="55vh" />
          ) : (
            <>
              <p className="text-xs text-zinc-500">{rich(t("entities.jsonld.pasteHint"), { code: <code>&lt;head&gt;</code> })}</p>
              <CodeBlock code={data.data.script} language="html" filename="schema-graph.html" maxHeight="50vh" />
            </>
          )}
        </div>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------- enrichment table

type EnrichFilter = "all" | "verified" | "review" | "missing";

export function EnrichmentTable({
  data,
  loading,
  error,
  onRetry,
  onReconcile,
  onShow,
  canShow,
}: {
  data: EnrichmentList | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onReconcile: (e: EntityEnrichment) => void;
  onShow: (entityId: string) => void;
  canShow: (entityId: string) => boolean;
}) {
  const { t, label, intlLocale } = useFormat();
  const [filter, setFilter] = useState<EnrichFilter>("all");
  const items = useMemo(() => data?.items ?? [], [data]);
  const groups = useMemo(() => {
    const verified = items.filter((e) => e.isVerified);
    const review = items.filter((e) => !e.isVerified && !!e.wikidataId);
    const missing = items.filter((e) => !e.wikidataId);
    return { all: items, verified, review, missing };
  }, [items]);
  const rows = groups[filter];

  if (loading)
    return (
      <div className="space-y-2" role="status" aria-label={t("entities.loading")}>
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!items.length)
    return (
      <EmptyState icon="W" title={t("entities.table.emptyTitle")} className="py-6">
        {t("entities.table.emptyHint")}
      </EmptyState>
    );
  return (
    <div className="space-y-3">
      <Segmented
        label={t("entities.table.filterLabel")}
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: t("entities.table.filterAll"), count: groups.all.length },
          { value: "verified", label: t("entities.table.filterVerified"), count: groups.verified.length },
          { value: "review", label: t("entities.table.filterReview"), count: groups.review.length },
          { value: "missing", label: t("entities.table.filterMissing"), count: groups.missing.length },
        ]}
      />
      {rows.length === 0 ? (
        <p className="py-4 text-sm text-zinc-500">{t("entities.table.noneInFilter")}</p>
      ) : (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white text-xs text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="py-2 pr-3 font-medium">{t("entities.table.colEntity")}</th>
                <th className="hidden py-2 pr-3 font-medium sm:table-cell">{t("entities.table.colType")}</th>
                <th className="py-2 pr-3 font-medium">{t("entities.table.colWikidata")}</th>
                <th className="hidden py-2 pr-3 font-medium md:table-cell">{t("entities.table.colStatus")}</th>
                <th className="py-2 text-right font-medium">
                  <span className="sr-only">{t("entities.table.colAction")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((e) => (
                <tr key={e.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="max-w-56 py-2 pr-3">
                    {e.entityId && canShow(e.entityId) ? (
                      <button type="button" className="block max-w-full truncate text-left text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => onShow(e.entityId!)} title={t("entities.table.showInGraph")}>
                        {e.entityName}
                      </button>
                    ) : (
                      <span className="block truncate">{e.entityName}</span>
                    )}
                    {e.wikipediaUrl && (
                      <a href={e.wikipediaUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-zinc-500 hover:text-indigo-600">
                        Wikipedia ↗
                      </a>
                    )}
                  </td>
                  <td className="hidden py-2 pr-3 text-xs text-zinc-500 sm:table-cell">{label("entity", e.entityType)}</td>
                  <td className="py-2 pr-3">{e.wikidataId ? <QidBadge qid={e.wikidataId} verified={e.isVerified} /> : <span className="text-xs text-zinc-400">—</span>}</td>
                  <td className="hidden py-2 pr-3 md:table-cell">
                    <Badge tone={statusTone(e)}>
                      {statusLabel(t, e.status)}
                      {e.matchConfidence > 0 && !e.isVerified ? ` · ${pct(intlLocale, e.matchConfidence)}` : ""}
                    </Badge>
                  </td>
                  <td className="py-2 text-right">
                    {e.entityId && (
                      <Button size="sm" variant={e.isVerified ? "ghost" : "secondary"} onClick={() => onReconcile(e)}>
                        {e.isVerified ? t("entities.table.change") : e.wikidataId ? t("entities.table.approve") : t("entities.table.match")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
