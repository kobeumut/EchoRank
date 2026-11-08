"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { formatDate, timeAgo } from "@/lib/dashboard/format";
import { apiFetch, ApiError, errorMessage, useApi } from "./api";
import { useToast } from "./toast";
import type { AuditRow, SiteSummary } from "./types";
import { Badge, Button, cx, EmptyState, ErrorState, Skeleton, Spinner } from "./ui";

type SiteCtx = {
  siteId: string;
  site: SiteSummary;
  audits: AuditRow[];
  latestAudit: AuditRow | null;
  auditActive: boolean;
  /** Changes whenever an audit finishes (or data was mutated) — pages refetch on it. */
  version: number;
  bump: () => void;
  startAudit: () => Promise<void>;
  startingAudit: boolean;
};

const SiteContext = createContext<SiteCtx | null>(null);
export function useSite() {
  const ctx = useContext(SiteContext);
  if (!ctx) throw new Error("useSite must be used inside <SiteShell>");
  return ctx;
}

const TABS = [
  { href: "", label: "Genel Bakış" },
  { href: "/actions", label: "Ne Yapılmalı?" },
  { href: "/studio", label: "İçerik Stüdyosu" },
  { href: "/graph", label: "Bilgi Grafı" },
  { href: "/visibility", label: "LLM Görünürlük" },
  { href: "/distribution", label: "AI Dağıtım" },
];

const ACTIVE_CRAWL = new Set(["queued", "running"]);
const ACTIVE_AUDIT = new Set(["pending", "running"]);

export function isAuditActive(a: AuditRow | null | undefined) {
  return !!a && ACTIVE_AUDIT.has(a.status) && (!a.crawlSession || ACTIVE_CRAWL.has(a.crawlSession.status));
}

export function SiteShellSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6" role="status" aria-label="Yükleniyor">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="mt-2 h-4 w-80" />
      <Skeleton className="mt-6 h-9 w-full max-w-2xl" />
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}

function AuditStatus({ audit }: { audit: AuditRow | null }) {
  if (!audit) return <Badge>Henüz analiz yapılmadı</Badge>;
  const crawl = audit.crawlSession;
  if (isAuditActive(audit)) {
    const running = crawl?.status === "running" || audit.status === "running";
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
        <Spinner className="h-3 w-3" />
        {running ? `Analiz sürüyor${crawl?.pagesCrawled ? ` · ${crawl.pagesCrawled} sayfa tarandı` : ""}` : "Analiz kuyrukta"}
      </span>
    );
  }
  if (audit.status === "failed")
    return (
      <Badge tone="critical" icon>
        Son analiz başarısız · {timeAgo(audit.createdAt)}
      </Badge>
    );
  return (
    <Badge tone="good" icon>
      Son analiz {timeAgo(audit.completedAt ?? audit.createdAt)}
    </Badge>
  );
}

