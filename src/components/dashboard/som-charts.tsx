"use client";

import { useState } from "react";
import type { BrandRow, TrendSeries } from "@/lib/dashboard/competitor-intel";
import { formatDay, MODEL_LABELS } from "@/lib/dashboard/format";
import { useWidth } from "./charts";
import type { ModelShare } from "./types";
import { Button, cx } from "./ui";

const pct = (v: number | null | undefined) => (v == null ? "—" : `%${Math.round(v * 10) / 10}`);

/** Overall Share of Model: donut (site segment outlined) + ranked bars with direct labels. */
export function ShareDonut({ rows }: { rows: BrandRow[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const size = 168;
  const stroke = 26;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = rows.reduce((n, b) => n + b.share, 0);
  const site = rows.find((b) => b.isSite);
  const focus = rows.find((b) => b.domain === hover) ?? site;
  let offset = 0;
  const ranked = [...rows].sort((a, b) => b.share - a.share || Number(b.isSite) - Number(a.isSite));
  const max = Math.max(1, ...rows.map((b) => b.share));
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Model payı dağılımı: ${rows.map((b) => `${b.name} ${pct(b.share)}`).join(", ")}`} className="shrink-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--chart-grid)" strokeWidth={stroke} />
        {total > 0 &&
          rows.map((b) => {
            const len = (b.share / total) * c;
            const gap = rows.filter((x) => x.share > 0).length > 1 ? 2 : 0;
            const seg = (
              <circle
                key={b.domain}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={b.color}
                strokeWidth={hover === b.domain ? stroke + 4 : stroke}
                strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                onMouseEnter={() => setHover(b.domain)}
                onMouseLeave={() => setHover(null)}
                style={{ transition: "stroke-width 120ms ease" }}
              />
            );
            offset += len;
            return b.share > 0 ? seg : null;
          })}
        <text x="50%" y="46%" textAnchor="middle" dominantBaseline="central" fill="var(--chart-ink)" style={{ fontSize: 26, fontWeight: 650 }} className="tabular-nums">
          {total > 0 ? pct(focus?.share) : "—"}
        </text>
        <text x="50%" y="62%" textAnchor="middle" dominantBaseline="central" fill="var(--chart-muted)" style={{ fontSize: 11 }}>
          {total > 0 ? (focus?.isSite ? "Siteniz" : focus?.name.slice(0, 18)) : "Atıf yok"}
        </text>
      </svg>
      <ul className="w-full min-w-0 flex-1 space-y-2" aria-label="Marka bazında model payı">
        {ranked.map((b) => (
          <li
            key={b.domain}
            className={cx("rounded-md px-1 py-0.5", hover === b.domain && "bg-zinc-50 dark:bg-zinc-800/60")}
            onMouseEnter={() => setHover(b.domain)}
            onMouseLeave={() => setHover(null)}
          >
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: b.color }} />
                <span className={cx("truncate", b.isSite ? "font-semibold" : "text-zinc-700 dark:text-zinc-300")} title={b.domain}>
                  {b.name}
                </span>
                {b.isSite && <span className="text-[10px] font-medium uppercase tracking-wide text-indigo-600 dark:text-indigo-400">Siz</span>}
              </span>
              <span className="tabular-nums text-sm font-semibold">{pct(b.share)}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--chart-grid)]">
              <div className="h-full rounded-full" style={{ width: `${(b.share / max) * 100}%`, background: b.color }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Per-model 100% stacked brand shares; same brand colors as the donut. */
export function ModelShareBars({ perModel, rows, models }: { perModel: Record<string, { samples: number; shares: ModelShare[] }>; rows: BrandRow[]; models: readonly string[] }) {
  const [hover, setHover] = useState<{ model: string; domain: string } | null>(null);
  const color = new Map(rows.map((b) => [b.domain, b]));
  return (
    <div className="space-y-4">
      {models.map((model) => {
        const d = perModel[model];
        const shares = (d?.shares ?? []).filter((s) => (s.citationShare ?? 0) > 0);
        const site = d?.shares.find((s) => color.get(s.domain)?.isSite);
        return (
          <div key={model}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium text-zinc-800 dark:text-zinc-200">{MODEL_LABELS[model] ?? model}</span>
              <span className="text-xs text-zinc-500">
                {!d?.samples ? (
                  "Henüz yanıt yok"
                ) : (
                  <>
                    Siz <span className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{pct(site?.citationShare ?? 0)}</span> · {d.samples} yanıt
                  </>
                )}
              </span>
            </div>
            <div className="flex h-3.5 gap-[2px]">
              {!shares.length ? (
                <div className="h-full w-full rounded bg-[var(--chart-grid)]" title={d?.samples ? "Bu modelde marka atfı yok" : undefined} />
              ) : (
                shares.map((s) => {
                  const b = color.get(s.domain);
                  const active = hover?.model === model && hover.domain === s.domain;
                  return (
                    <div
                      key={s.domain}
                      tabIndex={0}
                      className="relative h-full first:rounded-l last:rounded-r"
                      style={{ width: `${s.citationShare}%`, background: b?.color ?? "var(--chart-muted)", outline: active || b?.isSite ? "2px solid var(--chart-ink)" : undefined, outlineOffset: b?.isSite && !active ? -2 : 1 }}
                      onMouseEnter={() => setHover({ model, domain: s.domain })}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover({ model, domain: s.domain })}
                      onBlur={() => setHover(null)}
                      aria-label={`${MODEL_LABELS[model] ?? model} — ${b?.name ?? s.domain}: ${pct(s.citationShare)} (${s.citations} atıf)`}
                    >
                      {active && (
                        <div className="pointer-events-none absolute bottom-5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                          <span className="font-medium">{b?.name ?? s.domain}</span>: {pct(s.citationShare)} · {s.citations} atıf
                          {s.recommendationShare != null && <> · tavsiye payı {pct(s.recommendationShare)}</>}
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
  );
}

/** Share of Model over time: one line per brand (site emphasised), crosshair tooltip, table view. */
export function ShareTrendChart({ dates, series, granularity }: { dates: string[]; series: TrendSeries[]; granularity: "day" | "week" }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const height = 220;
  const m = { top: 12, right: 16, bottom: 26, left: 36 };
  const w = Math.max(0, width - m.left - m.right);
  const h = height - m.top - m.bottom;
  const n = dates.length;
  // Multiples of 20 keep the quarter gridlines on whole percentages.
  const top = Math.min(100, Math.max(20, Math.ceil(Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))) / 20) * 20));
  const x = (i: number) => m.left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = (v: number) => m.top + h - (v / top) * h;
  const ticksX = n <= 6 ? dates.map((_, i) => i) : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const label = (d: string) => (granularity === "week" ? `${formatDay(d)} haftası` : formatDay(d));
  const ordered = [...series].sort((a, b) => Number(a.isSite) - Number(b.isSite));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <ul className="flex flex-wrap gap-3 text-xs text-zinc-600 dark:text-zinc-400" aria-label="Seriler">
          {series.map((s) => (
            <li key={s.domain} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block w-4 rounded" style={{ background: s.color, height: s.isSite ? 3 : 2 }} />
              <span className={s.isSite ? "font-semibold text-zinc-800 dark:text-zinc-200" : undefined}>{s.domain}</span>
            </li>
          ))}
        </ul>
        <Button size="sm" variant="ghost" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? "Grafik" : "Tablo"}
        </Button>
      </div>
      {table ? (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1 pr-2 font-medium">{granularity === "week" ? "Hafta" : "Gün"}</th>
                {series.map((s) => (
                  <th key={s.domain} className="py-1 pr-2 text-right font-medium">
                    {s.domain}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {dates.map((d, i) => (
                <tr key={d} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1 pr-2">{label(d)}</td>
                  {series.map((s) => (
                    <td key={s.domain} className="py-1 pr-2 text-right">
                      {pct(s.values[i])}
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
              aria-label="Model payı trend grafiği"
              onMouseLeave={() => setHover(null)}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const px = e.clientX - rect.left - m.left;
                setHover(n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((px / w) * (n - 1)))));
              }}
            >
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <g key={f}>
                  <line x1={m.left} x2={m.left + w} y1={y(top * f)} y2={y(top * f)} stroke={f === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} strokeWidth={1} />
                  <text x={m.left - 6} y={y(top * f)} textAnchor="end" dominantBaseline="central" fill="var(--chart-muted)" style={{ fontSize: 10 }} className="tabular-nums">
                    %{Math.round(top * f)}
                  </text>
                </g>
              ))}
              {ticksX.map((i) => (
                <text key={i} x={x(i)} y={height - 8} textAnchor="middle" fill="var(--chart-muted)" style={{ fontSize: 10 }}>
                  {formatDay(dates[i])}
                </text>
              ))}
              {ordered.map((s) => {
                const pts = s.values.map((v, i) => (v == null ? null : ([x(i), y(v)] as const))).filter((p): p is readonly [number, number] => !!p);
                return (
                  <g key={s.domain} opacity={s.isSite ? 1 : 0.85}>
                    {pts.length > 1 && <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={s.color} strokeWidth={s.isSite ? 3 : 1.75} strokeLinejoin="round" strokeLinecap="round" />}
                    {pts.length === 1 && <circle cx={pts[0][0]} cy={pts[0][1]} r={4} fill={s.color} stroke="var(--chart-surface)" strokeWidth={2} />}
                  </g>
                );
              })}
              {hover != null && dates[hover] && (
                <g>
                  <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + h} stroke="var(--chart-axis)" strokeWidth={1} />
                  {series.map((s) =>
                    s.values[hover] == null ? null : <circle key={s.domain} cx={x(hover)} cy={y(s.values[hover]!)} r={4.5} fill={s.color} stroke="var(--chart-surface)" strokeWidth={2} />,
                  )}
                </g>
              )}
            </svg>
          )}
          {hover != null && dates[hover] && (
            <div
              className="pointer-events-none absolute top-0 z-10 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
              style={{ left: Math.min(Math.max(x(hover) + 12, 0), Math.max(0, width - 190)) }}
            >
              <div className="mb-1 font-medium text-zinc-900 dark:text-zinc-100">{label(dates[hover])}</div>
              {[...series]
                .sort((a, b) => (b.values[hover] ?? -1) - (a.values[hover] ?? -1))
                .map((s) => (
                  <div key={s.domain} className="flex items-center justify-between gap-4 text-zinc-600 dark:text-zinc-300">
                    <span className={cx("flex items-center gap-1.5", s.isSite && "font-semibold")}>
                      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                      {s.domain}
                    </span>
                    <span className="tabular-nums font-medium">{pct(s.values[hover])}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
