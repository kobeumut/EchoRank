"""Schema.org JSON-LD ``@graph`` built from the (reconciled) knowledge graph, plus a strict validator.

Every node carries a stable ``@id`` and references other nodes by ``{"@id": …}`` only, so the output is one
connected graph: WebSite ─publisher→ Organization ←publisher─ Article ─author→ Person ─knowsAbout→ Thing,
Product ─brand→ Brand, Offer ─seller→ Organization. ``sameAs`` lists Wikidata first, then Wikipedia,
LinkedIn, Crunchbase and other profiles (see ``wikidata.same_as_urls``).

Only nodes that satisfy Google's rich-result requirements are emitted (e.g. a Product needs an Offer or an
AggregateRating), and ``validate_jsonld`` enforces the same rules — ``build`` output must validate clean.
The TypeScript twin lives in ``src/lib/jsonld.ts``.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import urljoin, urlparse

from .graph import KnowledgeGraph
from .models import EntityType, RelationType

CONTEXT = "https://schema.org"
AVAILABILITY = {
    "in_stock": "InStock", "out_of_stock": "OutOfStock", "pre_order": "PreOrder", "back_order": "BackOrder",
    "discontinued": "Discontinued", "limited": "LimitedAvailability",
}
HEADLINE_MAX = 110  # Google Article guideline
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$")


def _origin(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}/" if p.scheme and p.netloc else url


def _slug(node_id: str) -> str:
    return node_id.split(":", 1)[-1]


def _clean(value: Any) -> Any:
    """Drop None / "" / [] / {} recursively — empty properties are validation warnings in Google's tools."""
    if isinstance(value, dict):
        out = {k: _clean(v) for k, v in value.items()}
        return {k: v for k, v in out.items() if v not in (None, "", [], {})}
    if isinstance(value, list):
        out = [_clean(v) for v in value]
        return [v for v in out if v not in (None, "", [], {})]
    return value


def _http(urls: Any) -> list[str]:
    return list(dict.fromkeys(u for u in (urls or []) if isinstance(u, str) and re.match(r"https?://", u)))


def _date(v: Any) -> str | None:
    return v if isinstance(v, str) and _ISO_DATE.match(v) else None


def _price(v: Any) -> str | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f"{f:.2f}" if f > 0 else None


