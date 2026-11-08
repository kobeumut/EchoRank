"""Wikidata entity reconciliation: site entities -> Wikidata QIDs (+ Wikipedia / Crunchbase fallbacks).

AI answer engines disambiguate brands, companies and authors against public knowledge graphs. Linking a
site's ``Organization`` / ``Brand`` / ``Person`` / ``Product`` / ``Concept`` nodes to their Wikidata item
(``sameAs: https://www.wikidata.org/wiki/Q…``) removes that ambiguity.

Flow per entity::

    wbsearchentities (site lang, then en) ─► wbgetentities (labels, aliases, claims, sitelinks)
        ─► score each candidate: name/alias · type (P31, SPARQL P31/P279* closure) · sector context · official website
        ─► matched (>= AUTO_ACCEPT) | review (>= REVIEW) | unmatched ─► Wikipedia search ─► Crunchbase (API key)

Only ``matched`` results write ``wikidataId`` / ``sameAs`` and ``same_as`` edges: a wrong ``sameAs`` tells
every answer engine the site is someone else, so ambiguous candidates stay in ``review`` for a human.
The scoring constants are mirrored in ``src/lib/services/wikidata.ts`` — keep them in sync.
"""
from __future__ import annotations

import asyncio
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any, Iterable
from urllib.parse import quote, urlparse

import httpx

from .graph import KnowledgeGraph
from .models import EntityType, RelationType

log = logging.getLogger(__name__)

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
WIKIDATA_ENTITY_URL = "https://www.wikidata.org/wiki/{}"
CRUNCHBASE_API = "https://api.crunchbase.com/api/v4/autocompletes"
# Wikimedia's User-Agent policy requires a descriptive agent with a contact URL.
USER_AGENT = "geo-crawler/0.1 (+https://github.com/kobeumut/ai-visibility) httpx"

AUTO_ACCEPT = 0.8
REVIEW = 0.55
# Common personal names collide: without corroboration (context / website / employer) a person stays in review.
PERSON_UNCORROBORATED_CAP = 0.7

RECONCILABLE = (EntityType.ORGANIZATION, EntityType.BRAND, EntityType.PERSON, EntityType.PRODUCT, EntityType.CONCEPT)

ORG_CLASSES = {
    "Q43229",  # organization
    "Q4830453",  # business
    "Q783794",  # company
    "Q891723",  # public company
    "Q6881511",  # enterprise
    "Q167037",  # corporation
    "Q1589009",  # privately held company
    "Q2085381",  # publisher
    "Q507619",  # retail chain
}
BRAND_CLASSES = {"Q431289", "Q167270"} | ORG_CLASSES  # brand, trademark — brands are often the company itself
PRODUCT_CLASSES = {
    "Q2424752",  # product
    "Q15401930",  # product (business)
    "Q2897903",  # goods
    "Q1183543",  # device
    "Q7397",  # software
    "Q11019",  # machine
    "Q10273457",  # equipment
    "Q431289",  # brand (product lines)
}
ACCEPTED_CLASSES: dict[EntityType, set[str]] = {
    EntityType.ORGANIZATION: ORG_CLASSES,
    EntityType.BRAND: BRAND_CLASSES,
    EntityType.PERSON: {"Q5"},
    EntityType.PRODUCT: PRODUCT_CLASSES,
}
# Never a valid match for a site entity (and name items would hijack person searches).
REJECTED_CLASSES = {
    "Q4167410",  # Wikimedia disambiguation page
    "Q22808320",  # Wikimedia human name disambiguation page
    "Q13406463",  # Wikimedia list article
    "Q4167836",  # Wikimedia category
    "Q11266439",  # Wikimedia template
    "Q101352",  # family name
    "Q202444",  # given name
    "Q12308941",  # male given name
    "Q11879590",  # female given name
}

