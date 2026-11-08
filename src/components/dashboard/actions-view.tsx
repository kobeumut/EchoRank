"use client";

import { useEffect, useMemo, useState } from "react";
import { ACTION_STATUS_LABELS, CATEGORY_LABELS, EFFORT_LABELS, formatDate, tierFor, TIERS } from "@/lib/dashboard/format";
import { apiFetch, errorMessage, useApi } from "./api";
import { useSite } from "./site-shell";
import { useToast } from "./toast";
import type { ActionItem } from "./types";
import { Badge, Button, CodeBlock, cx, EmptyState, ErrorState, inputBase, Segmented, SkeletonCard } from "./ui";

type StatusView = "open" | "resolved" | "dismissed";
const STATUS_QUERY: Record<StatusView, string> = { open: "open,in_progress", resolved: "resolved", dismissed: "dismissed" };

function ActionCard({ item, onStatus, busy, highlighted }: { item: ActionItem; onStatus: (status: string) => void; busy: string | null; highlighted: boolean }) {
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
        <Badge>{CATEGORY_LABELS[item.category] ?? item.category}</Badge>
        {item.effort && <Badge>{EFFORT_LABELS[item.effort] ?? item.effort}</Badge>}
        {item.status === "in_progress" && <Badge tone="warning">{ACTION_STATUS_LABELS.in_progress}</Badge>}
        {typeof d.expected_gain === "number" && d.expected_gain > 0 && (
          <span className="ml-auto text-xs font-medium text-[#006300] dark:text-[#0ca30c]">≈ +{d.expected_gain.toFixed(1)} GEO puanı</span>
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
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Tespit</div>
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
            {showUrls ? "Etkilenen sayfaları gizle" : `Etkilenen ${d.affected_count ?? urls.length} sayfayı göster`}
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
              ✓ Çözüldü Olarak İşaretle
            </Button>
            {item.status === "open" ? (
              <Button size="sm" loading={busy === "in_progress"} disabled={!!busy} onClick={() => onStatus("in_progress")}>
                Üzerinde çalışıyorum
              </Button>
            ) : (
              <Button size="sm" loading={busy === "open"} disabled={!!busy} onClick={() => onStatus("open")}>
                Açığa al
              </Button>
            )}
            <Button size="sm" variant="ghost" loading={busy === "dismissed"} disabled={!!busy} onClick={() => onStatus("dismissed")}>
              Yok say
            </Button>
          </>
        ) : item.status === "resolved" ? (
          <>
            <Button size="sm" variant="primary" loading={startingAudit} disabled={auditActive} onClick={() => void startAudit()} title="Yeni analiz düzeltmeyi doğrular; sorun sürüyorsa aksiyon yeniden açılır.">
              ↻ Yeniden Kontrol Et
            </Button>
            <Button size="sm" loading={busy === "open"} disabled={!!busy} onClick={() => onStatus("open")}>
              Tekrar aç
            </Button>
          </>
        ) : (
          <Button size="sm" loading={busy === "open"} disabled={!!busy} onClick={() => onStatus("open")}>
            Geri al
          </Button>
        )}
        <span className="ml-auto text-xs text-zinc-400">
          {item.status === "resolved" && item.resolvedAt ? `Çözüldü: ${formatDate(item.resolvedAt)}` : `Güncellendi: ${formatDate(item.updatedAt)}`}
        </span>
      </div>
    </article>
  );
}

export function ActionsView() {
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
      const msg: Record<string, string> = {
        resolved: "Çözüldü olarak işaretlendi. Doğrulamak için “Yeniden Kontrol Et” ile yeni analiz başlatın.",
        in_progress: "Üzerinde çalışılıyor olarak işaretlendi.",
        dismissed: "Aksiyon yok sayıldı; sonraki analizlerde yeniden oluşturulmayacak.",
        open: "Aksiyon yeniden açıldı.",
      };
      toast.push("success", msg[status] ?? "Güncellendi.");
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Ne Yapılmalı?</h2>
          <p className="text-sm text-zinc-500">Etki × kapsam / efor ile önceliklendirilmiş aksiyonlar. Kod bloklarını kopyalayıp sitenize uygulayın, ardından yeniden kontrol edin.</p>
        </div>
        <Button onClick={() => void startAudit()} loading={startingAudit} disabled={auditActive}>
          ↻ {auditActive ? "Kontrol sürüyor…" : "Tümünü Yeniden Kontrol Et"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <Segmented
          label="Durum"
          value={statusView}
          onChange={(v) => {
            setStatusView(v);
            setTier("all");
          }}
          options={[
            { value: "open", label: "Açık" },
            { value: "resolved", label: "Çözülen" },
            { value: "dismissed", label: "Yok sayılan" },
          ]}
        />
        <Segmented
          label="Öncelik"
          value={tier}
          onChange={setTier}
          options={[{ value: "all", label: "Tümü", count: counts.all ?? 0 }, ...TIERS.map((t) => ({ value: t.impact as string, label: t.label, count: counts[t.impact] ?? 0 }))]}
        />
        <select aria-label="Kategori" value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputBase} w-auto py-1.5 text-xs`}>
          <option value="">Tüm kategoriler</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c] ?? c}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={onlySnippets} onChange={(e) => setOnlySnippets(e.target.checked)} className="accent-indigo-600" />
          Sadece hazır kod bloğu olanlar
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
        <EmptyState icon={statusView === "open" && !items.length ? "🎉" : "∅"} title={statusView === "open" && !items.length ? "Açık aksiyon yok" : "Bu filtreye uyan aksiyon yok"}>
          {statusView === "open" && !items.length
            ? "Tüm öneriler çözülmüş ya da henüz analiz yapılmamış. Yeni bir analiz ile siteyi yeniden kontrol edebilirsiniz."
            : "Filtreleri değiştirmeyi deneyin."}
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
