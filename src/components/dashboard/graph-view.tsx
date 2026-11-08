"use client";

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ENTITY_LABELS } from "@/lib/dashboard/format";
import { graphIssues, ISSUE_LABELS, issueCounts, type IssueKind } from "@/lib/dashboard/graph-insights";
import { useApi } from "./api";
import { useSite } from "./site-shell";
import type { GraphNode, GraphPayload } from "./types";
import { Badge, Button, Card, cx, EmptyState, ErrorState, inputBase, Skeleton } from "./ui";

/** Fixed type → categorical slot (color follows the entity type, never its rank). Concept folds to muted gray. */
const TYPE_SLOT: Record<string, string> = {
  Page: "--series-1",
  Product: "--series-2",
  Category: "--series-3",
  FAQ: "--series-4",
  Question: "--series-4",
  Organization: "--series-5",
  Author: "--series-6",
  Person: "--series-6",
  Brand: "--series-7",
  Article: "--series-8",
};
const TYPE_ORDER = ["Page", "Product", "Category", "FAQ", "Question", "Organization", "Author", "Person", "Brand", "Article", "Concept"];
const RELATION_LABELS: Record<string, string> = {
  links_to: "bağlantı verir",
  has_category: "kategorisi",
  contains_product: "ürün içerir",
  written_by: "yazarı",
  mentions_entity: "bahseder",
  answers_question: "soruyu yanıtlar",
  same_as: "aynı varlık",
  part_of: "parçası",
};

type SimNode = SimulationNodeDatum & { id: string; data: GraphNode; r: number; issues: IssueKind[] };
type SimLink = SimulationLinkDatum<SimNode> & { type: string };

function cssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function typeColor(type: string) {
  const slot = TYPE_SLOT[type];
  return slot ? cssVar(slot, "#2a78d6") : cssVar("--chart-muted", "#898781");
}

function props(n: GraphNode): Record<string, unknown> {
  return n.properties && typeof n.properties === "object" && !Array.isArray(n.properties) ? (n.properties as Record<string, unknown>) : {};
}

