"use client";

import { Fragment, useMemo } from "react";
import { annotate, diffStats, sideBySideDiff, SIGNAL_LABELS, type DiffRow, type DiffSeg, type Piece, type SignalTag } from "@/lib/dashboard/autogeo-studio";
import { cx } from "./ui";

export type DiffMode = "split" | "unified";

const KIND_CLASS: Record<Piece["kind"], string> = {
  same: "",
  removed: "bg-red-200/80 text-red-950 line-through decoration-red-500/60 dark:bg-red-900/60 dark:text-red-100",
  added: "bg-emerald-200/80 text-emerald-950 dark:bg-emerald-800/60 dark:text-emerald-50",
};

/** GEO signals: an underline + tint so they read on top of the red/green diff background (and never by color alone: a legend + title names them). */
const TAG_CLASS: Record<SignalTag, string> = {
  stat: "underline decoration-sky-500 decoration-2 underline-offset-2 font-semibold",
  quote: "italic underline decoration-violet-500 decoration-2 underline-offset-2",
  citation: "underline decoration-amber-500 decoration-2 underline-offset-2",
  placeholder: "rounded-sm outline outline-1 outline-dashed outline-orange-500 bg-orange-100/80 text-orange-950 dark:bg-orange-900/50 dark:text-orange-100",
};

export const TAG_SWATCH: Record<SignalTag, string> = {
  stat: "border-b-2 border-sky-500",
  quote: "border-b-2 border-violet-500 italic",
  citation: "border-b-2 border-amber-500",
  placeholder: "rounded-sm border border-dashed border-orange-500 bg-orange-100 dark:bg-orange-900/50",
};

function Pieces({ segs }: { segs: DiffSeg[] }) {
  const pieces = useMemo(() => annotate(segs), [segs]);
  if (!pieces.length) return <span className="select-none text-zinc-300 dark:text-zinc-700">⏎</span>;
  return (
    <>
      {pieces.map((p, i) => (
        <span key={i} className={cx(KIND_CLASS[p.kind], p.tag && TAG_CLASS[p.tag])} title={p.tag ? SIGNAL_LABELS[p.tag] : undefined}>
          {p.text}
        </span>
      ))}
    </>
  );
}

const ROW_BG: Record<DiffRow["type"], { left: string; right: string }> = {
  same: { left: "", right: "" },
  changed: { left: "bg-red-50 dark:bg-red-950/30", right: "bg-emerald-50 dark:bg-emerald-950/30" },
  removed: { left: "bg-red-50 dark:bg-red-950/30", right: "bg-zinc-50 dark:bg-zinc-900/60" },
  added: { left: "bg-zinc-50 dark:bg-zinc-900/60", right: "bg-emerald-50 dark:bg-emerald-950/30" },
};

const gutter = "select-none px-2 text-right font-mono text-[10px] leading-6 text-zinc-400 tabular-nums";
const cell = "min-w-0 whitespace-pre-wrap break-words px-3 py-0.5 text-[13px] leading-6 text-zinc-800 dark:text-zinc-200";

export function SignalLegend({ className }: { className?: string }) {
  return (
    <ul className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500", className)} aria-label="Renk açıklaması">
      <li className="flex items-center gap-1">
        <span className="rounded-sm bg-red-200 px-1 text-red-950 line-through dark:bg-red-900/60 dark:text-red-100">abc</span> çıkarılan
      </li>
      <li className="flex items-center gap-1">
        <span className="rounded-sm bg-emerald-200 px-1 text-emerald-950 dark:bg-emerald-800/60 dark:text-emerald-50">abc</span> eklenen
      </li>
      {(Object.keys(SIGNAL_LABELS) as SignalTag[]).map((t) => (
        <li key={t} className="flex items-center gap-1">
          <span className={cx("px-1 text-zinc-700 dark:text-zinc-200", TAG_SWATCH[t])}>12</span> {SIGNAL_LABELS[t].toLowerCase()}
        </li>
      ))}
    </ul>
  );
}

/** Side-by-side (or unified) line diff with word-level changes and GEO signal highlighting. */
export function DiffViewer({ original, suggested, mode, maxHeight = "28rem" }: { original: string; suggested: string; mode: DiffMode; maxHeight?: string }) {
  const rows = useMemo(() => sideBySideDiff(original, suggested), [original, suggested]);
  const stats = useMemo(() => diffStats(rows), [rows]);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-950">
        {mode === "split" ? (
          <div className="grid flex-1 grid-cols-2 gap-2 font-medium text-zinc-600 dark:text-zinc-400">
            <span>Orijinal içerik</span>
            <span>AI optimizasyonlu içerik</span>
          </div>
        ) : (
          <span className="font-medium text-zinc-600 dark:text-zinc-400">Birleşik görünüm</span>
        )}
        <span className="tabular-nums text-zinc-500">
          <span className="text-emerald-700 dark:text-emerald-400">+{stats.addedWords}</span> / <span className="text-red-700 dark:text-red-400">−{stats.removedWords}</span> kelime
        </span>
      </div>
      <div className="overflow-auto bg-white dark:bg-zinc-950" style={{ maxHeight }}>
        {mode === "split" ? (
          <div role="table" aria-label="Yan yana karşılaştırma" className="grid min-w-[40rem] grid-cols-[2.25rem_minmax(0,1fr)_2.25rem_minmax(0,1fr)]">
            {rows.map((r, i) => (
              <Fragment key={i}>
                <div role="cell" className={cx(gutter, ROW_BG[r.type].left)}>
                  {r.left?.no ?? ""}
                </div>
                <div role="cell" className={cx(cell, "border-r border-zinc-100 dark:border-zinc-800", ROW_BG[r.type].left)}>
                  {r.left ? <Pieces segs={r.left.segs} /> : null}
                </div>
                <div role="cell" className={cx(gutter, ROW_BG[r.type].right)}>
                  {r.right?.no ?? ""}
                </div>
                <div role="cell" className={cx(cell, ROW_BG[r.type].right)}>
                  {r.right ? <Pieces segs={r.right.segs} /> : null}
                </div>
              </Fragment>
            ))}
          </div>
        ) : (
          <div role="table" aria-label="Birleşik karşılaştırma" className="grid grid-cols-[2.25rem_1.25rem_minmax(0,1fr)]">
            {rows.flatMap((r, i) => {
              const out = [];
              if (r.type === "same") out.push({ key: `${i}s`, sign: " ", no: r.left!.no, segs: r.left!.segs, bg: "" });
              else {
                if (r.left) out.push({ key: `${i}l`, sign: "−", no: r.left.no, segs: r.left.segs, bg: "bg-red-50 dark:bg-red-950/30" });
                if (r.right) out.push({ key: `${i}r`, sign: "+", no: r.right.no, segs: r.right.segs, bg: "bg-emerald-50 dark:bg-emerald-950/30" });
              }
              return out.map((o) => (
                <Fragment key={o.key}>
                  <div role="cell" className={cx(gutter, o.bg)}>
                    {o.no}
                  </div>
                  <div role="cell" aria-hidden className={cx("select-none text-center font-mono text-xs leading-6 text-zinc-400", o.bg)}>
                    {o.sign}
                  </div>
                  <div role="cell" className={cx(cell, o.bg)}>
                    <Pieces segs={o.segs} />
                  </div>
                </Fragment>
              ));
            })}
          </div>
        )}
      </div>
    </div>
  );
}
