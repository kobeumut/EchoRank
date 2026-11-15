"use client";

import { useState } from "react";
import { annotate, capsuleFit, pagePath, suggestionStatusLabel, type CapsuleCard, type TableCard } from "@/lib/dashboard/autogeo-studio";
import { Badge, CodeBlock, CopyButton, cx, EmptyState, Segmented } from "./ui";
import { useFormat } from "./use-format";

/** Capsule text with GEO-signal tinting (placeholders stand out so editors fill them before publishing). */
function SignalText({ text }: { text: string }) {
  const pieces = annotate([{ text, kind: "same" }]);
  return (
    <>
      {pieces.map((p, i) => (
        <span
          key={i}
          className={cx(
            p.tag === "placeholder" && "rounded-sm bg-orange-100 px-0.5 text-orange-900 outline outline-1 outline-dashed outline-orange-400 dark:bg-orange-900/50 dark:text-orange-100",
            p.tag === "stat" && "font-semibold text-sky-800 dark:text-sky-300",
            p.tag === "citation" && "underline decoration-amber-500 decoration-2 underline-offset-2",
          )}
        >
          {p.text}
        </span>
      ))}
    </>
  );
}

function plainCapsule(md: string) {
  return md.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`>#]/g, "").trim();
}

export function CapsuleGrid({ capsules }: { capsules: CapsuleCard[] }) {
  const { t } = useFormat();
  if (!capsules.length)
    return (
      <EmptyState icon="❝" title={t("studio.capsules.emptyTitle")}>
        {t("studio.capsules.emptyHint")}
      </EmptyState>
    );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {capsules.map((c) => {
        const fit = capsuleFit(c.words, t);
        const pct = Math.min(100, (c.words / 75) * 100);
        return (
          <article key={c.key} className="flex flex-col rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={fit.tone} icon>
                {t("studio.capsules.words", { count: c.words, fit: fit.label })}
              </Badge>
              {c.placeholders > 0 && <Badge tone="warning">{t("studio.card.fieldsToFill", { count: c.placeholders })}</Badge>}
              {c.source === "page" && <Badge>{t("studio.capsules.pageSummary")}</Badge>}
              {c.status && c.status !== "pending" && <Badge tone={c.status === "applied" ? "good" : "neutral"}>{suggestionStatusLabel(t, c.status)}</Badge>}
            </div>
            <div className="mt-3 truncate font-mono text-[11px] text-zinc-500" title={c.pageUrl}>
              {pagePath(c.pageUrl)}
            </div>
            {c.heading && <h3 className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{c.heading}</h3>}
            <blockquote className="mt-2 flex-1 border-l-4 border-indigo-400 bg-indigo-50/60 px-3 py-2 text-sm leading-relaxed text-zinc-800 dark:border-indigo-500 dark:bg-indigo-950/30 dark:text-zinc-200">
              <SignalText text={plainCapsule(c.markdown)} />
            </blockquote>
            {/* 40-60 word target band on a 0-75 scale */}
            <div className="relative mt-3 h-1.5 rounded-full bg-[var(--chart-grid)]" role="meter" aria-valuemin={0} aria-valuemax={75} aria-valuenow={c.words} aria-label={t("studio.capsules.meterLabel")}>
              <div className="absolute inset-y-0 rounded-full bg-emerald-500/25" style={{ left: `${(40 / 75) * 100}%`, width: `${(20 / 75) * 100}%` }} />
              <div className={cx("absolute -top-0.5 h-2.5 w-1 rounded-full", fit.tone === "good" ? "bg-emerald-600" : fit.tone === "warning" ? "bg-amber-500" : "bg-red-600")} style={{ left: `calc(${pct}% - 2px)` }} />
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <CopyButton text={c.markdown} label={t("studio.card.copyMarkdown")} />
              <CopyButton text={c.html} label={t("studio.card.copyHtml")} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function TablePreview({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-950">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 font-medium">
                <SignalText text={h} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {body.map((r, i) => (
            <tr key={i}>
              {head.map((_, k) => (
                <td key={k} className="px-3 py-2 align-top text-zinc-700 dark:text-zinc-300">
                  <SignalText text={r[k] ?? ""} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableCardView({ table }: { table: TableCard }) {
  const { t } = useFormat();
  const [view, setView] = useState<"preview" | "html" | "markdown">("preview");
  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{table.title}</h3>
          <div className="truncate font-mono text-[11px] text-zinc-500" title={table.pageUrl}>
            {pagePath(table.pageUrl)} · {t("studio.tables.size", { count: Math.max(0, table.rows.length - 1), cols: table.rows[0]?.length ?? 0 })}
          </div>
        </div>
        <Segmented
          label={t("studio.tables.view")}
          value={view}
          onChange={setView}
          options={[
            { value: "preview", label: t("studio.tables.preview") },
            { value: "html", label: "HTML" },
            { value: "markdown", label: "Markdown" },
          ]}
        />
      </div>
      <div className="mt-3">
        {view === "preview" ? (
          <TablePreview rows={table.rows} />
        ) : (
          <CodeBlock code={view === "html" ? table.html : table.markdown} language={view} filename={`table.${view === "html" ? "html" : "md"}`} maxHeight="16rem" />
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <CopyButton text={table.markdown} label={t("studio.card.copyMarkdown")} />
        <CopyButton text={table.html} label={t("studio.card.copyHtml")} />
      </div>
    </article>
  );
}

export function TableList({ tables }: { tables: TableCard[] }) {
  const { t } = useFormat();
  if (!tables.length)
    return (
      <EmptyState icon="▦" title={t("studio.tables.emptyTitle")}>
        {t("studio.tables.emptyHint")}
      </EmptyState>
    );
  return (
    <div className="space-y-4">
      {tables.map((table) => (
        <TableCardView key={table.key} table={table} />
      ))}
    </div>
  );
}