# Identifier properties that become ``sameAs`` URLs (order = output order after Wikidata / Wikipedia).
SAME_AS_PROPS: list[tuple[str, str]] = [
    ("P4264", "https://www.linkedin.com/company/{}"),
    ("P6634", "https://www.linkedin.com/in/{}"),
    ("P2088", "https://www.crunchbase.com/organization/{}"),
    ("P2087", "https://www.crunchbase.com/person/{}"),
    ("P2002", "https://x.com/{}"),
    ("P2013", "https://www.facebook.com/{}"),
    ("P2003", "https://www.instagram.com/{}/"),
    ("P2397", "https://www.youtube.com/channel/{}"),
    ("P2037", "https://github.com/{}"),
    ("P496", "https://orcid.org/{}"),
    ("P214", "https://viaf.org/viaf/{}"),
]

_TR_FOLD = str.maketrans("çğıöşüÇĞİÖŞÜâîû", "cgiosuCGIOSUaiu")
_LEGAL_SUFFIX = re.compile(
    r"\b(a\.?\s?s|ltd|sti|san|tic|ve|inc|llc|gmbh|corp|corporation|co|company|plc|ag|sa|srl|bv|limited|holding)\b\.?",
)
_STOP = {"the", "and", "of", "a", "an", "ve", "ile", "bir", "icin", "for", "in", "de", "da"}


def fold(text: str) -> str:
    """Case/diacritic-insensitive form (Turkish dotless i included)."""
    text = str(text).translate(_TR_FOLD)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().casefold()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text)).strip()


def normalize_name(name: str) -> str:
    folded = fold(name)
    stripped = re.sub(r"\s+", " ", _LEGAL_SUFFIX.sub(" ", folded)).strip()
    return stripped or folded


def tokens(text: str) -> set[str]:
    return {t for t in fold(text).split() if len(t) > 2 and t not in _STOP}


