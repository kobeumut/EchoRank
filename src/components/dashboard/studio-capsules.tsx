"use client";

import { useState } from "react";
import { annotate, capsuleFit, pagePath, SUGGESTION_STATUS_LABELS, type CapsuleCard, type TableCard } from "@/lib/dashboard/autogeo-studio";
import { Badge, CodeBlock, CopyButton, cx, EmptyState, Segmented } from "./ui";

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
  if (!capsules.length)
    return (
      <EmptyState icon="❝" title="Yanıt kapsülü önerisi yok">
        Bu filtrede başlıklar için 40-60 kelimelik hap yanıt önerisi bulunmuyor. Başlıklarınız zaten doğrudan yanıtla başlıyor olabilir.
      </EmptyState>
    );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {capsules.map((c) => {
        const fit = capsuleFit(c.words);
        const pct = Math.min(100, (c.words / 75) * 100);
        return (
          <article key={c.key} className="flex flex-col rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={fit.tone} icon>
                {c.words} kelime · {fit.label}
              </Badge>
              {c.placeholders > 0 && <Badge tone="warning">{c.placeholders} alan doldurulmalı</Badge>}
              {c.source === "page" && <Badge>Sayfa özeti</Badge>}
              {c.status && c.status !== "pending" && <Badge tone={c.status === "applied" ? "good" : "neutral"}>{SUGGESTION_STATUS_LABELS[c.status] ?? c.status}</Badge>}
            </div>
            <div className="mt-3 truncate font-mono text-[11px] text-zinc-500" title={c.pageUrl}>
              {pagePath(c.pageUrl)}
            </div>
            {c.heading && <h3 className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{c.heading}</h3>}
            <blockquote className="mt-2 flex-1 border-l-4 border-indigo-400 bg-indigo-50/60 px-3 py-2 text-sm leading-relaxed text-zinc-800 dark:border-indigo-500 dark:bg-indigo-950/30 dark:text-zinc-200">
              <SignalText text={plainCapsule(c.markdown)} />
            </blockquote>
            {/* 40-60 word target band on a 0-75 scale */}
            <div className="relative mt-3 h-1.5 rounded-full bg-[var(--chart-grid)]" role="meter" aria-valuemin={0} aria-valuemax={75} aria-valuenow={c.words} aria-label="Kelime sayısı (hedef 40-60)">
              <div className="absolute inset-y-0 rounded-full bg-emerald-500/25" style={{ left: `${(40 / 75) * 100}%`, width: `${(20 / 75) * 100}%` }} />
              <div className={cx("absolute -top-0.5 h-2.5 w-1 rounded-full", fit.tone === "good" ? "bg-emerald-600" : fit.tone === "warning" ? "bg-amber-500" : "bg-red-600")} style={{ left: `calc(${pct}% - 2px)` }} />
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <CopyButton text={c.markdown} label="Copy Markdown" />
              <CopyButton text={c.html} label="Copy HTML" />
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

function TableCardView({ t }: { t: TableCard }) {
  const [view, setView] = useState<"preview" | "html" | "markdown">("preview");
  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t.title}</h3>
          <div className="truncate font-mono text-[11px] text-zinc-500" title={t.pageUrl}>
            {pagePath(t.pageUrl)} · {Math.max(0, t.rows.length - 1)} satır × {t.rows[0]?.length ?? 0} sütun
          </div>
        </div>
        <Segmented
          label="Tablo görünümü"
          value={view}
          onChange={setView}
          options={[
            { value: "preview", label: "Önizleme" },
            { value: "html", label: "HTML" },
            { value: "markdown", label: "Markdown" },
          ]}
        />
      </div>
      <div className="mt-3">
        {view === "preview" ? (
          <TablePreview rows={t.rows} />
        ) : (
          <CodeBlock code={view === "html" ? t.html : t.markdown} language={view} filename={`tablo.${view === "html" ? "html" : "md"}`} maxHeight="16rem" />
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <CopyButton text={t.markdown} label="Copy Markdown" />
        <CopyButton text={t.html} label="Copy HTML" />
      </div>
    </article>
  );
}

export function TableList({ tables }: { tables: TableCard[] }) {
  if (!tables.length)
    return (
      <EmptyState icon="▦" title="Tablo önerisi yok">
        Karşılaştırma veya temel rakamlar tablosu önerisi bulunmuyor. Tablo içeren sayfalar için motor yeni tablo önermez.
      </EmptyState>
    );
  return (
    <div className="space-y-4">
      {tables.map((t) => (
        <TableCardView key={t.key} t={t} />
      ))}
    </div>
  );
}
