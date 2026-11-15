"""Graphify-style knowledge graph built on NetworkX.

Export format (``export_graph_json``) — stable contract for the API / DB layer
(maps 1:1 to ``GraphEntity`` / ``GraphRelation`` tables):

    {
      "schema_version": "1.0",
      "site": "https://example.com/",
      "generated_at": "...",
      "stats": {...},
      "nodes": [{"id", "type", "label", "properties": {...}, "source_urls": [...]}],
      "edges": [{"source", "target", "type", "properties": {...}}],
      "gaps":  {...}   # optional, see gaps.py
    }
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import networkx as nx

from .models import EntityType, ExtractionResult, RelationType

SCHEMA_VERSION = "1.0"


class KnowledgeGraph:
    def __init__(self, site: str = ""):
        self.site = site
        self.g = nx.MultiDiGraph()

    # ---------- construction ----------
    @classmethod
    def from_extraction(cls, extraction: ExtractionResult, site: str = "") -> "KnowledgeGraph":
        kg = cls(site)
        for e in extraction.entities:
            kg.add_node(e.id, e.type.value, e.name, e.properties, e.source_urls)
        for r in extraction.relations:
            kg.add_edge(r.source, r.target, r.type.value, r.properties)
        return kg

    def add_node(self, node_id: str, node_type: str, label: str, properties: dict[str, Any] | None = None,
                 source_urls: list[str] | None = None) -> None:
        if self.g.has_node(node_id):
            data = self.g.nodes[node_id]
            for k, v in (properties or {}).items():
                data["properties"].setdefault(k, v)
            for u in source_urls or []:
                if u not in data["source_urls"]:
                    data["source_urls"].append(u)
            return
        self.g.add_node(node_id, type=node_type, label=label, properties=dict(properties or {}),
                        source_urls=list(source_urls or []))

    def add_edge(self, source: str, target: str, edge_type: str, properties: dict[str, Any] | None = None) -> None:
        for n in (source, target):
            if not self.g.has_node(n):
                # dangling reference -> placeholder node typed by id prefix
                self.add_node(n, n.split(":", 1)[0].capitalize(), n.split(":", 1)[-1], {"placeholder": True})
        if self.g.has_edge(source, target, key=edge_type):
            return
        self.g.add_edge(source, target, key=edge_type, type=edge_type, properties=dict(properties or {}))

    # ---------- queries ----------
    def nodes_of_type(self, node_type: EntityType | str) -> list[str]:
        t = node_type.value if isinstance(node_type, EntityType) else node_type
        return [n for n, d in self.g.nodes(data=True) if d.get("type") == t]

    def edges_of_type(self, edge_type: RelationType | str) -> list[tuple[str, str]]:
        t = edge_type.value if isinstance(edge_type, RelationType) else edge_type
        return [(u, v) for u, v, k in self.g.edges(keys=True) if k == t]

    def neighbors(self, node_id: str, edge_type: RelationType | str | None = None, direction: str = "out") -> list[str]:
        t = edge_type.value if isinstance(edge_type, RelationType) else edge_type
        edges = self.g.out_edges(node_id, keys=True) if direction == "out" else self.g.in_edges(node_id, keys=True)
        return [(v if direction == "out" else u) for u, v, k in edges if t is None or k == t]

    def page_link_graph(self) -> nx.DiGraph:
        sub = nx.DiGraph()
        sub.add_nodes_from(self.nodes_of_type(EntityType.PAGE))
        sub.add_edges_from(self.edges_of_type(RelationType.LINKS_TO))
        return sub

    def pagerank(self) -> dict[str, float]:
        sub = self.page_link_graph()
        if sub.number_of_nodes() == 0:
            return {}
        try:
            return nx.pagerank(sub)
        except Exception:  # scipy missing / non-convergence -> degree fallback
            n = sub.number_of_nodes()
            return {k: (sub.in_degree(k) + 1) / (sub.number_of_edges() + n) for k in sub.nodes}

    def stats(self) -> dict[str, Any]:
        return {
            "node_count": self.g.number_of_nodes(),
            "edge_count": self.g.number_of_edges(),
            "nodes_by_type": dict(Counter(d.get("type") for _, d in self.g.nodes(data=True))),
            "edges_by_type": dict(Counter(k for _, _, k in self.g.edges(keys=True))),
        }

    # ---------- export / import ----------
    def to_dict(self, gaps: dict[str, Any] | None = None, include_pagerank: bool = True) -> dict[str, Any]:
        pr = self.pagerank() if include_pagerank else {}
        nodes = []
        for n, d in self.g.nodes(data=True):
            props = dict(d.get("properties", {}))
            if n in pr:
                props["pagerank"] = round(pr[n], 6)
            nodes.append({"id": n, "type": d.get("type"), "label": d.get("label"), "properties": props,
                          "source_urls": d.get("source_urls", [])})
        edges = [{"source": u, "target": v, "type": k, "properties": d.get("properties", {})}
                 for u, v, k, d in self.g.edges(keys=True, data=True)]
        out: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "site": self.site,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "stats": self.stats(),
            "nodes": nodes,
            "edges": edges,
        }
        if gaps is not None:
            out["gaps"] = gaps
        return out

    def export_graph_json(self, path: str | Path | None = None, gaps: dict[str, Any] | None = None, indent: int = 2) -> str:
        data = json.dumps(self.to_dict(gaps), ensure_ascii=False, indent=indent, default=str)
        if path is not None:
            Path(path).write_text(data, encoding="utf-8")
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "KnowledgeGraph":
        kg = cls(data.get("site", ""))
        for n in data.get("nodes", []):
            props = {k: v for k, v in (n.get("properties") or {}).items() if k != "pagerank"}
            kg.add_node(n["id"], n.get("type", ""), n.get("label", ""), props, n.get("source_urls"))
        for e in data.get("edges", []):
            kg.add_edge(e["source"], e["target"], e["type"], e.get("properties"))
        return kg

    @classmethod
    def load_json(cls, path: str | Path) -> "KnowledgeGraph":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    def to_node_link(self) -> dict[str, Any]:
        """Raw NetworkX node-link format (for tools that consume it directly)."""
        try:
            return nx.node_link_data(self.g, edges="links")
        except TypeError:
            return nx.node_link_data(self.g, link="links")

    def to_graphml(self, path: str | Path) -> None:
        g = nx.MultiDiGraph()
        for n, d in self.g.nodes(data=True):
            g.add_node(n, type=d.get("type") or "", label=d.get("label") or "",
                       properties=json.dumps(d.get("properties", {}), ensure_ascii=False, default=str))
        for u, v, k, d in self.g.edges(keys=True, data=True):
            g.add_edge(u, v, key=k, type=k, properties=json.dumps(d.get("properties", {}), ensure_ascii=False, default=str))
        nx.write_graphml(g, str(path))
