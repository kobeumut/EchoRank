"""CLI: geo-crawler https://example.com -o graph.json [--depth 3 --max-pages 200 ...]"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from .crawler import CrawlConfig
from .pipeline import index_site
from .reconcile_cli import add_arguments, reconcile, write_jsonld


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="geo-crawler", description="Crawl a site and build a knowledge graph JSON")
    ap.add_argument("url")
    ap.add_argument("-o", "--output", default="graph.json", help="graph JSON output path ('-' for stdout)")
    ap.add_argument("--pages-output", help="optional path to dump parsed page data (JSON)")
    ap.add_argument("--db-records", help="optional path for Prisma-shaped rows (CrawledPage/GraphEntity/GraphRelation)")
    ap.add_argument("--graphml", help="optional GraphML export path")
    ap.add_argument("--depth", type=int, default=3)
    ap.add_argument("--max-pages", type=int, default=200)
    ap.add_argument("--concurrency", type=int, default=5)
    ap.add_argument("--rps", type=float, default=5.0, help="max requests per second (0 = unlimited)")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--ignore-robots", action="store_true")
    ap.add_argument("--no-sitemap", action="store_true")
    ap.add_argument("--keywords", type=int, default=6, help="concept keywords per page")
    ap.add_argument("--reconcile", action="store_true", help="match entities to Wikidata QIDs (network calls)")
    ap.add_argument("--jsonld", help="optional Schema.org @graph JSON-LD output path")
    add_arguments(ap)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(message)s")
    cfg = CrawlConfig(max_depth=args.depth, max_pages=args.max_pages, concurrency=args.concurrency,
                      requests_per_second=args.rps, timeout=args.timeout,
                      respect_robots=not args.ignore_robots, use_sitemap=not args.no_sitemap)

    def progress(page, done, total):
        if args.verbose:
            print(f"[{done}/{total}] {page.status_code} {page.page_type.value:<8} {page.url}", file=sys.stderr)

    result = asyncio.run(index_site(args.url, cfg, args.keywords, on_page=progress))
    reconciliation = asyncio.run(reconcile(result.graph, lang=args.wikidata_lang, max_concepts=args.max_concepts)) if args.reconcile else None
    data = result.export_graph_json(None if args.output == "-" else args.output)
    if args.output == "-":
        print(data)
    if args.pages_output:
        with open(args.pages_output, "w", encoding="utf-8") as fh:
            json.dump([p.to_dict() for p in result.crawl.pages.values()], fh, ensure_ascii=False, indent=2, default=str)
    if args.db_records:
        with open(args.db_records, "w", encoding="utf-8") as fh:
            json.dump(result.to_db_records(), fh, ensure_ascii=False, indent=2, default=str)
    if args.graphml:
        result.graph.to_graphml(args.graphml)
    summary = {"crawl": result.crawl_summary(), "graph": result.graph.stats(), "gaps": result.gaps["summary"]}
    if reconciliation:
        summary["reconciliation"] = reconciliation["by_status"]
    if args.jsonld:
        summary["jsonld_errors"] = write_jsonld(result.graph, args.jsonld)
    print(json.dumps(summary, ensure_ascii=False, indent=2), file=sys.stderr)
    return 0 if result.crawl.ok_pages else 1


if __name__ == "__main__":
    raise SystemExit(main())