class JsonLdBuilder:
    def __init__(self, kg: KnowledgeGraph, site: str | None = None, organization: str | None = None):
        self.kg = kg
        self.base = _origin(site or kg.site)
        self.host = (urlparse(self.base).hostname or "").removeprefix("www.")
        self.org_id = organization or self._primary_org()
        self.ids: dict[str, str] = {}

    # ---------- helpers ----------
    def _node(self, n: str) -> dict[str, Any]:
        return self.kg.g.nodes[n]

    def _props(self, n: str) -> dict[str, Any]:
        return self._node(n).get("properties") or {}

    def _out(self, n: str, rel: RelationType) -> list[str]:
        return self.kg.neighbors(n, rel)

    def _primary_org(self) -> str | None:
        orgs = [n for n in self.kg.nodes_of_type(EntityType.ORGANIZATION) if not self._props(n).get("placeholder")]
        if not orgs:
            return None

        def rank(n: str) -> tuple[int, int, int]:
            p = self._props(n)
            own = (urlparse(p.get("url") or "").hostname or "").removeprefix("www.") == self.host
            published = len(self.kg.neighbors(n, RelationType.PUBLISHED_BY, direction="in"))
            return (0 if own else 1, -published, -len(self._node(n).get("source_urls") or []))
        return sorted(orgs, key=rank)[0]

    def _id(self, n: str) -> str:
        if n in self.ids:
            return self.ids[n]
        t = self._node(n).get("type")
        p = self._props(n)
        if n == self.org_id:
            i = f"{self.base}#organization"
        elif t == EntityType.PRODUCT.value:
            i = f"{p.get('url') or self.base}#product-{_slug(n)}"
        elif t == EntityType.PAGE.value:
            i = f"{p.get('url') or _slug(n)}#article"
        else:
            i = f"{self.base}#/schema/{(t or 'thing').lower()}/{_slug(n)}"
        self.ids[n] = i
        return i

    def _abs(self, url: Any, base: str | None = None) -> str | None:
        if not isinstance(url, str) or not url.strip():
            return None
        u = urljoin(base or self.base, url.strip())
        return u if re.match(r"https?://", u) else None

    def _same_as(self, n: str) -> list[str]:
        p = self._props(n)
        return _http(p.get("sameAs") or p.get("same_as"))

    def _reconciled_things(self, nodes: list[str], limit: int = 10) -> list[str]:
        return [c for c in nodes if self._node(c).get("type") == EntityType.CONCEPT.value
                and self._props(c).get("wikidataId")][:limit]

    # ---------- node builders ----------
    def website(self) -> dict[str, Any]:
        home = next((n for n in self.kg.nodes_of_type(EntityType.PAGE) if self._props(n).get("page_type") == "home"), None)
        name = (self._node(self.org_id)["label"] if self.org_id else None) or (self._props(home).get("title") if home else None) or self.host
        lang = self._props(home).get("lang") if home else None
        return {"@type": "WebSite", "@id": f"{self.base}#website", "url": self.base, "name": name, "inLanguage": lang,
                "publisher": {"@id": self._id(self.org_id)} if self.org_id else None}

    def organization(self, n: str) -> dict[str, Any]:
        p = self._props(n)
        primary = n == self.org_id
        logo = self._abs(p.get("logo"))
        return {
            "@type": "Organization", "@id": self._id(n), "name": self._node(n)["label"],
            "url": self._abs(p.get("url")) or (self.base if primary else None),
            "logo": {"@type": "ImageObject", "@id": f"{self.base}#logo", "url": logo} if logo and primary
            else ({"@type": "ImageObject", "url": logo} if logo else None),
            "telephone": p.get("telephone"), "address": p.get("address"), "sameAs": self._same_as(n),
        }

    def brand(self, n: str) -> dict[str, Any]:
        return {"@type": "Brand", "@id": self._id(n), "name": self._node(n)["label"], "sameAs": self._same_as(n)}

    def thing(self, n: str) -> dict[str, Any]:
        return {"@type": "Thing", "@id": self._id(n), "name": self._node(n)["label"], "sameAs": self._same_as(n)}

    def person(self, n: str) -> dict[str, Any]:
        p = self._props(n)
        written = self.kg.neighbors(n, RelationType.WRITTEN_BY, direction="in")
        topics = self._reconciled_things([c for a in written for c in self._out(a, RelationType.MENTIONS_ENTITY)])
        employer = set(p.get("employerWikidataIds") or [])
        works_for = self.org_id if self.org_id and self._props(self.org_id).get("wikidataId") in employer else None

        def wd_things(key: str, schema_type: str, **extra: Any) -> list[dict[str, Any]]:
            return [{"@type": schema_type, "name": x["name"], **extra,
                     "sameAs": f"https://www.wikidata.org/wiki/{x['wikidataId']}" if x.get("wikidataId") else None}
                    for x in p.get(key) or [] if isinstance(x, dict) and x.get("name")]

        knows = [{"@id": self._id(c)} for c in dict.fromkeys(topics)] + wd_things("knowsAbout", "Thing")
        return {
            "@type": "Person", "@id": self._id(n), "name": self._node(n)["label"], "url": self._abs(p.get("url")),
            "jobTitle": p.get("job_title"), "sameAs": self._same_as(n), "knowsAbout": knows,
            "alumniOf": wd_things("alumniOf", "EducationalOrganization"),
            "hasCredential": wd_things("hasCredential", "EducationalOccupationalCredential", credentialCategory="degree"),
            "worksFor": {"@id": self._id(works_for)} if works_for else None,
        }

    def offer(self, prod: str) -> dict[str, Any] | None:
        p = self._props(prod)
        url = p.get("url") or self.base
        seller = {"@id": self._id(self.org_id)} if self.org_id else None
        for o in self._out(prod, RelationType.HAS_OFFER) or [None]:
            op = self._props(o) if o else p
            price, currency = _price(op.get("price")), (op.get("currency") or "").upper()
            if not price or not re.fullmatch(r"[A-Z]{3}", currency):
                continue
            availability = AVAILABILITY.get(op.get("availability") or "")
            high = _price(op.get("high_price"))
            if high and float(high) > float(price):
                return {"@type": "AggregateOffer", "lowPrice": price, "highPrice": high, "priceCurrency": currency,
                        "availability": f"https://schema.org/{availability}" if availability else None, "url": url}
            return {"@type": "Offer", "price": price, "priceCurrency": currency, "url": url, "seller": seller,
                    "availability": f"https://schema.org/{availability}" if availability else None}
        return None

    def product(self, n: str) -> dict[str, Any] | None:
        p = self._props(n)
        offer = self.offer(n)
        rating = None
        if p.get("rating") and p.get("review_count") and float(p["review_count"]) > 0:
            rating = {"@type": "AggregateRating", "ratingValue": float(p["rating"]), "reviewCount": int(float(p["review_count"]))}
        if not offer and not rating:
            return None  # Google: Product needs offers, review or aggregateRating
        brand = next(iter(self._out(n, RelationType.HAS_BRAND)), None)
        category = next(iter(self._out(n, RelationType.HAS_CATEGORY)), None)
        return {
            "@type": "Product", "@id": self._id(n), "name": self._node(n)["label"], "url": p.get("url"),
            "sku": p.get("sku"), "description": p.get("description"), "image": self._abs(p.get("image"), p.get("url")),
            "brand": {"@id": self._id(brand)} if brand else None,
            "category": self._node(category)["label"] if category else None,
            "offers": offer, "aggregateRating": rating, "sameAs": self._same_as(n),
        }

    def article(self, page: str, emitted: set[str]) -> dict[str, Any] | None:
        p = self._props(page)
        headline = (p.get("headline") or p.get("h1") or p.get("title") or "").strip()
        authors = [a for a in self._out(page, RelationType.WRITTEN_BY) if a in emitted]
        if not headline or not authors:
            return None
        if len(headline) > HEADLINE_MAX:
            headline = headline[:HEADLINE_MAX - 1].rstrip() + "…"
        publisher = next((o for o in self._out(page, RelationType.PUBLISHED_BY) if o in emitted), self.org_id)
        mentions = self._out(page, RelationType.MENTIONS_ENTITY)
        about = self._reconciled_things(mentions)
        products = [m for m in mentions if m in emitted and self._node(m).get("type") == EntityType.PRODUCT.value]
        return {
            "@type": "Article", "@id": self._id(page), "headline": headline, "url": p.get("url"),
            "mainEntityOfPage": p.get("url"), "inLanguage": p.get("lang"),
            "datePublished": _date(p.get("date_published")), "dateModified": _date(p.get("date_modified")),
            "author": [{"@id": self._id(a)} for a in authors],
            "publisher": {"@id": self._id(publisher)} if publisher else None,
            "isPartOf": {"@id": f"{self.base}#website"},
            "about": [{"@id": self._id(c)} for c in about],
            "mentions": [{"@id": self._id(m)} for m in products],
            "description": p.get("description"),
        }

    # ---------- assembly ----------
    def build(self, include_articles: bool = True, include_products: bool = True) -> dict[str, Any]:
        kg = self.kg
        live = lambda t: [n for n in kg.nodes_of_type(t) if not self._props(n).get("placeholder")]  # noqa: E731
        graph: list[dict[str, Any]] = []
        emitted: set[str] = set()

        def emit(n: str, node: dict[str, Any] | None) -> None:
            if node:
                graph.append(node)
                emitted.add(n)

        for n in live(EntityType.ORGANIZATION):
            emit(n, self.organization(n))
        for n in live(EntityType.PERSON):
            emit(n, self.person(n))
        products = [(n, self.product(n)) for n in live(EntityType.PRODUCT)] if include_products else []
        used_brands = {b for n, node in products if node for b in self._out(n, RelationType.HAS_BRAND)}
        for n in live(EntityType.BRAND):
            if n in used_brands or self._props(n).get("wikidataId"):
                emit(n, self.brand(n))
        for n, node in products:
            emit(n, node)
        for n in live(EntityType.CONCEPT):
            if self._props(n).get("wikidataId"):
                emit(n, self.thing(n))
        if include_articles:
            for n in live(EntityType.PAGE):
                if self._props(n).get("page_type") == "article":
                    emit(n, self.article(n, emitted))
        graph.insert(0, self.website())
        return _clean({"@context": CONTEXT, "@graph": graph})