export function SiteShell({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const [startingAudit, setStartingAudit] = useState(false);

  const site = useApi<SiteSummary>(`/api/sites/${id}`, { version });
  const audits = useApi<{ items: AuditRow[] }>(`/api/sites/${id}/audit`, {
    // Poll only while an audit is in flight (slower while it just sits in the queue).
    pollMs: (d) => {
      const a = d?.items[0];
      if (!isAuditActive(a)) return 0;
      return a?.crawlSession?.status === "queued" ? 10_000 : 4_000;
    },
    onData: (prev, next) => {
      // Announce completion and refresh every page that depends on audit output.
      const before = prev?.items[0];
      const after = next.items[0];
      if (!before || !after || before.id !== after.id || !isAuditActive(before) || isAuditActive(after)) return;
      if (after.status === "completed") toast.push("success", "Analiz tamamlandı. Skorlar ve aksiyonlar güncellendi.");
      else if (after.status === "failed") toast.push("error", `Analiz başarısız: ${after.error ?? "bilinmeyen hata"}`);
      setVersion((v) => v + 1);
    },
  });
  const latest = audits.data?.items[0] ?? null;
  const active = isAuditActive(latest);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const startAudit = useCallback(async () => {
    setStartingAudit(true);
    try {
      const res = await apiFetch<{ execution: string }>(`/api/sites/${id}/audit`, { method: "POST", json: { trigger: "manual" } });
      toast.push(
        res.execution === "started" ? "success" : "info",
        res.execution === "started" ? "Analiz başlatıldı: tarama → bilgi grafı → skorlama." : "Analiz kuyruğa alındı. Harici worker sonucu gönderdiğinde panel otomatik güncellenir.",
      );
      await audits.reload();
    } catch (err) {
      toast.push("error", err instanceof ApiError && err.status === 409 ? "Bu site için zaten devam eden bir analiz var." : errorMessage(err));
    } finally {
      setStartingAudit(false);
    }
  }, [id, toast, audits]);

  const ctx = useMemo<SiteCtx | null>(
    () =>
      site.data
        ? {
            siteId: id,
            site: site.data,
            audits: audits.data?.items ?? [],
            latestAudit: latest,
            auditActive: active,
            version,
            bump,
            startAudit,
            startingAudit,
          }
        : null,
    [id, site.data, audits.data, latest, active, version, bump, startAudit, startingAudit],
  );

  if (site.loading) return <SiteShellSkeleton />;
  if (site.error) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        {site.error instanceof ApiError && site.error.status === 404 ? (
          <EmptyState icon="?" title="Site bulunamadı" action={<Link href="/" className="text-sm font-medium text-indigo-600">← Sitelere dön</Link>}>
            Bu site silinmiş olabilir.
          </EmptyState>
        ) : (
          <ErrorState error={site.error} onRetry={() => void site.reload()} />
        )}
      </main>
    );
  }
  if (!ctx) return <SiteShellSkeleton />;

  const base = `/sites/${id}`;
  return (
    <SiteContext.Provider value={ctx}>
      <div className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
          <nav aria-label="Konum" className="mb-2 text-xs text-zinc-500">
            <Link href="/" className="hover:text-zinc-900 dark:hover:text-zinc-100">
              Siteler
            </Link>{" "}
            / <span className="text-zinc-700 dark:text-zinc-300">{ctx.site.title}</span>
          </nav>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold tracking-tight">{ctx.site.title}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-500">
                <a href={ctx.site.url} target="_blank" rel="noopener noreferrer" className="truncate hover:text-indigo-600">
                  {ctx.site.url} ↗
                </a>
                <AuditStatus audit={latest} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (!window.confirm(`"${ctx.site.title}" ve tüm analiz verileri silinsin mi? Bu işlem geri alınamaz.`)) return;
                  try {
                    await apiFetch(`/api/sites/${id}`, { method: "DELETE" });
                    toast.push("success", "Site silindi.");
                    router.push("/");
                  } catch (err) {
                    toast.push("error", errorMessage(err));
                  }
                }}
              >
                Sil
              </Button>
              <Button variant="primary" onClick={() => void startAudit()} loading={startingAudit} disabled={active}>
                {active ? "Analiz sürüyor…" : "Analizi Başlat"}
              </Button>
            </div>
          </div>
          {active && latest?.crawlSession?.status === "queued" && (
            <p className="mt-3 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-200">
              Analiz kuyrukta ({formatDate(latest.createdAt)}). Sunucuda <code>GEO_AUDIT_BIN</code> tanımlıysa birazdan başlar; değilse harici worker sonucu{" "}
              <code>/api/sites/:id/audit/:auditId/result</code> adresine gönderdiğinde panel kendiliğinden güncellenir.
            </p>
          )}
          <nav aria-label="Site sekmeleri" className="-mb-px mt-5 flex gap-1 overflow-x-auto">
            {TABS.map((t) => {
              const href = `${base}${t.href}`;
              const current = t.href ? pathname.startsWith(href) : pathname === base;
              return (
                <Link
                  key={t.href}
                  href={href}
                  aria-current={current ? "page" : undefined}
                  className={cx(
                    "whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                    current ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300" : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800 dark:hover:text-zinc-200",
                  )}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
    </SiteContext.Provider>
  );
}
