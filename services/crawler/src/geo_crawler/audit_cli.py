"""CLI: geo-audit https://example.com -o audit.json [--db-records rows.json] [--text] [--lang en|tr]

Crawls the site, builds the knowledge graph, collects site signals and prints the GEO / SEO / E-E-A-T
scores with prioritized "What should be done?" action cards. ``--lang`` selects the language of every
human-readable text (check details, action cards, summary, text report); JSON field names and ids never change.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from .crawler import CrawlConfig
from .i18n import DEFAULT_LANG, get_translator, normalize_lang
from .reconcile_cli import add_arguments, reconcile, write_jsonld
from .scoring import audit_site
from .scoring.engine import AuditReport, grade


def render_text(report: AuditReport, max_actions: int = 20, show_code: bool = False, *,
                lang: str | None = None) -> str:
    """Human-readable report; ``lang`` defaults to the language the report itself was generated in."""
    t = get_translator(lang or report.lang)
    out = [t("misc.report.title", geo=report.geo_score, grade=grade(report.geo_score), seo=report.seo_score,
             eeat=report.eeat_score), report.summary, ""]
    for p in report.pillars.values():
        out.append(t("misc.report.pillar", label=p.label, score=p.score, weight=round(p.weight * 100)))
        for c in p.checks:
            if c.applicable:
                out.append(f"   {'✓' if c.passed else '✗'} {round(c.score):>3}  {c.label} — {c.detail}")
        out.append("")
    out.append(t("misc.report.actions_heading"))
    for i, a in enumerate(report.actions[:max_actions], 1):
        out.append(t("misc.report.action_line", index=f"{i:>2}", impact=a.impact.upper(), effort=a.effort,
                     gain=a.expected_gain, title=a.title))
        out.append(f"    {a.description}")
        if a.target_url:
            more = len(a.affected_urls) - 1
            out.append(t("misc.report.target", url=a.target_url)
                       + (t("misc.report.more_pages", count=more) if more > 0 else ""))
        if show_code and a.snippet:
            out.append("    ```" + a.snippet.language)
            out.extend("    " + ln for ln in a.snippet.code.splitlines())
            out.append("    ```")
    return "\n".join(out)


def emit_progress(**event) -> None:
    """One machine-readable line per event on stderr; stdout stays free for `-o -`."""
    print("GEO_PROGRESS " + json.dumps(event), file=sys.stderr, flush=True)


def progress_hooks(max_pages: int) -> dict:
    """`audit_site` kwargs that report the stage and, while crawling, pages done / estimated total (<= max_pages)."""
    return {
        "on_stage": lambda stage: emit_progress(stage=stage, **({"done": 0, "total": max_pages} if stage == "crawl" else {})),
        "on_page": lambda _page, done, total: emit_progress(stage="crawl", done=done, total=total),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="geo-audit", description="GEO / SEO / E-E-A-T audit with action recommendations")
    ap.add_argument("url")
    ap.add_argument("-o", "--output", default="-", help="full audit JSON path ('-' = stdout)")
    ap.add_argument("--db-records", help="write GeoAudit + ActionItem rows (API ingest payload) to this path")
    ap.add_argument("--crawl-records", help="also write crawl/graph rows (CrawledPage/GraphEntity/GraphRelation)")
    ap.add_argument("--lang", default=DEFAULT_LANG, type=normalize_lang, metavar="{en,tr}",
                    help="language of the generated text: check details, action cards, summary (default: en)")
    ap.add_argument("--text", action="store_true", help="print a human-readable report to stderr")
    ap.add_argument("--code", action="store_true", help="include fix snippets in the text report")
    ap.add_argument("--depth", type=int, default=3)
    ap.add_argument("--max-pages", type=int, default=100)
    ap.add_argument("--concurrency", type=int, default=5)
    ap.add_argument("--rps", type=float, default=5.0)
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--no-ua-probe", action="store_true", help="skip AI user-agent WAF probes")
    ap.add_argument("--progress", action="store_true",
                    help="print 'GEO_PROGRESS {json}' lines to stderr (stage, pages crawled / estimated total)")
    ap.add_argument("--reconcile", action="store_true",
                    help="match graph entities to Wikidata before writing --crawl-records (network calls)")
    ap.add_argument("--jsonld", help="write the site's Schema.org @graph JSON-LD to this path")
    add_arguments(ap, lang_flag="--wikidata-lang")  # --lang is the report language here
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(message)s")
    cfg = CrawlConfig(max_depth=args.depth, max_pages=args.max_pages, concurrency=args.concurrency,
                      requests_per_second=args.rps, timeout=args.timeout)
    hooks = progress_hooks(cfg.max_pages) if args.progress else {}
    index, report = asyncio.run(audit_site(args.url, cfg, probe_user_agents=not args.no_ua_probe, lang=args.lang, **hooks))
    if args.reconcile:  # after scoring, so the audit stays a pure function of the crawl
        asyncio.run(reconcile(index.graph, lang=args.wikidata_lang, max_concepts=args.max_concepts))
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
        print(render_text(report, show_code=args.code, lang=args.lang), file=sys.stderr)
    return 0 if index.crawl.ok_pages else 1


if __name__ == "__main__":
    raise SystemExit(main())
