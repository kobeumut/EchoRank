"use client";

import { useEffect, useMemo, useState } from "react";
import { ENTITY_LABELS } from "@/lib/dashboard/format";
import { apiFetch, ApiError, errorMessage, useApi } from "./api";
import { useToast } from "./toast";
import type { EnrichmentList, EntityEnrichment, ReconcileResult, SiteJsonLd, WikidataCandidate } from "./types";
import { Badge, Button, CodeBlock, cx, EmptyState, ErrorState, inputBase, Modal, Segmented, Skeleton, Spinner } from "./ui";

/** Entity types the Wikidata reconciler handles (mirrors RECONCILABLE_TYPES on the server). */
export const RECONCILABLE = new Set(["Organization", "Brand", "Person", "Product", "Concept"]);

export const ENRICHMENT_STATUS_LABELS: Record<string, string> = {
  verified: "Doğrulandı",
  matched: "Otomatik eşleşti",
  declared: "Sitede beyan edildi",
  review: "İnceleme bekliyor",
  unmatched: "Eşleşme yok",
  rejected: "Reddedildi",
  pending: "Bekliyor",
  error: "Hata",
};

const QID_RX = /^Q[1-9]\d*$/;
const wikidataUrl = (qid: string) => `https://www.wikidata.org/wiki/${qid}`;
const pct = (n: number | null | undefined) => (n == null ? "—" : `%${Math.round(n * 100)}`);

export type ReconcileTarget = { id: string; name: string; type: string };

export function sameAsOf(e: EntityEnrichment): string[] {
  return Array.isArray(e.sameAsLinks) ? e.sameAsLinks.filter((u): u is string => typeof u === "string") : [];
}

