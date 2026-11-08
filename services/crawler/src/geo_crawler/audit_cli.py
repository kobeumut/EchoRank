"""CLI: geo-audit https://example.com -o audit.json [--db-records rows.json] [--text]

Crawls the site, builds the knowledge graph, collects site signals and prints the GEO / SEO / E-E-A-T
scores with prioritized "Ne Yapılmalı?" action cards.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from .crawler import CrawlConfig
from .reconcile_cli import add_arguments, reconcile, write_jsonld
from .scoring import audit_site
from .scoring.engine import AuditReport, grade


def render_text(report: AuditReport, max_actions: int = 20, show_code: bool = False) -> str:
    out = [f"GEO SKORU: {report.geo_score}/100 ({grade(report.geo_score)})  ·  SEO {report.seo_score}  ·  "
           f"E-E-A-T {report.eeat_score}", report.summary, ""]
    for p in report.pillars.values():
        out.append(f"■ {p.label}: {p.score}/100 (ağırlık %{round(p.weight * 100)})")
        for c in p.checks:
            if c.applicable:
                out.append(f"   {'✓' if c.passed else '✗'} {round(c.score):>3}  {c.label} — {c.detail}")
        out.append("")
    out.append("NE YAPILMALI?")
    for i, a in enumerate(report.actions[:max_actions], 1):
        out.append(f"{i:>2}. [{a.impact.upper()} etki / {a.effort} efor / +{a.expected_gain} puan] {a.title}")
        out.append(f"    {a.description}")
        if a.target_url:
            out.append(f"    Hedef: {a.target_url}" + (f" (+{len(a.affected_urls) - 1} sayfa)" if len(a.affected_urls) > 1 else ""))
        if show_code and a.snippet:
            out.append("    ```" + a.snippet.language)
            out.extend("    " + ln for ln in a.snippet.code.splitlines())
            out.append("    ```")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="geo-audit", description="GEO / SEO / E-E-A-T audit with action recommendations")
    ap.add_argument("url")
    ap.add_argument("-o", "--output", default="-", help="full audit JSON path ('-' = stdout)")
    ap.add_argument("--db-records", help="write GeoAudit + ActionItem rows (API ingest payload) to this path")
    ap.add_argument("--crawl-records", help="also write crawl/graph rows (CrawledPage/GraphEntity/GraphRelation)")
    ap.add_argument("--text", action="store_true", help="print a human-readable report to stderr")
    ap.add_argument("--code", action="store_true", help="include fix snippets in the text report")
    ap.add_argument("--depth", type=int, default=3)
    ap.add_argument("--max-pages", type=int, default=100)
    ap.add_argument("--concurrency", type=int, default=5)
    ap.add_argument("--rps", type=float, default=5.0)
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--no-ua-probe", action="store_true", help="skip AI user-agent WAF probes")
    ap.add_argument("--reconcile", action="store_true",
                    help="match graph entities to Wikidata before writing --crawl-records (network calls)")
    ap.add_argument("--jsonld", help="write the site's Schema.org @graph JSON-LD to this path")
    add_arguments(ap)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(message)s")
    cfg = CrawlConfig(max_depth=args.depth, max_pages=args.max_pages, concurrency=args.concurrency,
                      requests_per_second=args.rps, timeout=args.timeout)
    index, report = asyncio.run(audit_site(args.url, cfg, probe_user_agents=not args.no_ua_probe))
    if args.reconcile:  # after scoring, so the audit stays a pure function of the crawl
        asyncio.run(reconcile(index.graph, lang=args.lang, max_concepts=args.max_concepts))
    if args.jsonld:
        for err in write_jsonld(index.graph, args.jsonld):
            print(f"JSON-LD: {err}", file=sys.stderr)

    data = json.dumps(report.to_dict(), ensure_ascii=False, indent=2, default=str)
    if args.output == "-":
        print(data)
    else:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(data)
    if args.db_records:
        with open(args.db_records, "w", encoding="utf-8") as fh:
            json.dump(report.to_db_records(), fh, ensure_ascii=False, indent=2, default=str)
    if args.crawl_records:
        with open(args.crawl_records, "w", encoding="utf-8") as fh:
            json.dump(index.to_db_records(), fh, ensure_ascii=False, indent=2, default=str)
    if args.text:
        print(render_text(report, show_code=args.code), file=sys.stderr)
    return 0 if index.crawl.ok_pages else 1


if __name__ == "__main__":
    raise SystemExit(main())
