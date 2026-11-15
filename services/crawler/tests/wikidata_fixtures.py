"""Deterministic fake Wikidata / Wikipedia / SPARQL / Crunchbase backend (httpx.MockTransport).

The entities are Turkish on purpose (Turkish labels, diacritic folding, ``trwiki`` sitelinks): they exercise the
Turkish entity-matching paths of the reconciler.
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx


def claim(value: Any) -> dict[str, Any]:
    dv = {"value": {"entity-type": "item", "id": value}} if re.fullmatch(r"Q\d+", str(value)) else {"value": value}
    return {"mainsnak": {"datavalue": dv}, "rank": "normal"}


def item(qid: str, label: str, description: str = "", *, aliases: list[str] | None = None,
         claims: dict[str, list[Any]] | None = None, sitelinks: dict[str, str] | None = None) -> dict[str, Any]:
    return {
        "id": qid,
        "labels": {"tr": {"language": "tr", "value": label}},
        "descriptions": {"tr": {"language": "tr", "value": description}} if description else {},
        "aliases": {"tr": [{"language": "tr", "value": a} for a in aliases or []]},
        "claims": {p: [claim(v) for v in vs] for p, vs in (claims or {}).items()},
        "sitelinks": {k: {"site": k, "title": t, "url": f"https://{k[:-4]}.wikipedia.org/wiki/{t.replace(' ', '_')}"}
                      for k, t in (sitelinks or {}).items()},
    }


ENTITIES: dict[str, dict[str, Any]] = {e["id"]: e for e in [
    item("Q1001", "Kahve Dükkanı", "Türk kahve perakende şirketi", aliases=["Kahve Dükkanı A.Ş."],
         claims={"P31": ["Q4830453"], "P856": ["https://www.shop.example.com/"], "P4264": ["kahve-dukkani"],
                 "P2088": ["kahve-dukkani"], "P2002": ["kahvedukkani"]},
         sitelinks={"trwiki": "Kahve Dükkanı", "enwiki": "Kahve Dukkani"}),
    item("Q1002", "Kahve Dükkanı", "anlam ayrımı sayfası", claims={"P31": ["Q4167410"]}),
    item("Q2001", "Brevio", "kahve makinesi markası", claims={"P31": ["Q431289"]}, sitelinks={"trwiki": "Brevio"}),
    # rank 0 for the person search: same name, unrelated actress — must NOT win
    item("Q3002", "Ayşe Yılmaz", "Türk oyuncu", claims={"P31": ["Q5"]}),
    item("Q3001", "Ayşe Yılmaz", "Türk barista ve kahve yazarı",
         claims={"P31": ["Q5"], "P108": ["Q1001"], "P69": ["Q4001"], "P101": ["Q4002"], "P512": ["Q4003"],
                 "P6634": ["ayse-yilmaz"], "P496": ["0000-0002-1825-0097"]}),
    item("Q4001", "Boğaziçi Üniversitesi"),
    item("Q4002", "kahve"),
    item("Q4003", "lisans derecesi"),
    item("Q5001", "espresso", "koyu kahve içeceği", claims={"P31": ["Q2095"]}, sitelinks={"trwiki": "Espresso"}),
    item("Q6001", "Mini Espresso", "espresso makinesi modeli", claims={"P31": ["Q99999"]}),
    item("Q7001", "Filtre Kahve Derneği", "kahve derneği", claims={"P31": ["Q43229"]}),
]}

SEARCH: dict[str, list[str]] = {
    "kahve dükkanı a.ş.": ["Q1002", "Q1001"],
    "brevio": ["Q2001"],
    "ayşe yılmaz": ["Q3002", "Q3001"],
    "espresso": ["Q5001"],
    "mini espresso": ["Q6001"],
}

WIKIPEDIA: dict[str, list[dict[str, Any]]] = {
    "filtre kahve derneği": [{"title": "Filtre Kahve Derneği", "qid": "Q7001"}],
    "barista pro x": [{"title": "Barista Pro X", "qid": None}],
}

CRUNCHBASE: dict[str, list[dict[str, Any]]] = {
    "moka house": [{"identifier": {"permalink": "moka-house", "value": "Moka House"}, "short_description": "Coffee"}],
}


class FakeWikidata:
    def __init__(self, sparql_status: int = 200, sparql_instances: set[str] | None = None):
        self.calls: list[str] = []
        self.sparql_status = sparql_status
        self.sparql_instances = {"Q6001"} if sparql_instances is None else sparql_instances
        self.user_agents: set[str] = set()

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = urlparse(str(request.url))
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        self.user_agents.add(request.headers.get("user-agent", ""))
        host = url.hostname or ""
        if host == "www.wikidata.org":
            action = q.get("action")
            self.calls.append(f"{action}:{q.get('search') or q.get('ids')}")
            if action == "wbsearchentities":
                ids = SEARCH.get(q["search"].casefold(), []) if q.get("language") == "tr" else []
                return httpx.Response(200, json={"search": [{"id": i, "label": ENTITIES[i]["labels"]["tr"]["value"]} for i in ids]})
            if action == "wbgetentities":
                ents = {i: (ENTITIES.get(i) or {"id": i, "missing": ""}) for i in q["ids"].split("|")}
                if q.get("props") == "labels":
                    ents = {i: {"id": i, "labels": e.get("labels", {})} if "missing" not in e else e for i, e in ents.items()}
                return httpx.Response(200, json={"entities": ents})
        if host == "query.wikidata.org":
            self.calls.append("sparql")
            if self.sparql_status != 200:
                return httpx.Response(self.sparql_status, text="busy")
            asked = set(re.findall(r"wd:(Q\d+)", q["query"].split("VALUES ?cls")[0]))
            rows = [{"item": {"type": "uri", "value": f"http://www.wikidata.org/entity/{i}"}} for i in sorted(asked & self.sparql_instances)]
            return httpx.Response(200, json={"results": {"bindings": rows}})
        if host.endswith(".wikipedia.org"):
            self.calls.append(f"wikipedia:{q.get('gsrsearch')}")
            pages = WIKIPEDIA.get((q.get("gsrsearch") or "").casefold(), []) if host.startswith("tr.") else []
            return httpx.Response(200, json={"query": {"pages": {
                str(i): {"index": i + 1, "title": p["title"], "fullurl": f"https://tr.wikipedia.org/wiki/{p['title'].replace(' ', '_')}",
                         **({"pageprops": {"wikibase_item": p["qid"]}} if p["qid"] else {})}
                for i, p in enumerate(pages)}}} if pages else {"batchcomplete": ""})
        if host == "api.crunchbase.com":
            self.calls.append(f"crunchbase:{q.get('query')}")
            if request.headers.get("x-cb-user-key") != "cb-test":
                return httpx.Response(401, json={"error": "unauthorized"})
            return httpx.Response(200, json={"entities": CRUNCHBASE.get((q.get("query") or "").casefold(), [])})
        return httpx.Response(404, text=json.dumps({"error": f"unexpected {request.url}"}))