/** Green "Wikidata QID" pill linking straight to wikidata.org. */
export function QidBadge({ qid, verified = true, className }: { qid: string; verified?: boolean; className?: string }) {
  return (
    <a
      href={wikidataUrl(qid)}
      target="_blank"
      rel="noopener noreferrer"
      title={verified ? "Wikidata ile doğrulandı — wikidata.org'da aç" : "Doğrulanmamış aday — wikidata.org'da aç"}
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
  if (!reconcilable) return null;
  const links = enrichment ? sameAsOf(enrichment).filter((u) => !u.includes("wikidata.org")) : [];
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Wikidata</span>
        {enrichment && (
          <Badge tone={statusTone(enrichment)}>
            {ENRICHMENT_STATUS_LABELS[enrichment.status] ?? enrichment.status}
            {enrichment.matchConfidence > 0 && !enrichment.isVerified ? ` · ${pct(enrichment.matchConfidence)}` : ""}
          </Badge>
        )}
      </div>
      {enrichment?.wikidataId ? (
        <div className="space-y-2">
          <QidBadge qid={enrichment.wikidataId} verified={enrichment.isVerified} />
          {enrichment.wikipediaUrl && (
            <a href={enrichment.wikipediaUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-xs text-indigo-600 hover:underline dark:text-indigo-400">
              Wikipedia: {decodeURIComponent(enrichment.wikipediaUrl.replace(/^https?:\/\//, ""))} ↗
            </a>
          )}
          {links.length > 0 && <div className="text-xs text-zinc-500">+{links.length} sameAs bağlantısı</div>}
          {!enrichment.isVerified && (
            <Button size="sm" variant="primary" onClick={onReconcile}>
              Eşleşmeyi doğrula
            </Button>
          )}
          {enrichment.isVerified && (
            <Button size="sm" variant="ghost" onClick={onReconcile}>
              Eşleşmeyi değiştir
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">Bu varlık Wikidata ile eşleşmemiş. Eşleştirmek, AI motorlarının markayı/kişiyi doğru tanımasını sağlar (Schema.org sameAs).</p>
          <Button size="sm" variant="primary" onClick={onReconcile}>
            🔍 Wikidata&apos;da ara ve eşleştir
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
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      size="lg"
      title={target ? `Wikidata uzlaştırma: ${target.name}` : "Wikidata uzlaştırma"}
      subtitle={target ? `${ENTITY_LABELS[target.type] ?? target.type} · doğru Wikidata öğesini seçin; seçim yeniden taramalarda korunur.` : undefined}
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
  const toast = useToast();
  const [query, setQuery] = useState(target.name);
  const [lang, setLang] = useState<"tr" | "en">("tr");
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
    if (enrichment?.status !== "verified") void search(target.name, "tr");
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
      toast.push("error", err instanceof ApiError && err.status === 422 ? "Bu QID Wikidata'da bulunamadı." : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const verify = (qid: string) => act(qid, { action: "verify", qid }, `${target.name} → ${qid} olarak doğrulandı.`);
  const manualOk = QID_RX.test(manualQid.trim().toUpperCase());

  return (
    <div className="space-y-4">
      {enrichment?.wikidataId && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-950">
          <span className="text-zinc-500">Mevcut eşleşme:</span>
          <QidBadge qid={enrichment.wikidataId} verified={enrichment.isVerified} />
          <Badge tone={statusTone(enrichment)}>{ENRICHMENT_STATUS_LABELS[enrichment.status] ?? enrichment.status}</Badge>
          <Button size="sm" variant="danger" className="ml-auto" loading={busy === "reject"} disabled={!!busy} onClick={() => void act("reject", { action: "reject" }, "Eşleşme reddedildi; bu QID bir daha otomatik eşleşmeyecek.")}>
            Eşleşmeyi reddet
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
          Arama terimi
          <input className={`${inputBase} w-full`} value={query} onChange={(e) => setQuery(e.target.value)} maxLength={250} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Dil
          <select className={inputBase} value={lang} onChange={(e) => setLang(e.target.value as "tr" | "en")}>
            <option value="tr">Türkçe</option>
            <option value="en">English</option>
          </select>
        </label>
        <Button type="submit" variant="primary" loading={searching} disabled={!!busy}>
          Wikidata&apos;da ara
        </Button>
      </form>

      {searchError ? (
        <ErrorState error={searchError} onRetry={() => void search(query, lang)} />
      ) : searching && !candidates ? (
        <div className="space-y-2" role="status" aria-label="Aranıyor">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : candidates === null ? (
        <p className="text-sm text-zinc-500">Eşleşme doğrulanmış. Değiştirmek için arama yapın veya QID girin.</p>
      ) : candidates.length === 0 ? (
        <EmptyState icon="∅" title="Aday bulunamadı" className="py-6">
          Farklı bir yazım veya İngilizce adla tekrar deneyin ya da QID&apos;yi elle girin.
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
                    {current && <Badge tone="good">mevcut</Badge>}
                  </div>
                  {c.description && <p className="mt-0.5 text-xs text-zinc-500">{c.description}</p>}
                  <ConfidenceBar score={c.score} />
                </div>
                <Button size="sm" variant={current && enrichment?.isVerified ? "secondary" : "primary"} loading={busy === c.qid} disabled={!!busy || (current && enrichment?.status === "verified")} onClick={() => void verify(c.qid)}>
                  {current && enrichment?.status === "verified" ? "Doğrulandı" : "Bu varlık"}
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
          QID&apos;yi elle girin
          <input className={`${inputBase} w-full font-mono`} placeholder="Q42" value={manualQid} onChange={(e) => setManualQid(e.target.value)} aria-invalid={!!manualQid && !manualOk} />
        </label>
        <Button type="submit" disabled={!manualOk || !!busy} loading={busy === manualQid.trim().toUpperCase()}>
          QID ile doğrula
        </Button>
      </form>
    </div>
  );
}

function ConfidenceBar({ score }: { score: number }) {
  const value = Math.max(0, Math.min(1, score));
  const color = value >= 0.8 ? "#0ca30c" : value >= 0.55 ? "#fab219" : "#898781";
  return (
    <div className="mt-1.5 flex items-center gap-2" title="Eşleşme güveni (ad benzerliği, tür, site bağlamı)">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="h-full rounded-full" style={{ width: `${value * 100}%`, background: color }} />
      </div>
      <span className="text-xs tabular-nums text-zinc-500">güven {pct(value)}</span>
    </div>
  );
}

// ---------------------------------------------------------------- JSON-LD preview

export function JsonLdModal({ siteId, open, onClose, version }: { siteId: string; open: boolean; onClose: () => void; version?: unknown }) {
  const data = useApi<SiteJsonLd>(open ? `/api/sites/${siteId}/jsonld` : null, { version });
  const [tab, setTab] = useState<"json" | "script">("json");
  const json = useMemo(() => (data.data ? JSON.stringify(data.data.jsonld, null, 2) : ""), [data.data]);
  const sameAsCount = useMemo(() => {
    const graph = (data.data?.jsonld?.["@graph"] ?? []) as { sameAs?: unknown }[];
    return graph.filter((n) => Array.isArray(n.sameAs) ? n.sameAs.length : !!n.sameAs).length;
  }, [data.data]);
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Zenginleştirilmiş JSON-LD @graph" subtitle="Bilgi grafından ve doğrulanmış Wikidata sameAs bağlantılarından üretilen Schema.org işaretlemesi">
      {data.loading ? (
        <div className="space-y-3" role="status" aria-label="Yükleniyor">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-80" />
        </div>
      ) : data.error ? (
        <ErrorState error={data.error} onRetry={() => void data.reload()} />
      ) : data.data ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={data.data.valid ? "good" : "critical"} icon>
              {data.data.valid ? "Şema geçerli" : `${data.data.errors.length} doğrulama hatası`}
            </Badge>
            <Badge>{data.data.nodes} düğüm</Badge>
            <Badge tone={sameAsCount ? "good" : "neutral"}>{sameAsCount} düğümde sameAs</Badge>
            {data.refreshing && <Spinner className="h-3.5 w-3.5" />}
            <div className="ml-auto">
              <Segmented
                label="Görünüm"
                value={tab}
                onChange={setTab}
                options={[
                  { value: "json", label: "@graph JSON" },
                  { value: "script", label: "<script> etiketi" },
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
              <p className="text-xs text-zinc-500">
                Bu etiketi sitenizin <code>&lt;head&gt;</code> bölümüne yapıştırın.
              </p>
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
      <div className="space-y-2" role="status" aria-label="Yükleniyor">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!items.length)
    return (
      <EmptyState icon="W" title="Uzlaştırılacak varlık yok" className="py-6">
        Kurum, marka, kişi, ürün ve kavram varlıkları analizden sonra burada Wikidata ile eşleştirilir.
      </EmptyState>
    );
  return (
    <div className="space-y-3">
      <Segmented
        label="Wikidata filtresi"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "Tümü", count: groups.all.length },
          { value: "verified", label: "Doğrulanmış", count: groups.verified.length },
          { value: "review", label: "Onay bekleyen", count: groups.review.length },
          { value: "missing", label: "Eşleşmeyen", count: groups.missing.length },
        ]}
      />
      {rows.length === 0 ? (
        <p className="py-4 text-sm text-zinc-500">Bu filtrede varlık yok.</p>
      ) : (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white text-xs text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="py-2 pr-3 font-medium">Varlık</th>
                <th className="hidden py-2 pr-3 font-medium sm:table-cell">Tür</th>
                <th className="py-2 pr-3 font-medium">Wikidata</th>
                <th className="hidden py-2 pr-3 font-medium md:table-cell">Durum</th>
                <th className="py-2 text-right font-medium">
                  <span className="sr-only">İşlem</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((e) => (
                <tr key={e.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="max-w-56 py-2 pr-3">
                    {e.entityId && canShow(e.entityId) ? (
                      <button type="button" className="block max-w-full truncate text-left text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => onShow(e.entityId!)} title="Grafta göster">
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
                  <td className="hidden py-2 pr-3 text-xs text-zinc-500 sm:table-cell">{ENTITY_LABELS[e.entityType] ?? e.entityType}</td>
                  <td className="py-2 pr-3">{e.wikidataId ? <QidBadge qid={e.wikidataId} verified={e.isVerified} /> : <span className="text-xs text-zinc-400">—</span>}</td>
                  <td className="hidden py-2 pr-3 md:table-cell">
                    <Badge tone={statusTone(e)}>
                      {ENRICHMENT_STATUS_LABELS[e.status] ?? e.status}
                      {e.matchConfidence > 0 && !e.isVerified ? ` · ${pct(e.matchConfidence)}` : ""}
                    </Badge>
                  </td>
                  <td className="py-2 text-right">
                    {e.entityId && (
                      <Button size="sm" variant={e.isVerified ? "ghost" : "secondary"} onClick={() => onReconcile(e)}>
                        {e.isVerified ? "Değiştir" : e.wikidataId ? "Onayla" : "Eşleştir"}
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