def build_jsonld(kg: KnowledgeGraph, site: str | None = None, organization: str | None = None,
                 include_articles: bool = True, include_products: bool = True) -> dict[str, Any]:
    """``{"@context": "https://schema.org", "@graph": [...]}`` for the whole site."""
    return JsonLdBuilder(kg, site, organization).build(include_articles, include_products)


# ---------------------------------------------------------------- validation

_REQUIRED: dict[str, list[str]] = {
    "WebSite": ["url", "name"],
    "Organization": ["name"],
    "Person": ["name"],
    "Brand": ["name"],
    "Thing": ["name"],
    "Product": ["name"],
    "Offer": ["price", "priceCurrency"],
    "AggregateOffer": ["lowPrice", "priceCurrency"],
    "AggregateRating": ["ratingValue"],
    "Article": ["headline", "author"],
    "ImageObject": ["url"],
    "EducationalOrganization": ["name"],
    "EducationalOccupationalCredential": ["name"],
}
_URL_KEYS = {"url", "sameAs", "mainEntityOfPage", "image", "availability", "@id"}


def validate_jsonld(doc: dict[str, Any]) -> list[str]:
    """Schema.org + Google rich-result rules. Returns human-readable problems (empty list = valid)."""
    errors: list[str] = []
    if doc.get("@context") != CONTEXT:
        errors.append("@context must be https://schema.org")
    graph = doc.get("@graph")
    if not isinstance(graph, list) or not graph:
        return errors + ["@graph must be a non-empty array"]
    nodes: dict[str, dict[str, Any]] = {}
    for i, node in enumerate(graph):
        nid = node.get("@id") if isinstance(node, dict) else None
        if not nid:
            errors.append(f"@graph[{i}] has no @id")
            continue
        if nid in nodes:
            errors.append(f"duplicate @id {nid}")
        nodes[nid] = node

    def check(obj: Any, path: str) -> None:
        if isinstance(obj, list):
            if not obj:
                errors.append(f"{path}: empty array")
            for j, v in enumerate(obj):
                check(v, f"{path}[{j}]")
            return
        if not isinstance(obj, dict):
            if obj in (None, ""):
                errors.append(f"{path}: empty value")
            return
        if set(obj) == {"@id"}:
            if obj["@id"] not in nodes:
                errors.append(f"{path}: dangling reference {obj['@id']}")
            return
        t = obj.get("@type")
        if not t:
            errors.append(f"{path}: missing @type")
        for key in _REQUIRED.get(t, []):
            if obj.get(key) in (None, "", []):
                errors.append(f"{path}: {t} requires '{key}'")
        if t == "Product" and not any(obj.get(k) for k in ("offers", "aggregateRating", "review")):
            errors.append(f"{path}: Product requires offers, review or aggregateRating")
        if t in ("Offer", "AggregateOffer"):
            cur = obj.get("priceCurrency", "")
            if not re.fullmatch(r"[A-Z]{3}", str(cur)):
                errors.append(f"{path}: priceCurrency must be ISO 4217")
            for k in ("price", "lowPrice", "highPrice"):
                if k in obj and not re.fullmatch(r"\d+(\.\d+)?", str(obj[k])):
                    errors.append(f"{path}: {k} must be a plain number")
            av = obj.get("availability")
            if av and not str(av).startswith("https://schema.org/"):
                errors.append(f"{path}: availability must be a schema.org ItemAvailability URL")
        if t == "AggregateRating" and not (obj.get("reviewCount") or obj.get("ratingCount")):
            errors.append(f"{path}: AggregateRating requires reviewCount or ratingCount")
        if t == "Article":
            if len(str(obj.get("headline", ""))) > HEADLINE_MAX:
                errors.append(f"{path}: headline longer than {HEADLINE_MAX} characters")
            for k in ("datePublished", "dateModified"):
                if k in obj and not _ISO_DATE.match(str(obj[k])):
                    errors.append(f"{path}: {k} must be ISO 8601")
            for a in obj.get("author") or []:
                target = nodes.get(a.get("@id")) if isinstance(a, dict) and set(a) == {"@id"} else a
                if not isinstance(target, dict) or target.get("@type") not in ("Person", "Organization") or not target.get("name"):
                    errors.append(f"{path}: author must be a named Person or Organization")
        for k, v in obj.items():
            if k in _URL_KEYS and k != "@id":
                for u in v if isinstance(v, list) else [v]:
                    if isinstance(u, str) and not re.match(r"https?://", u):
                        errors.append(f"{path}.{k}: '{u}' is not an absolute URL")
            if k == "sameAs" and isinstance(v, list) and len(v) != len(set(v)):
                errors.append(f"{path}.sameAs: duplicate URLs")
            if k not in ("@type", "@id", "@context"):
                check(v, f"{path}.{k}")

    for i, node in enumerate(graph):
        check(node, f"@graph[{i}]")
    return errors
