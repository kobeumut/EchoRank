// Structural problems in the knowledge graph ("kopuk / eksik düğümler"), computed from the API graph payload.

export type GraphNodeLike = { id: string; type: string; label: string; url?: string | null; properties?: unknown };
export type GraphEdgeLike = { source: string; target: string; type: string };

export const ISSUE_LABELS = {
  isolated: "Bağlantısız düğüm",
  orphan_page: "Yetim sayfa (iç link almıyor)",
  page_without_schema: "Yapısal veri (schema) yok",
  product_without_category: "Kategorisiz ürün",
  thin_page: "İnce içerik (<150 kelime)",
} as const;
export type IssueKind = keyof typeof ISSUE_LABELS;

function props(n: GraphNodeLike): Record<string, unknown> {
  return n.properties && typeof n.properties === "object" && !Array.isArray(n.properties)
    ? (n.properties as Record<string, unknown>)
    : {};
}

function isHome(n: GraphNodeLike) {
  const p = props(n);
  if (p.page_type === "home") return true;
  if (!n.url) return false;
  try {
    return new URL(n.url).pathname === "/";
  } catch {
    return false;
  }
}

export function graphIssues(nodes: GraphNodeLike[], edges: GraphEdgeLike[]): Map<string, IssueKind[]> {
  const degree = new Map<string, number>();
  const pageInLinks = new Map<string, number>();
  const categorized = new Set<string>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    if (e.type === "links_to" && e.source !== e.target) pageInLinks.set(e.target, (pageInLinks.get(e.target) ?? 0) + 1);
    if (e.type === "has_category") categorized.add(e.source);
    if (e.type === "contains_product") categorized.add(e.target);
  }
  const out = new Map<string, IssueKind[]>();
  const add = (id: string, k: IssueKind) => out.set(id, [...(out.get(id) ?? []), k]);
  for (const n of nodes) {
    const p = props(n);
    if (!degree.get(n.id)) add(n.id, "isolated");
    if (n.type === "Page") {
      if (!isHome(n) && !pageInLinks.get(n.id) && degree.get(n.id)) add(n.id, "orphan_page");
      if (p.has_schema === false) add(n.id, "page_without_schema");
      if (typeof p.word_count === "number" && p.word_count < 150 && !isHome(n)) add(n.id, "thin_page");
    }
    if (n.type === "Product" && !categorized.has(n.id)) add(n.id, "product_without_category");
  }
  return out;
}

export function issueCounts(issues: Map<string, IssueKind[]>): Record<IssueKind, number> {
  const counts = Object.fromEntries(Object.keys(ISSUE_LABELS).map((k) => [k, 0])) as Record<IssueKind, number>;
  for (const list of issues.values()) for (const k of list) counts[k]++;
  return counts;
}
