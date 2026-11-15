"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { scoreTone } from "@/lib/dashboard/format";
import { apiFetch, ApiError, errorMessage, useApi } from "./api";
import { useToast } from "./toast";
import type { SiteList, SiteSummary } from "./types";
import { Badge, Button, Card, EmptyState, ErrorState, Field, inputBase, inputClass, Skeleton, TONE_COLOR } from "./ui";
import { useFormat } from "./use-format";

function MiniScore({ label, value }: { label: string; value: number | null | undefined }) {
  const tone = scoreTone(value);
  return (
    <div className="flex flex-col items-center rounded-lg bg-zinc-50 px-3 py-1.5 dark:bg-zinc-800/60">
      <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="flex items-center gap-1 text-lg font-semibold tabular-nums">
        {value != null && <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: TONE_COLOR[tone] }} />}
        {value ?? "—"}
      </span>
    </div>
  );
}

function AddSiteForm({ onCreated }: { onCreated: (site: SiteSummary, audit: boolean) => void }) {
  const toast = useToast();
  const { t } = useFormat();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [keywords, setKeywords] = useState("");
  const [busy, setBusy] = useState<null | "add" | "audit">(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(audit: boolean) {
    setBusy(audit ? "audit" : "add");
    setError(null);
    try {
      const targetKeywords = keywords
        .split(/\n|,/)
        .map((k) => k.trim())
        .filter(Boolean);
      const site = await apiFetch<SiteSummary>("/api/sites", {
        method: "POST",
        json: { url: url.trim(), ...(title.trim() && { title: title.trim() }), ...(targetKeywords.length && { targetKeywords }) },
      });
      toast.push("success", t("sites.home.toast.added", { title: site.title }));
      setUrl("");
      setTitle("");
      setKeywords("");
      onCreated(site, audit);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setError(t("sites.home.error.duplicate"));
      else if (err instanceof ApiError && err.status === 400) setError(t("sites.home.error.invalidUrl"));
      else setError(errorMessage(err, t));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="grid gap-3 md:grid-cols-[2fr_1.2fr_auto] md:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(true);
      }}
    >
      <Field label={t("sites.home.form.url")}>
        <input required type="text" inputMode="url" placeholder={t("sites.home.form.urlPlaceholder")} value={url} onChange={(e) => setUrl(e.target.value)} className={inputClass} />
      </Field>
      <Field label={t("sites.home.form.title")}>
        <input type="text" placeholder={t("sites.home.form.titlePlaceholder")} value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} maxLength={200} />
      </Field>
      <div className="flex gap-2">
        <Button type="button" onClick={() => void submit(false)} loading={busy === "add"} disabled={!url.trim() || !!busy}>
          {t("sites.home.form.add")}
        </Button>
        <Button type="submit" variant="primary" loading={busy === "audit"} disabled={!url.trim() || !!busy}>
          {t("sites.home.form.addAndAudit")}
        </Button>
      </div>
      <div className="md:col-span-3">
        <Field label={t("sites.home.form.keywords")} hint={t("sites.home.form.keywordsHint")}>
          <textarea rows={2} placeholder={t("sites.home.form.keywordsPlaceholder")} value={keywords} onChange={(e) => setKeywords(e.target.value)} className={inputClass} />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 md:col-span-3 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}

export function SitesHome() {
  const router = useRouter();
  const toast = useToast();
  const { t, timeAgo } = useFormat();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const sites = useApi<SiteList>(`/api/sites?limit=100${query ? `&q=${encodeURIComponent(query)}` : ""}`);
  const [starting, setStarting] = useState<string | null>(null);

  async function startAudit(site: SiteSummary) {
    setStarting(site.id);
    try {
      const res = await apiFetch<{ execution: string }>(`/api/sites/${site.id}/audit`, { method: "POST", json: { trigger: "manual" } });
      toast.push("success", res.execution === "started" ? t("sites.home.toast.started") : t("sites.home.toast.queued"));
      router.push(`/sites/${site.id}`);
    } catch (err) {
      toast.push("error", err instanceof ApiError && err.status === 409 ? t("shared.audit.alreadyRunning") : errorMessage(err, t));
    } finally {
      setStarting(null);
    }
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("common.nav.sites")}</h1>
        <p className="mt-1 text-sm text-zinc-500">{t("sites.home.subtitle")}</p>
      </div>

      <Card title={t("sites.home.addCard.title")} subtitle={t("sites.home.addCard.subtitle")}>
        <AddSiteForm
          onCreated={(site, audit) => {
            void sites.reload();
            if (audit) void startAudit(site);
          }}
        />
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          {t("sites.home.tracked")} {sites.data && <span className="font-normal text-zinc-500">({sites.data.total})</span>}
        </h2>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
        >
          <input type="search" placeholder={t("sites.home.search.placeholder")} value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setQuery(q.trim())} className={`${inputBase} w-56`} aria-label={t("sites.home.search.label")} />
        </form>
      </div>

      {sites.loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" role="status" aria-label={t("shared.loading")}>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="mt-2 h-3 w-2/3" />
              <div className="mt-5 flex gap-2">
                <Skeleton className="h-12 flex-1" />
                <Skeleton className="h-12 flex-1" />
                <Skeleton className="h-12 flex-1" />
              </div>
            </div>
          ))}
        </div>
      ) : sites.error ? (
        <ErrorState error={sites.error} onRetry={() => void sites.reload()} />
      ) : !sites.data?.items.length ? (
        <EmptyState icon="🌐" title={query ? t("sites.home.empty.noMatch") : t("sites.home.empty.noSites")}>
          {query ? t("sites.home.empty.tryAnother") : t("sites.home.empty.addFirst")}
        </EmptyState>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sites.data.items.map((s) => (
            <li key={s.id} className="group flex flex-col rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-800">
              <Link href={`/sites/${s.id}`} className="min-w-0">
                <div className="truncate font-semibold text-zinc-900 group-hover:text-indigo-600 dark:text-zinc-100 dark:group-hover:text-indigo-400">{s.title}</div>
                <div className="truncate text-sm text-zinc-500">{s.url}</div>
              </Link>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <MiniScore label="GEO" value={s.latestAudit?.geoScore} />
                <MiniScore label="SEO" value={s.latestAudit?.seoScore} />
                <MiniScore label="E-E-A-T" value={s.latestAudit?.eeatScore} />
              </div>
              <div className="mt-4 flex items-center justify-between gap-2 text-xs text-zinc-500">
                <span>{s.latestAudit ? t("sites.home.card.lastAudit", { time: timeAgo(s.latestAudit.createdAt) }) : t("sites.home.card.noAudit")}</span>
                {!!s.openActionItems && (
                  <Badge tone="serious" icon>
                    {t("sites.home.card.openActions", { count: s.openActionItems })}
                  </Badge>
                )}
              </div>
              <div className="mt-4 flex gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                <Button size="sm" variant="primary" loading={starting === s.id} onClick={() => void startAudit(s)}>
                  {t("sites.home.card.runAudit")}
                </Button>
                <Link href={`/sites/${s.id}`} className="ml-auto inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950">
                  {t("sites.home.card.open")}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
