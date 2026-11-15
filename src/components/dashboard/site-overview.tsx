"use client";

import Link from "next/link";
import { useState } from "react";
import { TIERS, VISIBILITY_MODEL_ORDER } from "@/lib/dashboard/format";
import { aiAccessScore, metricGrade, readPillars, type Pillar } from "@/lib/dashboard/pillars";
import { useApi } from "./api";
import { HistoryChart, ScoreBar, ScoreRing, VisibilityBars } from "./charts";
import { useSite } from "./site-shell";
import type { ActionItem, SiteReport } from "./types";
import { Badge, Button, Card, EmptyState, ErrorState, RichText, SkeletonCard, TONE_COLOR, TONE_ICON } from "./ui";
import { useFormat } from "./use-format";

function PillarChecks({ pillar, limit }: { pillar: Pillar | undefined; limit?: number }) {
  if (!pillar?.checks.length) return null;
  const checks = pillar.checks.filter((c) => c.applicable).slice(0, limit);
  return (
    <ul className="mt-4 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      {checks.map((c) => {
        const tone = c.passed ? "good" : c.score >= 40 ? "serious" : "critical";
        return (
          <li key={c.id} className="flex items-start gap-2 text-xs">
            <span aria-hidden className="mt-0.5 font-bold" style={{ color: TONE_COLOR[tone] }}>
              {TONE_ICON[tone]}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex justify-between gap-2">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">{c.label}</span>
                <span className="tabular-nums text-zinc-500">{c.score}</span>
              </div>
              {c.detail && <p className="mt-0.5 line-clamp-2 text-zinc-500" title={c.detail}>{c.detail}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PillarBreakdown({ pillars }: { pillars: Pillar[] }) {
  const { t } = useFormat();
  const [open, setOpen] = useState<string | null>(null);
  if (!pillars.length) return <p className="text-sm text-zinc-500">{t("overview.pillars.none")}</p>;
  return (
    <div className="space-y-4">
      {pillars.map((p) => (
        <div key={p.key}>
          <ScoreBar label={p.weight ? t("overview.pillars.withWeight", { label: p.label, percent: Math.round(p.weight * 100) }) : p.label} value={p.score} />
          {p.checks.length > 0 && (
            <button type="button" className="mt-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400" aria-expanded={open === p.key} onClick={() => setOpen(open === p.key ? null : p.key)}>
              {open === p.key ? t("overview.pillars.hideChecks") : t("overview.pillars.showChecks", { count: p.checks.length })}
            </button>
          )}
          {open === p.key && <PillarChecks pillar={p} />}
        </div>
      ))}
    </div>
  );
}

export function SiteOverview() {
  const { t, formatDate, tierFor, label } = useFormat();
  const { siteId, version, latestAudit, auditActive, startAudit, startingAudit } = useSite();
  const report = useApi<SiteReport>(`/api/sites/${siteId}/reports?days=90`, { version });
  const top = useApi<{ items: ActionItem[] }>(`/api/sites/${siteId}/actions?limit=4`, { version });

  if (report.loading)
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonCard key={i} lines={4} />
        ))}
        <SkeletonCard lines={6} className="md:col-span-2" />
        <SkeletonCard lines={6} className="md:col-span-2" />
      </div>
    );
  if (report.error) return <ErrorState error={report.error} onRetry={() => void report.reload()} />;
  const r = report.data!;

  if (!r.scores) {
    return (
      <EmptyState
        icon="📊"
        title={auditActive ? t("overview.empty.running") : latestAudit?.status === "failed" ? t("overview.empty.failed") : latestAudit?.status === "cancelled" ? t("overview.empty.cancelled") : t("overview.empty.none")}
        action={
          !auditActive && (
            <Button variant="primary" onClick={() => void startAudit()} loading={startingAudit}>
              {t("overview.empty.start")}
            </Button>
          )
        }
      >
        {auditActive
          ? t("overview.empty.runningHint")
          : latestAudit?.error
            ? t("overview.empty.error", { error: latestAudit.error })
            : t("overview.empty.hint")}
      </EmptyState>
    );
  }

  const metrics = r.scores.metrics;
  const pillars = readPillars(metrics, t);
  const aiAccess = aiAccessScore(metrics);
  const grade = metricGrade(metrics);
  const aiPillar = pillars.find((p) => p.key === "ai_access");
  const eeatPillar = pillars.find((p) => p.key === "eeat");
  const perModel = r.visibility.perModel;
  const modelKeys = [...VISIBILITY_MODEL_ORDER, ...Object.keys(perModel).filter((m) => !(VISIBILITY_MODEL_ORDER as readonly string[]).includes(m))];
  const visRows = modelKeys.map((m) => ({ model: m, label: label("model", m), ...(perModel[m] ?? { cited: 0, mentioned: 0, none: 0, total: 0 }) }));
  const summary = latestAudit?.status === "completed" ? latestAudit.summary : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title={t("overview.geo.title")} subtitle={t("overview.geo.subtitle", { date: formatDate(r.scores.auditedAt) })}>
          <ScoreRing value={r.scores.geo} label="GEO" delta={r.scores.delta.geo} caption={grade ? t("overview.geo.grade", { grade }) : undefined} />
          {summary && <p className="mt-4 text-xs leading-relaxed text-zinc-500">{summary}</p>}
        </Card>
        <Card title={t("overview.aiAccess.title")} subtitle={t("overview.aiAccess.subtitle")}>
          <ScoreRing value={aiAccess} label={t("overview.aiAccess.ring")} />
          <PillarChecks pillar={aiPillar} limit={4} />
        </Card>
        <Card title={t("overview.eeat.title")} subtitle={t("overview.eeat.subtitle")}>
          <ScoreRing value={r.scores.eeat} label="E-E-A-T" delta={r.scores.delta.eeat} />
          <PillarChecks pillar={eeatPillar} limit={4} />
        </Card>
        <Card title={t("overview.seo.title")} subtitle={t("overview.seo.subtitle")}>
          <ScoreRing value={r.scores.seo} label="SEO" delta={r.scores.delta.seo} />
          <div className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
            <div className="flex justify-between">
              <span>{t("overview.seo.openActions")}</span>
              <span className="font-medium tabular-nums text-zinc-800 dark:text-zinc-200">{r.actions.open}</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span>{t("overview.seo.resolved")}</span>
              <span className="font-medium tabular-nums text-zinc-800 dark:text-zinc-200">{r.actions.byStatus.resolved ?? 0}</span>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={t("overview.visibility.title")}
          subtitle={
            r.visibility.totalChecks
              ? [
                  t("overview.period.lastDays", { count: r.period.days }),
                  t("overview.visibility.responses", { count: r.visibility.totalChecks }),
                  t("overview.visibility.rateVisible", { rate: r.visibility.visibilityRate }),
                  t("overview.visibility.rateCited", { rate: r.visibility.citationRate }),
                ].join(" · ")
              : t("overview.visibility.subtitleEmpty")
          }
          action={
            <Link href={`/sites/${siteId}/visibility`} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              {t("overview.visibility.simulation")}
            </Link>
          }
        >
          {r.visibility.totalChecks ? (
            <VisibilityBars rows={visRows} />
          ) : (
            <EmptyState icon="🤖" title={t("overview.visibility.emptyTitle")} className="py-6">
              <RichText
                message={t("overview.visibility.emptyHint")}
                slots={{
                  link: (
                    <Link href={`/sites/${siteId}/visibility`} className="font-medium text-indigo-600">
                      {t("sites.tabs.visibility")}
                    </Link>
                  ),
                }}
              />
            </EmptyState>
          )}
        </Card>
        <Card title={t("overview.history.title")} subtitle={t("overview.history.subtitle", { count: r.period.days })}>
          {r.history.length ? <HistoryChart points={r.history} /> : <p className="text-sm text-zinc-500">{t("overview.history.none")}</p>}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card title={t("overview.breakdown.title")} subtitle={t("overview.breakdown.subtitle")} className="lg:col-span-3">
          <PillarBreakdown pillars={pillars} />
        </Card>
        <Card
          title={t("overview.actions.title")}
          subtitle={t("overview.actions.openCount", { count: r.actions.open })}
          className="lg:col-span-2"
          action={
            <Link href={`/sites/${siteId}/actions`} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              {t("overview.actions.all")}
            </Link>
          }
        >
          <div className="mb-4 grid grid-cols-3 gap-2">
            {TIERS.map((tier) => (
              <div key={tier.impact} className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/60">
                <div className="flex items-center gap-1 text-xs text-zinc-500">
                  <span aria-hidden style={{ color: TONE_COLOR[tier.tone] }}>
                    {TONE_ICON[tier.tone]}
                  </span>
                  {tierFor(tier.impact).label}
                </div>
                <div className="text-xl font-semibold tabular-nums">{r.actions.byImpact[tier.impact] ?? 0}</div>
              </div>
            ))}
          </div>
          {top.loading ? (
            <SkeletonCard lines={3} />
          ) : top.error ? (
            <ErrorState error={top.error} onRetry={() => void top.reload()} />
          ) : !top.data?.items.length ? (
            <p className="text-sm text-zinc-500">{t("overview.actions.none")}</p>
          ) : (
            <ul className="space-y-2">
              {top.data.items.map((a) => {
                const tier = tierFor(a.impact);
                return (
                  <li key={a.id}>
                    <Link href={`/sites/${siteId}/actions#${a.id}`} className="flex items-start gap-2 rounded-lg p-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                      <Badge tone={tier.tone} icon>
                        {tier.label}
                      </Badge>
                      <span className="min-w-0 flex-1 text-sm text-zinc-800 dark:text-zinc-200">{a.title}</span>
                      <span className="hidden text-xs text-zinc-400 sm:inline">{label("category", a.category)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <AuditHistory />
    </div>
  );
}

/** Audit status → badge text (catalog key) and tone. */
const AUDIT_STATUS: Record<string, { labelKey: string; tone: "good" | "critical" | "neutral" }> = {
  completed: { labelKey: "overview.audits.status.completed", tone: "good" },
  failed: { labelKey: "overview.audits.status.failed", tone: "critical" },
  pending: { labelKey: "overview.audits.status.pending", tone: "neutral" },
  running: { labelKey: "overview.audits.status.running", tone: "neutral" },
  cancelled: { labelKey: "overview.audits.status.cancelled", tone: "neutral" },
};

function AuditHistory() {
  const { t, formatDate, timeAgo } = useFormat();
  const { audits } = useSite();
  if (!audits.length) return null;
  return (
    <Card title={t("overview.audits.title")} subtitle={t("overview.audits.subtitle")}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-2 pr-3 font-medium">{t("overview.audits.date")}</th>
              <th className="py-2 pr-3 font-medium">{t("overview.audits.status")}</th>
              <th className="py-2 pr-3 text-right font-medium">GEO</th>
              <th className="py-2 pr-3 text-right font-medium">SEO</th>
              <th className="py-2 pr-3 text-right font-medium">E-E-A-T</th>
              <th className="py-2 pr-3 text-right font-medium">{t("overview.audits.pages")}</th>
              <th className="py-2 text-right font-medium">{t("overview.audits.actions")}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {audits.map((a) => {
              const s = AUDIT_STATUS[a.status] ?? AUDIT_STATUS.pending;
              return (
                <tr key={a.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-3 whitespace-nowrap" title={formatDate(a.createdAt)}>
                    {timeAgo(a.createdAt)}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={s.tone} icon>
                      {t(s.labelKey)}
                    </Badge>
                    {a.error && <span className="ml-2 text-xs text-red-600 dark:text-red-400" title={a.error}>{a.error.slice(0, 60)}</span>}
                  </td>
                  <td className="py-2 pr-3 text-right">{a.geoScore ?? "—"}</td>
                  <td className="py-2 pr-3 text-right">{a.seoScore ?? "—"}</td>
                  <td className="py-2 pr-3 text-right">{a.eeatScore ?? "—"}</td>
                  <td className="py-2 pr-3 text-right">{a.crawlSession?.pagesCrawled ?? "—"}</td>
                  <td className="py-2 text-right">{a._count.actionItems}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
