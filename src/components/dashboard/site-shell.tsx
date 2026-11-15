"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { auditProgressView } from "@/lib/dashboard/audit-progress";
import { useT } from "@/lib/i18n/provider";
import { apiFetch, ApiError, errorMessage, useApi } from "./api";
import { AuditProgressPanel, useNow } from "./audit-progress";
import { useToast } from "./toast";
import type { AuditList, AuditRow, SiteSummary } from "./types";
import { Badge, Button, cx, EmptyState, ErrorState, Skeleton, Spinner } from "./ui";
import { useFormat } from "./use-format";

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

/** Site sub-pages; `labelKey` is the catalog key of the tab title (also reused for in-page links to a tab). */
const TABS = [
  { href: "", labelKey: "sites.tabs.overview" },
  { href: "/actions", labelKey: "sites.tabs.actions" },
  { href: "/studio", labelKey: "sites.tabs.studio" },
  { href: "/graph", labelKey: "sites.tabs.graph" },
  { href: "/bots", labelKey: "sites.tabs.bots" },
  { href: "/visibility", labelKey: "sites.tabs.visibility" },
  { href: "/competitors", labelKey: "sites.tabs.competitors" },
  { href: "/distribution", labelKey: "sites.tabs.distribution" },
  { href: "/chat", labelKey: "sites.tabs.chat" },
];

const ACTIVE_CRAWL = new Set(["queued", "running"]);
const ACTIVE_AUDIT = new Set(["pending", "running"]);

export function isAuditActive(a: AuditRow | null | undefined) {
  return !!a && ACTIVE_AUDIT.has(a.status) && (!a.crawlSession || ACTIVE_CRAWL.has(a.crawlSession.status));
}

export function SiteShellSkeleton() {
  const t = useT();
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6" role="status" aria-label={t("shared.loading")}>
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

function AuditStatus({ audit, runner }: { audit: AuditRow | null; runner: boolean | undefined }) {
  const { t, timeAgo } = useFormat();
  const active = isAuditActive(audit);
  const now = useNow(active ? 5000 : null);
  if (!audit) return <Badge>{t("sites.shell.status.none")}</Badge>;
  if (active) {
    const view = auditProgressView(audit, runner, now);
    if (view.kind === "no-runner")
      return (
        <Badge tone="warning" icon>
          {t("sites.shell.status.noRunner")}
        </Badge>
      );
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
        <Spinner className="h-3 w-3" />
        {view.kind === "running"
          ? view.percent != null ? t("sites.shell.status.runningPercent", { percent: view.percent }) : t("sites.shell.status.running")
          : t("sites.shell.status.starting")}
      </span>
    );
  }
  if (audit.status === "cancelled")
    return <Badge>{t("sites.shell.status.cancelled", { time: timeAgo(audit.crawlSession?.finishedAt ?? audit.createdAt) })}</Badge>;
  if (audit.status === "failed")
    return (
      <Badge tone="critical" icon>
        {t("sites.shell.status.failed", { time: timeAgo(audit.createdAt) })}
      </Badge>
    );
  return (
    <Badge tone="good" icon>
      {t("sites.shell.status.last", { time: timeAgo(audit.completedAt ?? audit.createdAt) })}
    </Badge>
  );
}