def host_of(url: str | None) -> str:
    if not url:
        return ""
    host = (urlparse(url if "://" in url else f"https://{url}").hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def wikidata_url(qid: str) -> str:
    return WIKIDATA_ENTITY_URL.format(qid)


def qid_from_url(value: str) -> str | None:
    m = re.search(r"wikidata\.org/(?:wiki|entity)/(Q\d+)\b", value or "")
    return m.group(1) if m else None


def name_similarity(query: str, names: Iterable[str]) -> float:
    q = normalize_name(query)
    if not q:
        return 0.0
    best = 0.0
    q_tokens = set(q.split())
    for n in names:
        c = normalize_name(n)
        if not c:
            continue
        if c == q:
            return 1.0
        ratio = SequenceMatcher(None, q, c).ratio() * 0.9
        c_tokens = set(c.split())
        if q_tokens and c_tokens and (q_tokens <= c_tokens or c_tokens <= q_tokens):
            # "Brevio" vs "Brevio Kahve" — containment, penalised by the extra words
            ratio = max(ratio, 0.85 * len(q_tokens & c_tokens) / max(len(q_tokens), len(c_tokens)) + 0.15)
        best = max(best, ratio)
    return round(min(best, 1.0), 4)


# ---------------------------------------------------------------- data


@dataclass
class EntityContext:
    """What we know about a site entity when searching for it."""

    name: str
    type: EntityType
    lang: str = "en"
    site_host: str = ""
    url: str | None = None
    declared_same_as: list[str] = field(default_factory=list)
    context_terms: set[str] = field(default_factory=set)  # sector / topic words from the site
    org_qids: set[str] = field(default_factory=set)  # already-matched site organisations (for employer checks)


@dataclass
class Candidate:
    qid: str
    label: str
    description: str = ""
    aliases: list[str] = field(default_factory=list)
    instance_of: list[str] = field(default_factory=list)
    websites: list[str] = field(default_factory=list)
    sitelinks: dict[str, str] = field(default_factory=dict)  # "trwiki" -> url
    claims: dict[str, list[str]] = field(default_factory=dict)  # selected property -> values
    search_rank: int = 0
    score: float = 0.0
    signals: dict[str, float] = field(default_factory=dict)

    def summary(self) -> dict[str, Any]:
        return {"qid": self.qid, "label": self.label, "description": self.description or None,
                "url": wikidata_url(self.qid), "score": self.score, "signals": self.signals}


@dataclass
class ReconciliationResult:
    entity_id: str
    status: str  # matched | review | unmatched | declared
    method: str  # wikidata_search | declared_same_as | wikipedia | crunchbase | none
    confidence: float = 0.0
    qid: str | None = None
    label: str | None = None
    wikipedia_url: str | None = None
    same_as: list[str] = field(default_factory=list)
    candidates: list[dict[str, Any]] = field(default_factory=list)
    person: dict[str, list[dict[str, str]]] = field(default_factory=dict)  # knowsAbout / alumniOf / hasCredential
    employer_qids: list[str] = field(default_factory=list)

    @property
    def accepted(self) -> bool:
        return self.status in ("matched", "declared") and self.qid is not None


# ---------------------------------------------------------------- client


class WikidataClient:
    """Thin async client for the Wikidata / Wikipedia APIs, SPARQL and (optionally) Crunchbase.

    Responses are cached per process; ``concurrency`` bounds parallel requests (Wikimedia asks for restraint).
    """

    def __init__(self, client: httpx.AsyncClient | None = None, *, concurrency: int = 2, timeout: float = 15.0,
                 crunchbase_key: str | None = None, sparql: bool = True):
        self._own = client is None
        self.http = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": USER_AGENT})
        self.sem = asyncio.Semaphore(concurrency)
        self.crunchbase_key = crunchbase_key
        self.sparql_enabled = sparql
        self._cache: dict[tuple[Any, ...], Any] = {}

    async def __aenter__(self) -> "WikidataClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._own:
            await self.http.aclose()

    async def _get(self, url: str, params: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
        key = (url, tuple(sorted(params.items())))
        if key in self._cache:
            return self._cache[key]
        async with self.sem:
            resp = await self.http.get(url, params=params, headers={"User-Agent": USER_AGENT, **(headers or {})})
        resp.raise_for_status()
        data = resp.json()
        self._cache[key] = data
        return data

    async def search(self, name: str, lang: str = "en", limit: int = 5) -> list[dict[str, Any]]:
        data = await self._get(WIKIDATA_API, {
            "action": "wbsearchentities", "search": name[:250], "language": lang, "uselang": lang,
            "type": "item", "limit": limit, "format": "json",
        })
        return list(data.get("search") or [])

    async def get_entities(self, qids: list[str], langs: Iterable[str] = ("en",),
                           props: str = "labels|aliases|descriptions|claims|sitelinks/urls") -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        ids = list(dict.fromkeys(q for q in qids if re.fullmatch(r"Q\d+", q)))
        for i in range(0, len(ids), 50):  # API limit per request
            data = await self._get(WIKIDATA_API, {
                "action": "wbgetentities", "ids": "|".join(ids[i:i + 50]), "props": props,
                "languages": "|".join(dict.fromkeys(langs)), "format": "json",
            })
            for qid, ent in (data.get("entities") or {}).items():
                if "missing" not in ent:
                    out[ent.get("id", qid)] = ent
        return out

    async def labels(self, qids: list[str], lang: str) -> dict[str, str]:
        ents = await self.get_entities(qids, (lang, "en"), props="labels")
        return {q: _lang_value(e.get("labels"), lang) for q, e in ents.items() if _lang_value(e.get("labels"), lang)}

    async def instances_within(self, qids: list[str], classes: set[str]) -> set[str]:
        """SPARQL ``P31/P279*`` closure: which of ``qids`` are instances of (a subclass of) ``classes``."""
        if not self.sparql_enabled or not qids or not classes:
            return set()
        query = (
            "SELECT DISTINCT ?item WHERE { VALUES ?item { " + " ".join(f"wd:{q}" for q in sorted(qids)) + " } "
            "VALUES ?cls { " + " ".join(f"wd:{c}" for c in sorted(classes)) + " } "
            "?item wdt:P31/wdt:P279* ?cls . }"
        )
        try:
            data = await self._get(WIKIDATA_SPARQL, {"query": query, "format": "json"},
                                   headers={"Accept": "application/sparql-results+json"})
        except (httpx.HTTPError, ValueError) as exc:  # endpoint is often overloaded — degrade to direct P31
            log.info("SPARQL type check failed: %s", exc)
            return set()
        found = set()
        for b in (data.get("results") or {}).get("bindings") or []:
            q = qid_from_url((b.get("item") or {}).get("value", ""))
            if q:
                found.add(q)
        return found

    async def wikipedia_search(self, name: str, lang: str = "en", limit: int = 3) -> list[dict[str, Any]]:
        """Wikipedia full-text search; returns ``[{title, url, qid}]`` (``qid`` from page props when linked)."""
        data = await self._get(f"https://{lang}.wikipedia.org/w/api.php", {
            "action": "query", "generator": "search", "gsrsearch": name[:250], "gsrlimit": limit,
            "prop": "pageprops|info", "ppprop": "wikibase_item", "inprop": "url", "redirects": 1, "format": "json",
        })
        pages = sorted(((data.get("query") or {}).get("pages") or {}).values(), key=lambda p: p.get("index", 0))
        return [{"title": p.get("title", ""), "url": p.get("fullurl") or _wiki_url(lang, p.get("title", "")),
                 "qid": (p.get("pageprops") or {}).get("wikibase_item")} for p in pages]

    async def crunchbase_search(self, name: str, limit: int = 3) -> list[dict[str, Any]]:
        if not self.crunchbase_key:
            return []
        data = await self._get(CRUNCHBASE_API, {"query": name[:100], "collection_ids": "organizations", "limit": limit},
                               headers={"X-cb-user-key": self.crunchbase_key})
        out = []
        for e in data.get("entities") or []:
            ident = e.get("identifier") or {}
            if ident.get("permalink"):
                out.append({"name": ident.get("value", ""), "url": f"https://www.crunchbase.com/organization/{ident['permalink']}",
                            "description": e.get("short_description") or ""})
        return out


def _lang_value(d: dict[str, Any] | None, lang: str) -> str:
    d = d or {}
    for key in (lang, "en", *d.keys()):
        v = d.get(key)
        if isinstance(v, dict) and v.get("value"):
            return v["value"]
    return ""


def _wiki_url(lang: str, title: str) -> str:
    return f"https://{lang}.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"


def _claim_values(entity: dict[str, Any], prop: str) -> list[str]:
    out = []
    for c in (entity.get("claims") or {}).get(prop) or []:
        if c.get("rank") == "deprecated":
            continue
        v = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value")
        if isinstance(v, dict):
            v = v.get("id") or v.get("text")
        if isinstance(v, str) and v:
            out.append(v)
    return out


_CLAIM_PROPS = ["P31", "P856", "P69", "P101", "P106", "P108", "P512"] + [p for p, _ in SAME_AS_PROPS]


def candidate_from_entity(ent: dict[str, Any], lang: str, rank: int = 0) -> Candidate:
    aliases = []
    for lng in (lang, "en"):
        aliases += [a.get("value", "") for a in (ent.get("aliases") or {}).get(lng) or []]
    sitelinks = {k: v.get("url") or _wiki_url(k[:-4], v.get("title", "")) for k, v in (ent.get("sitelinks") or {}).items()
                 if k.endswith("wiki") and k not in ("commonswiki", "specieswiki") and isinstance(v, dict)}
    claims = {p: _claim_values(ent, p) for p in _CLAIM_PROPS}
    return Candidate(
        qid=ent["id"], label=_lang_value(ent.get("labels"), lang), description=_lang_value(ent.get("descriptions"), lang),
        aliases=[a for a in aliases if a], instance_of=claims.get("P31", []), websites=claims.get("P856", []),
        sitelinks=sitelinks, claims={p: v for p, v in claims.items() if v}, search_rank=rank,
    )


# ---------------------------------------------------------------- scoring


def score_candidate(ctx: EntityContext, cand: Candidate, sparql_types: set[str] | None = None) -> float:
    """Confidence 0..1 that ``cand`` is the same real-world thing as the site entity.

    0.5·name + 0.25·type + 0.15·context + 0.10·search rank, then hard rules:
    rejected class (disambiguation, given name, ...) → ×0.3; official website on the site's domain → ≥ 0.97;
    a person without corroborating context/employer → capped at ``PERSON_UNCORROBORATED_CAP``.
    """
    name = name_similarity(ctx.name, [cand.label, *cand.aliases])
    p31 = set(cand.instance_of)
    accepted = ACCEPTED_CLASSES.get(ctx.type)
    if p31 & REJECTED_CLASSES or (ctx.type is EntityType.PERSON and p31 and "Q5" not in p31):
        type_score = 0.0
    elif ctx.type is not EntityType.PERSON and "Q5" in p31:
        type_score = 0.0  # a brand / product / topic is not a human
    elif accepted is None:
        type_score = 0.8  # concepts: anything that is not a Wikimedia artefact or a person
    elif p31 & accepted or cand.qid in (sparql_types or set()):
        type_score = 1.0
    else:
        type_score = 0.4  # unknown — SPARQL unavailable or class outside our list
    text = tokens(f"{cand.description} {cand.label}")
    overlap = len(text & ctx.context_terms)
    context = min(1.0, overlap / 2)
    employer = bool(set(cand.claims.get("P108", [])) & ctx.org_qids)
    if employer:
        context = 1.0
    website = bool(ctx.site_host) and any(host_of(w) == ctx.site_host or host_of(w).endswith("." + ctx.site_host)
                                          for w in cand.websites)
    if ctx.url and not website:
        website = any(host_of(w) == host_of(ctx.url) for w in cand.websites)
    rank = max(0.0, 1.0 - 0.25 * cand.search_rank)

    conf = 0.5 * name + 0.25 * type_score + 0.15 * context + 0.10 * rank
    if type_score == 0.0:
        conf *= 0.3
    elif website and name >= 0.6:
        conf = max(conf, 0.97)
    if ctx.type is EntityType.PERSON and not (website or employer or overlap):
        conf = min(conf, PERSON_UNCORROBORATED_CAP)
    cand.signals = {"name": name, "type": type_score, "context": round(context, 4), "website": float(website),
                    "rank": rank}
    cand.score = round(min(conf, 1.0), 4)
    return cand.score


def same_as_urls(cand: Candidate, lang: str) -> tuple[str | None, list[str]]:
    """(wikipedia url, ordered sameAs list: Wikidata, Wikipedia, LinkedIn, Crunchbase, socials...)."""
    wiki = cand.sitelinks.get(f"{lang}wiki") or cand.sitelinks.get("enwiki") or next(iter(cand.sitelinks.values()), None)
    urls = [wikidata_url(cand.qid)] + ([wiki] if wiki else [])
    for prop, tpl in SAME_AS_PROPS:
        for v in cand.claims.get(prop, [])[:1]:
            urls.append(tpl.format(quote(v, safe="@._-")))
    return wiki, list(dict.fromkeys(urls))


# ---------------------------------------------------------------- reconciler


class EntityReconciler:
    def __init__(self, client: WikidataClient, *, auto_accept: float = AUTO_ACCEPT, review: float = REVIEW,
                 max_candidates: int = 5):
        self.client = client
        self.auto_accept = auto_accept
        self.review = review
        self.max_candidates = max_candidates

    async def reconcile(self, entity_id: str, ctx: EntityContext) -> ReconciliationResult:
        declared = next((q for q in (qid_from_url(u) for u in ctx.declared_same_as) if q), None)
        if declared:
            return await self._declared(entity_id, ctx, declared)

        candidates = await self._candidates(ctx)
        if candidates:
            classes = ACCEPTED_CLASSES.get(ctx.type)
            unresolved = [c.qid for c in candidates if classes and not (set(c.instance_of) & (classes | REJECTED_CLASSES))]
            sparql = await self.client.instances_within(unresolved, classes) if unresolved and classes else set()
            for c in candidates:
                score_candidate(ctx, c, sparql)
            candidates.sort(key=lambda c: (-c.score, c.search_rank))
            best = candidates[0]
            summaries = [c.summary() for c in candidates[:3]]
            if best.score >= self.auto_accept:
                return await self._accepted(entity_id, ctx, best, "matched", "wikidata_search", summaries)
            if best.score >= self.review:
                return ReconciliationResult(entity_id, "review", "wikidata_search", best.score, candidates=summaries)

        return await self._fallback(entity_id, ctx, [c.summary() for c in candidates[:3]])

    async def _candidates(self, ctx: EntityContext) -> list[Candidate]:
        langs = list(dict.fromkeys([ctx.lang or "en", "en"]))
        hits: list[dict[str, Any]] = []
        for lang in langs:
            hits = await self.client.search(ctx.name, lang, self.max_candidates)
            if hits:
                break
        if not hits:
            return []
        rank = {h["id"]: i for i, h in enumerate(hits) if h.get("id")}
        ents = await self.client.get_entities(list(rank), langs)
        return [candidate_from_entity(ents[q], ctx.lang or "en", rank[q]) for q in rank if q in ents]

    async def _declared(self, entity_id: str, ctx: EntityContext, qid: str) -> ReconciliationResult:
        ents = await self.client.get_entities([qid], (ctx.lang or "en", "en"))
        if qid not in ents:
            return ReconciliationResult(entity_id, "unmatched", "declared_same_as", 0.0)
        cand = candidate_from_entity(ents[qid], ctx.lang or "en")
        cand.score, cand.signals = 1.0, {"declared": 1.0}
        return await self._accepted(entity_id, ctx, cand, "declared", "declared_same_as", [cand.summary()])

    async def _accepted(self, entity_id: str, ctx: EntityContext, cand: Candidate, status: str, method: str,
                        summaries: list[dict[str, Any]]) -> ReconciliationResult:
        wiki, urls = same_as_urls(cand, ctx.lang or "en")
        res = ReconciliationResult(entity_id, status, method, cand.score, cand.qid, cand.label, wiki, urls, summaries,
                                   employer_qids=cand.claims.get("P108", []))
        if ctx.type is EntityType.PERSON:
            res.person = await self._person_facts(cand, ctx.lang or "en")
        return res

    async def _person_facts(self, cand: Candidate, lang: str) -> dict[str, list[dict[str, str]]]:
        groups = {"alumniOf": cand.claims.get("P69", []), "hasCredential": cand.claims.get("P512", []),
                  "knowsAbout": cand.claims.get("P101", []) or cand.claims.get("P106", [])}
        ids = [q for qs in groups.values() for q in qs[:8]]
        names = await self.client.labels(ids, lang) if ids else {}
        return {k: [{"name": names[q], "wikidataId": q} for q in qs[:8] if q in names] for k, qs in groups.items()
                if any(q in names for q in qs[:8])}

    async def _fallback(self, entity_id: str, ctx: EntityContext, summaries: list[dict[str, Any]]) -> ReconciliationResult:
        lang = ctx.lang or "en"
        try:
            pages = await self.client.wikipedia_search(ctx.name, lang)
        except (httpx.HTTPError, ValueError) as exc:
            log.info("Wikipedia search failed for %s: %s", ctx.name, exc)
            pages = []
        for i, page in enumerate(pages):
            if name_similarity(ctx.name, [re.sub(r"\s*\(.*\)$", "", page["title"])]) < 0.9:
                continue
            if page.get("qid"):  # article is linked to an item we did not surface — score it properly
                ents = await self.client.get_entities([page["qid"]], (lang, "en"))
                if page["qid"] in ents:
                    cand = candidate_from_entity(ents[page["qid"]], lang, i)
                    score_candidate(ctx, cand)
                    if cand.score >= self.auto_accept:
                        return await self._accepted(entity_id, ctx, cand, "matched", "wikipedia", [cand.summary(), *summaries][:3])
                    if cand.score >= self.review:
                        return ReconciliationResult(entity_id, "review", "wikipedia", cand.score,
                                                    candidates=[cand.summary(), *summaries][:3])
            elif ctx.type is not EntityType.PERSON:
                # Wikipedia article without a Wikidata item: usable link, never an auto-match
                return ReconciliationResult(entity_id, "review", "wikipedia", self.review, wikipedia_url=page["url"],
                                            candidates=summaries)
        if ctx.type in (EntityType.ORGANIZATION, EntityType.BRAND) and self.client.crunchbase_key:
            try:
                orgs = await self.client.crunchbase_search(ctx.name)
            except (httpx.HTTPError, ValueError) as exc:
                log.info("Crunchbase search failed for %s: %s", ctx.name, exc)
                orgs = []
            for org in orgs:
                if name_similarity(ctx.name, [org["name"]]) == 1.0:
                    return ReconciliationResult(entity_id, "review", "crunchbase", self.review, same_as=[org["url"]],
                                                candidates=summaries)
        best = max((s["score"] for s in summaries), default=0.0)
        return ReconciliationResult(entity_id, "unmatched", "none", best, candidates=summaries)


# ---------------------------------------------------------------- graph integration


def _site_context(kg: KnowledgeGraph, max_terms: int = 40) -> tuple[str, set[str]]:
    """(dominant page language, sector terms: categories + most-mentioned concepts + site host stem)."""
    langs: dict[str, int] = {}
    for n in kg.nodes_of_type(EntityType.PAGE):
        lang = (kg.g.nodes[n]["properties"].get("lang") or "").split("-")[0].lower()
        if lang:
            langs[lang] = langs.get(lang, 0) + 1
    lang = max(langs, key=langs.get) if langs else "en"
    terms: set[str] = set()
    for n in kg.nodes_of_type(EntityType.CATEGORY):
        terms |= tokens(kg.g.nodes[n]["label"])
    concepts = sorted(kg.nodes_of_type(EntityType.CONCEPT), key=lambda n: -kg.g.in_degree(n))
    for n in concepts[:max_terms]:
        terms |= tokens(kg.g.nodes[n]["label"])
    stem = host_of(kg.site).split(".")[0]
    if len(stem) > 2:
        terms.add(fold(stem))
    return lang, terms


def _targets(kg: KnowledgeGraph, types: Iterable[EntityType], max_concepts: int) -> list[str]:
    out: list[str] = []
    for t in types:
        nodes = [n for n in kg.nodes_of_type(t) if not kg.g.nodes[n]["properties"].get("placeholder")
                 and len(kg.g.nodes[n]["label"].strip()) >= 2]
        if t is EntityType.CONCEPT:
            # schema.org about/mentions first, then keywords by how many pages mention them
            def rank(n: str) -> tuple[int, int]:
                schema = any(d.get("properties", {}).get("source") == "schema" for _, _, d in kg.g.in_edges(n, data=True))
                return (0 if schema else 1, -kg.g.in_degree(n))
            nodes = sorted(nodes, key=rank)[:max_concepts]
        out += nodes
    return out


def apply_result(kg: KnowledgeGraph, res: ReconciliationResult, *, now: str | None = None) -> None:
    """Write a reconciliation result onto the node and materialise ``same_as`` edges for accepted matches."""
    props = kg.g.nodes[res.entity_id]["properties"]
    declared = [u for u in props.get("same_as") or [] if isinstance(u, str) and u.startswith("http")]
    props["confidence"] = res.confidence
    props["reconciliation"] = {
        "status": res.status, "method": res.method, "confidence": res.confidence,
        "candidates": res.candidates, "reconciledAt": now or datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    for k in ("wikidataId", "wikidataUrl", "wikipediaUrl", "sameAs", "alumniOf", "knowsAbout", "hasCredential",
              "employerWikidataIds"):
        props.pop(k, None)
    if not res.accepted:
        # unverified links are suggestions for the review queue, never published as sameAs
        suggested = {k: v for k, v in (("wikipediaUrl", res.wikipedia_url), ("sameAs", res.same_as)) if v}
        if suggested:
            props["reconciliation"]["suggested"] = suggested
        if declared:
            props["sameAs"] = list(dict.fromkeys(declared))
        return
    if res.wikipedia_url:
        props["wikipediaUrl"] = res.wikipedia_url
    props["wikidataId"] = res.qid
    props["wikidataUrl"] = wikidata_url(res.qid)
    props["sameAs"] = list(dict.fromkeys(res.same_as + declared))
    for k, v in res.person.items():
        props[k] = v
    if res.employer_qids:
        props["employerWikidataIds"] = res.employer_qids
    wd = f"wikidata:{res.qid}"
    kg.add_node(wd, EntityType.WIKIDATA_ENTITY.value, res.label or res.qid, {"wikidataId": res.qid, "url": wikidata_url(res.qid)})
    kg.add_edge(res.entity_id, wd, RelationType.SAME_AS.value, {"confidence": res.confidence, "method": res.method})


def link_shared_identities(kg: KnowledgeGraph) -> int:
    """Site entities resolved to the same QID (Brand "Brevio" + Organization "Brevio A.Ş.") get a direct same_as edge."""
    by_qid: dict[str, list[str]] = {}
    for n, d in kg.g.nodes(data=True):
        q = d.get("properties", {}).get("wikidataId")
        if q and d.get("type") != EntityType.WIKIDATA_ENTITY.value:
            by_qid.setdefault(q, []).append(n)
    added = 0
    for nodes in by_qid.values():
        nodes.sort()
        for i, a in enumerate(nodes):
            for b in nodes[i + 1:]:
                if not kg.g.has_edge(a, b, key=RelationType.SAME_AS.value):
                    kg.add_edge(a, b, RelationType.SAME_AS.value, {"method": "shared_wikidata_id"})
                    added += 1
    return added


async def reconcile_graph(kg: KnowledgeGraph, client: WikidataClient, *,
                          types: Iterable[EntityType] = RECONCILABLE, max_concepts: int = 15,
                          lang: str | None = None, reconciler: EntityReconciler | None = None) -> dict[str, Any]:
    """Reconcile graph entities against Wikidata in place. Returns a summary ``{status counts, results}``.

    Organizations go first so that persons can be corroborated by their employer (P108) QID.
    """
    reconciler = reconciler or EntityReconciler(client)
    site_lang, terms = _site_context(kg)
    lang = lang or site_lang
    site_host = host_of(kg.site)
    order = sorted(set(types), key=lambda t: RECONCILABLE.index(t) if t in RECONCILABLE else 99)
    results: list[ReconciliationResult] = []
    org_qids: set[str] = set()
    for t in order:
        targets = _targets(kg, [t], max_concepts)

        async def one(node_id: str) -> ReconciliationResult:
            d = kg.g.nodes[node_id]
            p = d["properties"]
            declared = [u for u in (p.get("same_as") or []) if isinstance(u, str)]
            ctx = EntityContext(
                name=d["label"], type=t, lang=lang, url=p.get("url"),
                site_host=site_host if t in (EntityType.ORGANIZATION, EntityType.BRAND) else "",
                declared_same_as=declared, context_terms=terms - tokens(d["label"]), org_qids=set(org_qids),
            )
            try:
                return await reconciler.reconcile(node_id, ctx)
            except (httpx.HTTPError, ValueError) as exc:
                log.warning("reconciliation failed for %s: %s", node_id, exc)
                return ReconciliationResult(node_id, "error", "none", 0.0)

        batch = await asyncio.gather(*(one(n) for n in targets))
        for res in batch:
            if res.status == "error":
                kg.g.nodes[res.entity_id]["properties"]["reconciliation"] = {"status": "error", "method": "none"}
                continue
            apply_result(kg, res)
            kg.g.nodes[res.entity_id]["properties"]["reconciliation"]["lang"] = lang  # reused by API re-queries
            if res.accepted and t in (EntityType.ORGANIZATION, EntityType.BRAND):
                org_qids.add(res.qid)  # type: ignore[arg-type]
        results += batch
    shared = link_shared_identities(kg)
    counts: dict[str, int] = {}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    return {
        "lang": lang, "reconciled": len(results), "by_status": counts, "shared_identity_edges": shared,
        "results": [{"entity": r.entity_id, "status": r.status, "method": r.method, "confidence": r.confidence,
                     "wikidataId": r.qid} for r in results],
    }
