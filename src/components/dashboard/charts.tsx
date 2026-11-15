"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { scoreTone } from "@/lib/dashboard/format";
import { Button, TONE_COLOR, TONE_ICON } from "./ui";
import { useFormat } from "./use-format";

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Hero score with a ring meter, tinted by status band; band named in text (never color alone). */
export function ScoreRing({ value, label, size = 112, caption, delta }: { value: number | null | undefined; label: string; size?: number; caption?: ReactNode; delta?: number | null }) {
  const { t, scoreLabel } = useFormat();
  const tone = scoreTone(value);
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value)) / 100;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${value ?? t("labels.score.neutral")} / 100`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--chart-grid)" strokeWidth={stroke} />
        {value != null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={TONE_COLOR[tone]}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${c * pct} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: "stroke-dasharray 600ms ease" }}
          />
        )}
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="var(--chart-ink)" style={{ fontSize: size * 0.3, fontWeight: 650 }}>
          {value ?? "—"}
        </text>
      </svg>
      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</div>
        <div className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500">
          <span aria-hidden style={{ color: TONE_COLOR[tone] }}>
            {TONE_ICON[tone]}
          </span>
          {scoreLabel(value)}
          {delta != null && delta !== 0 && (
            <span className={delta > 0 ? "ml-1 text-[#006300] dark:text-[#0ca30c]" : "ml-1 text-red-700 dark:text-red-400"}>
              {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
            </span>
          )}
        </div>
        {caption && <div className="mt-1 text-xs text-zinc-500">{caption}</div>}
      </div>
    </div>
  );
}

/** Thin horizontal meter for sub-scores (0-100). */
export function ScoreBar({ label, value, detail }: { label: string; value: number; detail?: ReactNode }) {
  const tone = scoreTone(value);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">{label}</span>
        <span className="flex items-center gap-1 tabular-nums font-medium">
          <span aria-hidden className="text-xs" style={{ color: TONE_COLOR[tone] }}>
            {TONE_ICON[tone]}
          </span>
          {value}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--chart-grid)]" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(2, value)}%`, background: TONE_COLOR[tone], transition: "width 500ms ease" }} />
      </div>
      {detail && <p className="mt-1 text-xs text-zinc-500">{detail}</p>}
    </div>
  );
}

export type HistoryPoint = { date: string; geo: number | null; seo: number | null; eeat: number | null };
const SERIES = [
  { key: "geo", label: "GEO", color: "var(--series-1)" },
  { key: "seo", label: "SEO", color: "var(--series-2)" },
  { key: "eeat", label: "E-E-A-T", color: "var(--series-3)" },
] as const;

/** Direct end-of-line labels, nudged apart vertically so they never overlap (min 13px). */
function endLabels(points: HistoryPoint[], x: (i: number) => number, y: (v: number) => number) {
  const labels: { key: string; label: string; value: number; x: number; y: number }[] = [];
  for (const s of SERIES) {
    for (let i = points.length - 1; i >= 0; i--) {
      const v = points[i][s.key];
      if (v != null) {
        labels.push({ key: s.key, label: s.label, value: v, x: x(i), y: y(v) });
        break;
      }
    }
  }
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
  }
  return labels;
}