function NodeDetails({ node, payload, issues, onSelect }: { node: GraphNode; payload: GraphPayload; issues: IssueKind[]; onSelect: (id: string) => void }) {
  const byId = useMemo(() => new Map(payload.nodes.map((n) => [n.id, n])), [payload.nodes]);
  const out = payload.edges.filter((e) => e.source === node.id);
  const inc = payload.edges.filter((e) => e.target === node.id);
  const p = props(node);
  const shown = Object.entries(p).filter(([k, v]) => !["source_urls", "url"].includes(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || (Array.isArray(v) && v.every((x) => typeof x === "string"))));
  const rel = (list: typeof out, dir: "out" | "in") =>
    list.slice(0, 30).map((e) => {
      const other = byId.get(dir === "out" ? e.target : e.source);
      if (!other) return null;
      return (
        <li key={e.id} className="flex items-baseline gap-1.5 text-xs">
          <span className="shrink-0 text-zinc-400">{dir === "out" ? "→" : "←"} {RELATION_LABELS[e.type] ?? e.type}</span>
          <button type="button" className="truncate text-left text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => onSelect(other.id)}>
            {other.label}
          </button>
        </li>
      );
    });
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: typeColor(node.type) }} />
          <span className="text-xs text-zinc-500">{ENTITY_LABELS[node.type] ?? node.type}</span>
        </div>
        <div className="mt-1 font-semibold break-words text-zinc-900 dark:text-zinc-100">{node.label}</div>
        {node.url && (
          <a href={node.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 block truncate font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400">
            {node.url}
          </a>
        )}
      </div>
      {issues.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {issues.map((i) => (
            <Badge key={i} tone="critical" icon>
              {ISSUE_LABELS[i]}
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-4 text-xs text-zinc-500">
        <span>
          Gelen: <b className="tabular-nums text-zinc-800 dark:text-zinc-200">{inc.length}</b>
        </span>
        <span>
          Giden: <b className="tabular-nums text-zinc-800 dark:text-zinc-200">{out.length}</b>
        </span>
      </div>
      {shown.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {shown.slice(0, 12).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-zinc-500">{k}</dt>
              <dd className="truncate text-zinc-800 dark:text-zinc-200" title={String(v)}>
                {Array.isArray(v) ? v.join(", ") : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {(out.length > 0 || inc.length > 0) && (
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">İlişkiler</div>
          <ul className="max-h-48 space-y-1 overflow-auto">
            {rel(out, "out")}
            {rel(inc, "in")}
          </ul>
        </div>
      )}
    </div>
  );
}

export function GraphExplorer() {
  const { siteId, version } = useSite();
  const graph = useApi<GraphPayload>(`/api/sites/${siteId}/graph?limit=2000`, { version });
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [issueFilter, setIssueFilter] = useState<IssueKind | "any" | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const data = graph.data;
  const issues = useMemo(() => (data ? graphIssues(data.nodes, data.edges) : new Map<string, IssueKind[]>()), [data]);
  const counts = useMemo(() => issueCounts(issues), [issues]);
  const typesPresent = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of data?.nodes ?? []) c.set(n.type, (c.get(n.type) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => (TYPE_ORDER.indexOf(a[0]) + 1 || 99) - (TYPE_ORDER.indexOf(b[0]) + 1 || 99));
  }, [data]);

  const visibleNodes = useMemo(() => {
    if (!data) return [];
    return data.nodes.filter((n) => {
      if (hiddenTypes.has(n.type)) return false;
      if (issueFilter === "any") return issues.has(n.id);
      if (issueFilter) return issues.get(n.id)?.includes(issueFilter) ?? false;
      return true;
    });
  }, [data, hiddenTypes, issueFilter, issues]);

  const q = search.trim().toLocaleLowerCase("tr");
  const matches = useMemo(() => (q ? new Set(visibleNodes.filter((n) => n.label.toLocaleLowerCase("tr").includes(q) || n.url?.toLowerCase().includes(q)).map((n) => n.id)) : null), [q, visibleNodes]);
  const selectedNode = data?.nodes.find((n) => n.id === selected) ?? null;

  if (graph.loading)
    return (
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]" role="status" aria-label="Yükleniyor">
        <Skeleton className="h-[560px]" />
        <Skeleton className="h-[560px]" />
      </div>
    );
  if (graph.error) return <ErrorState error={graph.error} onRetry={() => void graph.reload()} />;
  if (!data?.nodes.length)
    return (
      <EmptyState icon="🕸" title="Bilgi grafı henüz oluşmadı">
        Graf; analiz sırasında site taranınca varlıklar (ürün, kategori, SSS, yazar, kurum…) ve aralarındaki ilişkilerden oluşturulur. Bir analiz başlatın.
      </EmptyState>
    );

  const problemNodes = data.nodes.filter((n) => issues.has(n.id));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Varlık" value={data.stats.totalEntities} hint={data.stats.truncated ? `${data.stats.returnedEntities} gösteriliyor` : undefined} />
        <Stat label="İlişki" value={data.stats.edges} />
        <Stat label="Yetim sayfa" value={counts.orphan_page} tone={counts.orphan_page ? "bad" : "ok"} />
        <Stat label="Bağlantısız düğüm" value={counts.isolated} tone={counts.isolated ? "bad" : "ok"} />
        <Stat label="Schema’sız sayfa" value={counts.page_without_schema} tone={counts.page_without_schema ? "bad" : "ok"} />
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <input type="search" placeholder="Düğüm ara…" value={search} onChange={(e) => setSearch(e.target.value)} className={`${inputBase} w-48 py-1.5 text-xs`} aria-label="Düğüm ara" />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Varlık türleri">
          {typesPresent.map(([type, count]) => {
            const on = !hiddenTypes.has(type);
            return (
              <button
                key={type}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setHiddenTypes((prev) => {
                    const next = new Set(prev);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    return next;
                  })
                }
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition",
                  on ? "border-zinc-300 bg-white text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200" : "border-dashed border-zinc-300 text-zinc-400 line-through dark:border-zinc-700",
                )}
              >
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: on ? typeColor(type) : "transparent", border: on ? undefined : "1px solid currentColor" }} />
                {ENTITY_LABELS[type] ?? type}
                <span className="tabular-nums text-zinc-400">{count}</span>
              </button>
            );
          })}
        </div>
        <select
          aria-label="Sorun filtresi"
          value={issueFilter ?? ""}
          onChange={(e) => setIssueFilter((e.target.value || null) as IssueKind | "any" | null)}
          className={`${inputBase} ml-auto w-auto py-1.5 text-xs`}
        >
          <option value="">Tüm düğümler</option>
          <option value="any">Sadece kopuk / eksik düğümler ({problemNodes.length})</option>
          {(Object.keys(ISSUE_LABELS) as IssueKind[]).map((k) => (
            <option key={k} value={k} disabled={!counts[k]}>
              {ISSUE_LABELS[k]} ({counts[k]})
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <GraphCanvas nodes={visibleNodes} payload={data} issues={issues} selected={selected} matches={matches} onSelect={setSelected} />
        <Card title={selectedNode ? "Düğüm detayı" : "Graf hakkında"}>
          {selectedNode ? (
            <>
              <NodeDetails node={selectedNode} payload={data} issues={issues.get(selectedNode.id) ?? []} onSelect={setSelected} />
              <Button size="sm" variant="ghost" className="mt-3" onClick={() => setSelected(null)}>
                Seçimi temizle
              </Button>
            </>
          ) : (
            <div className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
              <p>Graphify motorunun çıkardığı varlıklar ve ilişkiler. Düğüm boyutu bağlantı sayısını gösterir; kırmızı halka sorunlu düğümleri işaretler.</p>
              <ul className="list-disc space-y-1 pl-5 text-xs">
                <li>Sürükleyerek gezinin, tekerlekle yakınlaştırın.</li>
                <li>Düğüme tıklayın: detay ve komşuları görünür.</li>
                <li>Düğümleri sürükleyip yeniden konumlandırabilirsiniz.</li>
              </ul>
              {data.stats.truncated && (
                <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  Büyük graf: {data.stats.totalEntities} varlıktan ilk {data.stats.returnedEntities} tanesi gösteriliyor.
                </p>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card title="Kopuk ve eksik düğümler" subtitle="AI motorlarının siteyi bütünlüklü anlaması için bağlanması / zenginleştirilmesi gereken varlıklar">
        {problemNodes.length === 0 ? (
          <p className="text-sm text-zinc-500">Sorunlu düğüm bulunamadı. 🎉</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-white text-xs text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="py-2 pr-3 font-medium">Varlık</th>
                  <th className="py-2 pr-3 font-medium">Tür</th>
                  <th className="py-2 font-medium">Sorun</th>
                </tr>
              </thead>
              <tbody>
                {problemNodes.slice(0, 300).map((n) => (
                  <tr key={n.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="max-w-xs py-2 pr-3">
                      <button type="button" className="block max-w-full truncate text-left text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setSelected(n.id)} title={n.url ?? n.label}>
                        {n.label}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-xs text-zinc-500">{ENTITY_LABELS[n.type] ?? n.type}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {issues.get(n.id)!.map((i) => (
                          <Badge key={i} tone="critical">
                            {ISSUE_LABELS[i]}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "ok" | "bad" }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {tone === "bad" && <span className="text-xs text-red-600 dark:text-red-400">✕ düzeltilmeli</span>}
        {tone === "ok" && <span className="text-xs text-[#006300] dark:text-[#0ca30c]">✓</span>}
      </div>
      {hint && <div className="text-xs text-zinc-400">{hint}</div>}
    </div>
  );
}

type View = { x: number; y: number; k: number };

function GraphCanvas({
  nodes,
  payload,
  issues,
  selected,
  matches,
  onSelect,
}: {
  nodes: GraphNode[];
  payload: GraphPayload;
  issues: Map<string, IssueKind[]>;
  selected: string | null;
  matches: Set<string> | null;
  onSelect: (id: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 800, h: 560 });
  const frame = useRef(0);
  const hoverRef = useRef<SimNode | null>(null);
  /** Set once the user pans/zooms, so auto-fit never fights them. */
  const userMoved = useRef(false);
  const stateRef = useRef({ selected, matches });
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: SimNode } | null>(null);

  const draw = useCallback(() => {
    // Coalesce: one pending frame at a time (never cancel — d3's own rAF ticks would starve it).
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const { w, h } = size.current;
      const { x, y, k } = view.current;
      const { selected: sel, matches: m } = stateRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = cssVar("--chart-surface", "#fcfcfb");
      ctx.fillRect(0, 0, w, h);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);

      const neighbours = new Set<string>();
      if (sel) {
        neighbours.add(sel);
        for (const l of linksRef.current) {
          const s = (l.source as SimNode).id;
          const t = (l.target as SimNode).id;
          if (s === sel) neighbours.add(t);
          if (t === sel) neighbours.add(s);
        }
      }
      const focus = sel ? neighbours : m;
      const edge = cssVar("--chart-axis", "#c3c2b7");
      const ink = cssVar("--chart-ink", "#0b0b0b");
      const surface = cssVar("--chart-surface", "#fcfcfb");
      const critical = "#d03b3b";

      ctx.lineWidth = 1 / k;
      for (const l of linksRef.current) {
        const s = l.source as SimNode;
        const t = l.target as SimNode;
        const on = !focus || (focus.has(s.id) && focus.has(t.id));
        ctx.globalAlpha = on ? (sel ? 0.9 : 0.55) : 0.08;
        ctx.strokeStyle = sel && on ? ink : edge;
        ctx.beginPath();
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
        ctx.stroke();
      }
      const colors = new Map<string, string>();
      for (const n of nodesRef.current) {
        const on = !focus || focus.has(n.id);
        ctx.globalAlpha = on ? 1 : 0.15;
        let color = colors.get(n.data.type);
        if (!color) colors.set(n.data.type, (color = typeColor(n.data.type)));
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = n.issues.length ? critical : surface;
        if (n.issues.length) ctx.lineWidth = 2.5 / k;
        ctx.stroke();
        if (n.id === sel || n === hoverRef.current) {
          ctx.beginPath();
          ctx.arc(n.x!, n.y!, n.r + 4 / k, 0, Math.PI * 2);
          ctx.strokeStyle = ink;
          ctx.lineWidth = 2 / k;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.font = `${11 / k}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodesRef.current) {
        const show = n.id === sel || (sel && neighbours.has(n.id)) || (m?.has(n.id) ?? false) || n === hoverRef.current || (n.r * k >= 12 && n.data.type !== "Concept");
        if (!show) continue;
        if (focus && !focus.has(n.id)) continue;
        const label = n.data.label.length > 32 ? `${n.data.label.slice(0, 30)}…` : n.data.label;
        ctx.lineWidth = 3 / k;
        ctx.strokeStyle = surface;
        ctx.strokeText(label, n.x!, n.y! + n.r + 3 / k);
        ctx.fillStyle = ink;
        ctx.fillText(label, n.x!, n.y! + n.r + 3 / k);
      }
    });
  }, []);

  const fit = useCallback(() => {
    const ns = nodesRef.current;
    if (!ns.length) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x! - n.r);
      minY = Math.min(minY, n.y! - n.r);
      maxX = Math.max(maxX, n.x! + n.r);
      maxY = Math.max(maxY, n.y! + n.r);
    }
    const { w, h } = size.current;
    const k = Math.min(2.5, Math.max(0.05, 0.9 * Math.min(w / Math.max(1, maxX - minX), h / Math.max(1, maxY - minY))));
    view.current = { k, x: w / 2 - k * ((minX + maxX) / 2), y: h / 2 - k * ((minY + maxY) / 2) };
    draw();
  }, [draw]);

  useEffect(() => {
    stateRef.current = { selected, matches };
    draw();
  }, [selected, matches, draw]);

  // (Re)build the simulation whenever the visible node set changes; keep known positions.
  useEffect(() => {
    simRef.current?.stop();
    const ids = new Set(nodes.map((n) => n.id));
    const deg = new Map<string, number>();
    const links: SimLink[] = [];
    for (const e of payload.edges) {
      if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
      links.push({ source: e.source, target: e.target, type: e.type });
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    const simNodes: SimNode[] = nodes.map((n) => {
      const p = positions.current.get(n.id);
      return { id: n.id, data: n, r: Math.min(16, 3.5 + Math.sqrt(deg.get(n.id) ?? 0) * 1.6), issues: issues.get(n.id) ?? [], x: p?.x, y: p?.y };
    });
    nodesRef.current = simNodes;
    linksRef.current = links;
    const many = simNodes.length > 600;
    const sim = forceSimulation<SimNode>(simNodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id).distance((l) => (l.type === "mentions_entity" ? 40 : 60)).strength(0.4))
      .force("charge", forceManyBody<SimNode>().strength(many ? -40 : -120).distanceMax(500))
      .force("center", forceCenter(0, 0))
      .force("x", forceX<SimNode>(0).strength(0.04))
      .force("y", forceY<SimNode>(0).strength(0.04))
      .force("collide", forceCollide<SimNode>((d) => d.r + 2))
      .alphaDecay(many ? 0.05 : 0.03);
    userMoved.current = false;
    let ticks = 0;
    sim.on("tick", () => {
      for (const n of simNodes) positions.current.set(n.id, { x: n.x!, y: n.y! });
      // Keep the layout framed while it settles, until the user takes over.
      if (!userMoved.current && ticks++ % 10 === 0) fit();
      else draw();
    });
    sim.on("end", () => {
      if (!userMoved.current) fit();
    });
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [nodes, payload.edges, issues, draw, fit]);

  // Canvas sizing (HiDPI) + theme changes.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.floor(e.contentRect.width);
      const h = Math.floor(e.contentRect.height);
      const dpr = window.devicePixelRatio || 1;
      size.current = { w, h };
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      if (!userMoved.current) fit();
      else draw();
    });
    ro.observe(wrap);
    const mo = new MutationObserver(draw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [draw, fit]);

  // Pointer interaction: pan, drag nodes, hover, click-select, wheel zoom.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const toWorld = (ev: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      const { x, y, k } = view.current;
      return { sx: ev.clientX - rect.left, sy: ev.clientY - rect.top, wx: (ev.clientX - rect.left - x) / k, wy: (ev.clientY - rect.top - y) / k };
    };
    const hit = (wx: number, wy: number) => {
      let best: SimNode | null = null;
      let bestD = Infinity;
      const slack = 4 / view.current.k;
      for (const n of nodesRef.current) {
        const d = Math.hypot(n.x! - wx, n.y! - wy);
        if (d <= n.r + slack && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };
    let mode: null | { kind: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean } | { kind: "node"; node: SimNode; moved: boolean } = null;

    const down = (ev: PointerEvent) => {
      canvas.setPointerCapture(ev.pointerId);
      const p = toWorld(ev);
      const n = hit(p.wx, p.wy);
      if (n) {
        mode = { kind: "node", node: n, moved: false };
        n.fx = n.x;
        n.fy = n.y;
      } else {
        mode = { kind: "pan", sx: p.sx, sy: p.sy, vx: view.current.x, vy: view.current.y, moved: false };
      }
    };
    const move = (ev: PointerEvent) => {
      const p = toWorld(ev);
      if (mode?.kind === "pan") {
        const dx = p.sx - mode.sx;
        const dy = p.sy - mode.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) mode.moved = true;
        if (mode.moved) userMoved.current = true;
        view.current = { ...view.current, x: mode.vx + dx, y: mode.vy + dy };
        draw();
        return;
      }
      if (mode?.kind === "node") {
        mode.moved = true;
        userMoved.current = true;
        mode.node.fx = p.wx;
        mode.node.fy = p.wy;
        simRef.current?.alphaTarget(0.2).restart();
        return;
      }
      const n = hit(p.wx, p.wy);
      if (n !== hoverRef.current) {
        hoverRef.current = n;
        canvas.style.cursor = n ? "pointer" : "grab";
        draw();
      }
      setTooltip(n ? { x: Math.max(0, Math.min(p.sx + 14, size.current.w - 260)), y: p.sy + 14, node: n } : null);
    };
    const up = () => {
      if (mode?.kind === "node") {
        const n = mode.node;
        if (!mode.moved) onSelect(n.id);
        n.fx = null;
        n.fy = null;
        simRef.current?.alphaTarget(0);
      } else if (mode?.kind === "pan" && !mode.moved) {
        onSelect(null);
      }
      mode = null;
    };
    const leave = () => {
      hoverRef.current = null;
      setTooltip(null);
      draw();
    };
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      userMoved.current = true;
      const p = toWorld(ev);
      const k = Math.min(8, Math.max(0.05, view.current.k * Math.exp(-ev.deltaY * 0.0015)));
      view.current = { k, x: p.sx - p.wx * k, y: p.sy - p.wy * k };
      draw();
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [draw, onSelect]);

  const zoom = (factor: number) => {
    userMoved.current = true;
    const { w, h } = size.current;
    const v = view.current;
    const k = Math.min(8, Math.max(0.05, v.k * factor));
    const cx = (w / 2 - v.x) / v.k;
    const cy = (h / 2 - v.y) / v.k;
    view.current = { k, x: w / 2 - cx * k, y: h / 2 - cy * k };
    draw();
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
      <div ref={wrapRef} className="h-[560px] w-full touch-none">
        <canvas ref={canvasRef} className="block cursor-grab" role="img" aria-label={`Bilgi grafı: ${nodes.length} düğüm. Erişilebilir liste aşağıdaki tabloda.`} />
      </div>
      {nodes.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">Filtreye uyan düğüm yok.</div>}
      <div className="absolute right-3 top-3 flex flex-col gap-1">
        <Button size="sm" aria-label="Yakınlaştır" onClick={() => zoom(1.3)}>
          +
        </Button>
        <Button size="sm" aria-label="Uzaklaştır" onClick={() => zoom(1 / 1.3)}>
          −
        </Button>
        <Button
          size="sm"
          aria-label="Sığdır"
          onClick={() => {
            userMoved.current = false;
            fit();
          }}
        >
          ⤢
        </Button>
      </div>
      <div className="absolute bottom-3 left-3 rounded-md bg-white/85 px-2 py-1 text-[11px] text-zinc-500 backdrop-blur dark:bg-zinc-900/85">
        {nodes.length} düğüm · <span className="text-[#d03b3b]">◯</span> sorunlu
      </div>
      {tooltip && (
        <div
          className="pointer-events-none absolute z-10 max-w-64 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-medium text-zinc-900 dark:text-zinc-100">{tooltip.node.data.label}</div>
          <div className="text-zinc-500">
            {ENTITY_LABELS[tooltip.node.data.type] ?? tooltip.node.data.type} · {tooltip.node.data.inDegree} gelen / {tooltip.node.data.outDegree} giden
          </div>
          {tooltip.node.issues.map((i) => (
            <div key={i} className="mt-0.5 text-red-600 dark:text-red-400">
              ✕ {ISSUE_LABELS[i]}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
