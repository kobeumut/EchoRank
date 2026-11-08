"""End-to-end: crawl -> extract -> graph -> gaps."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .crawler import CrawlConfig, SiteCrawler
from .extractor import extract_entities
from .gaps import detect_gaps
from .graph import KnowledgeGraph
from .models import CrawlResult, ExtractionResult


@dataclass
class IndexResult:
    crawl: CrawlResult
    extraction: ExtractionResult
    graph: KnowledgeGraph
    gaps: dict[str, Any]

    def export_graph_json(self, path=None, indent: int = 2) -> str:
        return self.graph.export_graph_json(path, gaps=self.gaps, indent=indent)

    def crawl_summary(self) -> dict[str, Any]:
        """Shape aligned with the CrawlSession model."""
        return {
            "start_url": self.crawl.start_url,
            "started_at": self.crawl.started_at,
            "finished_at": self.crawl.finished_at,
            "pages_crawled": len(self.crawl.ok_pages),
            "pages_failed": len(self.crawl.errors),
            "sitemap_urls": len(self.crawl.sitemap_urls),
            "page_types": _count(p.page_type.value for p in self.crawl.ok_pages),
        }


    def to_db_records(self) -> dict[str, Any]:
        """Rows shaped for the platform's Prisma models (CrawlSession / CrawledPage / GraphEntity / GraphRelation).

        Entities are keyed by ``key`` (unique per site) and relations reference entities by key,
        so the API layer can upsert idempotently and resolve cuid ids itself.
        """
        pr = self.graph.pagerank()
        pages = []
        for p in self.crawl.pages.values():
            data = p.to_dict()
            for k in ("url", "status_code", "page_type", "title", "canonical", "word_count", "depth", "text"):
                data.pop(k, None)
            data["text_excerpt"] = p.text[:1000]
            pages.append({
                "url": p.url, "statusCode": p.status_code or None, "pageType": p.page_type.value,
                "title": p.title or None,
                "metaDescription": p.meta.get("description") or p.open_graph.get("description") or None,
                "canonical": p.canonical or None, "h1": (p.headings.get("h1") or [None])[0],
                "wordCount": p.word_count, "depth": p.depth, "data": data,
            })
        entities = []
        for n, d in self.graph.g.nodes(data=True):
            props = dict(d.get("properties", {}))
            if n in pr:
                props["pagerank"] = round(pr[n], 6)
            url = props.get("url") or (d.get("source_urls") or [None])[0]
            props["source_urls"] = d.get("source_urls", [])
            entities.append({"key": n, "entityType": d.get("type"), "name": (d.get("label") or n)[:500],
                             "url": url, "properties": props})
        relations = []
        for u, v, k, d in self.graph.g.edges(keys=True, data=True):
            props = dict(d.get("properties", {}))
            weight = float(props.pop("weight", 1) or 1)
            relations.append({"sourceKey": u, "targetKey": v, "relationType": k, "weight": weight,
                              "properties": props or None})
        s = self.crawl_summary()
        return {
            "crawlSession": {"status": "completed" if self.crawl.ok_pages else "failed",
                             "pagesCrawled": s["pages_crawled"], "pagesFailed": s["pages_failed"],
                             "startedAt": s["started_at"], "finishedAt": s["finished_at"]},
            "crawledPages": pages, "graphEntities": entities, "graphRelations": relations, "gaps": self.gaps,
        }


def _count(items) -> dict[str, int]:
    out: dict[str, int] = {}
    for i in items:
        out[i] = out.get(i, 0) + 1
    return out


def build_index(crawl: CrawlResult, keywords_per_page: int = 6) -> IndexResult:
    extraction = extract_entities(list(crawl.pages.values()), keywords_per_page)
    kg = KnowledgeGraph.from_extraction(extraction, site=crawl.start_url)
    gaps = detect_gaps(kg, crawl)
    return IndexResult(crawl, extraction, kg, gaps)


async def index_site(url: str, config: CrawlConfig | None = None, keywords_per_page: int = 6, **crawler_kwargs) -> IndexResult:
    crawl = await SiteCrawler(url, config, **crawler_kwargs).crawl()
    return build_index(crawl, keywords_per_page)