/** Score trend: 3 series on one 0-100 axis, crosshair tooltip, legend + end labels, table view. */
export function HistoryChart({ points }: { points: HistoryPoint[] }) {
  const { t, formatDate, formatDay } = useFormat();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const height = 220;
  const m = { top: 12, right: 64, bottom: 26, left: 32 };
  const w = Math.max(0, width - m.left - m.right);
  const h = height - m.top - m.bottom;
  const n = points.length;
  const x = (i: number) => m.left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => m.top + h - (v / 100) * h;

  const ticksX = n <= 6 ? points.map((_, i) => i) : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <ul className="flex flex-wrap gap-3 text-xs text-zinc-600 dark:text-zinc-400" aria-label={t("shared.chart.series")}>
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-4 rounded" style={{ background: s.color, height: 2 }} />
              {s.label}
            </li>
          ))}
        </ul>
        <Button size="sm" variant="ghost" onClick={() => setTable((v) => !v)} aria-pressed={table}>
          {table ? t("shared.chart.chart") : t("shared.chart.table")}
        </Button>
      </div>
      {table ? (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1 pr-2 font-medium">{t("shared.chart.date")}</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="py-1 pr-2 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {points.map((p) => (
                <tr key={p.date} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1 pr-2">{formatDate(p.date)}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="py-1 pr-2 text-right">
                      {p[s.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative" style={{ height }}>
          {width > 0 && (
            <svg
              width={width}
              height={height}
              role="img"
              aria-label={t("shared.chart.scoreHistory")}
              onMouseLeave={() => setHover(null)}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const px = e.clientX - rect.left - m.left;
                setHover(n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px / w) * (n - 1)))));
              }}
            >
              {[0, 25, 50, 75, 100].map((tick) => (
                <g key={tick}>
                  <line x1={m.left} x2={m.left + w} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} strokeWidth={1} />
                  <text x={m.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="central" fill="var(--chart-muted)" style={{ fontSize: 10 }} className="tabular-nums">
                    {tick}
                  </text>
                </g>
              ))}
              {ticksX.map((i) => (
                <text key={i} x={x(i)} y={height - 8} textAnchor="middle" fill="var(--chart-muted)" style={{ fontSize: 10 }}>
                  {formatDay(points[i].date)}
                </text>
              ))}
              {SERIES.map((s) => {
                const pts = points.map((p, i) => (p[s.key] == null ? null : ([x(i), y(p[s.key]!)] as const))).filter((p): p is readonly [number, number] => !!p);
                return (
                  <g key={s.key}>
                    {pts.length > 1 && <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
                    {pts.length === 1 && <circle cx={pts[0][0]} cy={pts[0][1]} r={4} fill={s.color} stroke="var(--chart-surface)" strokeWidth={2} />}
                  </g>
                );
              })}
              {endLabels(points, x, y).map((l) => (
                <text key={l.key} x={l.x + 8} y={l.y} dominantBaseline="central" fill="var(--chart-ink-2)" style={{ fontSize: 11 }}>
                  {l.label} {l.value}
                </text>
              ))}
              {hover != null && points[hover] && (
                <g>
                  <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + h} stroke="var(--chart-axis)" strokeWidth={1} />
                  {SERIES.map((s) =>
                    points[hover][s.key] == null ? null : (
                      <circle key={s.key} cx={x(hover)} cy={y(points[hover][s.key]!)} r={4.5} fill={s.color} stroke="var(--chart-surface)" strokeWidth={2} />
                    ),
                  )}
                </g>
              )}
            </svg>
          )}
          {hover != null && points[hover] && (
            <div
              className="pointer-events-none absolute top-0 z-10 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
              style={{ left: Math.min(Math.max(x(hover) + 12, 0), Math.max(0, width - 150)) }}
            >
              <div className="mb-1 font-medium text-zinc-900 dark:text-zinc-100">{formatDate(points[hover].date)}</div>
              {SERIES.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-4 text-zinc-600 dark:text-zinc-300">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="tabular-nums font-medium">{points[hover][s.key] ?? "—"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type ModelVisibility = { model: string; label: string; cited: number; mentioned: number; none: number; total: number };
/** Segment order and colors; the labels come from `labels.citation.<key>`. */
const PARTS = [
  { key: "cited", color: "var(--seq-strong)" },
  { key: "mentioned", color: "var(--seq-mid)" },
  { key: "none", color: "var(--seq-none)" },
] as const;

/** Per-model 100% stacked bars (ordinal: cited > mentioned > none), hover tooltip per segment. */
export function VisibilityBars({ rows }: { rows: ModelVisibility[] }) {
  const { t, label } = useFormat();
  const [hover, setHover] = useState<{ model: string; part: string } | null>(null);
  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-3 text-xs text-zinc-600 dark:text-zinc-400" aria-label={t("shared.chart.legend")}>
        {PARTS.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
            {label("citation", p.key)}
          </li>
        ))}
      </ul>
      <div className="space-y-3">
        {rows.map((r) => {
          const rate = r.total ? Math.round(((r.cited + r.mentioned) / r.total) * 100) : null;
          return (
            <div key={r.model}>
              <div className="mb-1 flex items-baseline justify-between text-sm">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">{r.label}</span>
                <span className="text-xs text-zinc-500">
                  {rate == null ? (
                    t("shared.chart.noChecks")
                  ) : (
                    <>
                      <span className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{t("shared.percent", { value: rate })}</span>{" "}
                      {t("shared.chart.visibilityCited", { cited: r.cited, total: r.total })}
                    </>
                  )}
                </span>
              </div>
              <div className="relative flex h-3 gap-[2px] overflow-visible">
                {r.total === 0 ? (
                  <div className="h-full w-full rounded bg-[var(--chart-grid)]" />
                ) : (
                  PARTS.map((p) => {
                    const v = r[p.key];
                    if (!v) return null;
                    const active = hover?.model === r.model && hover.part === p.key;
                    return (
                      <div
                        key={p.key}
                        className="relative h-full first:rounded-l last:rounded-r"
                        style={{ width: `${(v / r.total) * 100}%`, background: p.color, outline: active ? "2px solid var(--chart-ink)" : undefined, outlineOffset: 1 }}
                        onMouseEnter={() => setHover({ model: r.model, part: p.key })}
                        onMouseLeave={() => setHover(null)}
                        tabIndex={0}
                        onFocus={() => setHover({ model: r.model, part: p.key })}
                        onBlur={() => setHover(null)}
                        aria-label={t("shared.chart.segmentLabel", { model: r.label, part: label("citation", p.key), count: v, percent: Math.round((v / r.total) * 100) })}
                      >
                        {active && (
                          <div className="pointer-events-none absolute bottom-5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                            <span className="font-medium">{label("citation", p.key)}</span>: {t("shared.chart.responsesPercent", { count: v, percent: Math.round((v / r.total) * 100) })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
