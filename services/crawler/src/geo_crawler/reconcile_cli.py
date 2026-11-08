"""CLI: geo-reconcile graph.json -o graph.reconciled.json [--jsonld schema.json]

Reconciles Organization / Brand / Person / Product / Concept nodes of an exported graph against Wikidata
(Wikipedia + Crunchbase fallbacks) and emits the Schema.org ``@graph`` JSON-LD. ``CRUNCHBASE_API_KEY`` enables
the Crunchbase fallback.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import Any

from .graph import KnowledgeGraph
from .jsonld import build_jsonld, validate_jsonld
from .models import EntityType
from .wikidata import RECONCILABLE, WikidataClient, reconcile_graph


async def reconcile(kg: KnowledgeGraph, *, lang: str | None = None, max_concepts: int = 15,
                    types: list[EntityType] | None = None) -> dict[str, Any]:
    async with WikidataClient(crunchbase_key=os.environ.get("CRUNCHBASE_API_KEY") or None) as client:
        return await reconcile_graph(kg, client, types=types or RECONCILABLE, max_concepts=max_concepts, lang=lang)


def add_arguments(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--lang", help="search language (default: dominant page language)")
    ap.add_argument("--max-concepts", type=int, default=15, help="keyword concepts to reconcile (most-mentioned first)")


def write_jsonld(kg: KnowledgeGraph, path: str) -> list[str]:
    doc = build_jsonld(kg)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
    return validate_jsonld(doc)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="geo-reconcile", description="Wikidata entity reconciliation + JSON-LD @graph")
    ap.add_argument("graph", help="graph JSON produced by geo-crawler")
    ap.add_argument("-o", "--output", default="-", help="reconciled graph JSON ('-' = stdout)")
    ap.add_argument("--jsonld", help="write Schema.org @graph JSON-LD to this path")
    ap.add_argument("--types", help="comma-separated entity types (default: Organization,Brand,Person,Product,Concept)")
    add_arguments(ap)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(message)s")

    data = json.load(open(args.graph, encoding="utf-8"))
    kg = KnowledgeGraph.from_dict(data)
    types = [EntityType(t.strip()) for t in args.types.split(",")] if args.types else None
    summary = asyncio.run(reconcile(kg, lang=args.lang, max_concepts=args.max_concepts, types=types))
    out = kg.export_graph_json(None if args.output == "-" else args.output, gaps=data.get("gaps"))
    if args.output == "-":
        print(out)
    if args.jsonld:
        summary["jsonld_errors"] = write_jsonld(kg, args.jsonld)
    summary.pop("results", None)
    print(json.dumps(summary, ensure_ascii=False, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