export function SiteShell({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const { t } = useFormat();
  const [version, setVersion] = useState(0);
  const [startingAudit, setStartingAudit] = useState(false);
  const [cancelingAudit, setCancelingAudit] = useState(false);

  const site = useApi<SiteSummary>(`/api/sites/${id}`, { version });
  const audits = useApi<AuditList>(`/api/sites/${id}/audit`, {
    // Poll only while an audit is in flight: quickly while it runs or is about to start, slowly when nothing executes it.
    pollMs: (d) => {
      const a = d?.items[0];
      if (!isAuditActive(a)) return 0;
      if (a?.crawlSession?.status !== "queued") return 3_000;
      return d?.runner === false ? 10_000 : 3_000;
    },
    onData: (prev, next) => {
      // Announce completion and refresh every page that depends on audit output.
      const before = prev?.items[0];
      const after = next.items[0];
      if (!before || !after || before.id !== after.id || !isAuditActive(before) || isAuditActive(after)) return;
      if (after.status === "completed") toast.push("success", t("sites.shell.toast.completed"));
      else if (after.status === "failed") toast.push("error", t("sites.shell.toast.failed", { error: after.error ?? t("shared.unknownError") }));
      else if (after.status === "cancelled") toast.push("info", t("sites.shell.toast.cancelled"));
      setVersion((v) => v + 1);
    },
  });
  const latest = audits.data?.items[0] ?? null;
  const active = isAuditActive(latest);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const cancelAudit = useCallback(async () => {
    const target = audits.data?.items[0];
    if (!target) return;
    setCancelingAudit(true);
    try {
      await apiFetch(`/api/sites/${id}/audit/${target.id}/cancel`, { method: "POST" });
    } catch (err) {
      // 409: it finished or was cancelled elsewhere a moment ago; the refresh below shows the real state.
      if (!(err instanceof ApiError && err.status === 409)) toast.push("error", errorMessage(err));
    } finally {
      await audits.reload(); // the data hook announces the cancellation and refreshes the pages
      setCancelingAudit(false);
    }
  }, [id, toast, audits]);
  const startAudit = useCallback(async () => {
    setStartingAudit(true);
    try {
      const res = await apiFetch<{ execution: string }>(`/api/sites/${id}/audit`, { method: "POST", json: { trigger: "manual" } });
      toast.push(
        res.execution === "started" ? "success" : "info",
        res.execution === "started" ? t("sites.shell.toast.started") : t("sites.shell.toast.queued"),
      );
      await audits.reload();
    } catch (err) {
      toast.push("error", err instanceof ApiError && err.status === 409 ? t("shared.audit.alreadyRunning") : errorMessage(err, t));
    } finally {
      setStartingAudit(false);
    }
  }, [id, toast, audits, t]);

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
          <EmptyState icon="?" title={t("sites.shell.notFound.title")} action={<Link href="/" className="text-sm font-medium text-indigo-600">{t("sites.shell.notFound.back")}</Link>}>
            {t("sites.shell.notFound.hint")}
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
          <nav aria-label={t("sites.shell.breadcrumb")} className="mb-2 text-xs text-zinc-500">
            <Link href="/" className="hover:text-zinc-900 dark:hover:text-zinc-100">
              {t("common.nav.sites")}
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
                <AuditStatus audit={latest} runner={audits.data?.runner} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (!window.confirm(t("sites.shell.deleteConfirm", { title: ctx.site.title }))) return;
                  try {
                    await apiFetch(`/api/sites/${id}`, { method: "DELETE" });
                    toast.push("success", t("sites.shell.toast.deleted"));
                    router.push("/");
                  } catch (err) {
                    toast.push("error", errorMessage(err, t));
                  }
                }}
              >
                {t("sites.shell.delete")}
              </Button>
              <Button variant="primary" onClick={() => void startAudit()} loading={startingAudit} disabled={active}>
                {active ? t("sites.shell.auditRunning") : t("sites.shell.runAudit")}
              </Button>
            </div>
          </div>
          {active && latest && <AuditProgressPanel audit={latest} runner={audits.data?.runner} canceling={cancelingAudit} onCancel={() => void cancelAudit()} />}
          <nav aria-label={t("sites.shell.tabs")} className="-mb-px mt-5 flex gap-1 overflow-x-auto">
            {TABS.map((tab) => {
              const href = `${base}${tab.href}`;
              const current = tab.href ? pathname.startsWith(href) : pathname === base;
              return (
                <Link
                  key={tab.href}
                  href={href}
                  aria-current={current ? "page" : undefined}
                  className={cx(
                    "whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                    current ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300" : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-800 dark:hover:text-zinc-200",
                  )}
                >
                  {t(tab.labelKey)}
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
