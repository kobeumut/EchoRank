"""Entity + relation extraction from parsed pages.

Sources, in order of trust:
  1. schema.org JSON-LD / microdata (Product, Offer, Brand, Article, Person, FAQPage, Organization, BreadcrumbList, ItemList)
  2. OpenGraph / meta tags (product:price:*, article:author, author)
  3. HTML heuristics (breadcrumbs, <details> FAQs, question headings, keyword concepts)
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from typing import Any, Iterable

from .classifier import PRICE_TEXT, STOCK_TEXT, schema_types
from .keywords import document_terms, extract_keywords
from .models import Entity, EntityType, ExtractionResult, PageData, PageType, Relation, RelationType
from .urls import normalize_url

# ASCII folding of Turkish letters for stable slugs/ids (deliberate: Turkish entity names are first-class input)
_TR_MAP = str.maketrans("çğıöşüÇĞİÖŞÜâîû", "cgiosuCGIOSUaiu")


def slugify(value: str) -> str:
    value = str(value).translate(_TR_MAP)
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return value or hashlib.sha1(str(value).encode()).hexdigest()[:10]


def _text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, dict):
        return _text(v.get("name") or v.get("@id") or v.get("url") or "")
    if isinstance(v, list):
        return _text(v[0]) if v else ""
    return re.sub(r"\s+", " ", str(v)).strip()


def _as_list(v: Any) -> list[Any]:
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def _is(block: dict[str, Any], *names: str) -> bool:
    return any(t in names for t in schema_types([block]))


AVAILABILITY = {
    "instock": "in_stock", "outofstock": "out_of_stock", "preorder": "pre_order",
    "backorder": "back_order", "discontinued": "discontinued", "limitedavailability": "limited",
    "soldout": "out_of_stock", "onlineonly": "in_stock", "instoreonly": "in_stock",
}


def _availability(v: Any) -> str:
    s = _text(v).rsplit("/", 1)[-1].lower().replace("_", "").replace(" ", "")
    return AVAILABILITY.get(s, s or "")


def _price(v: Any) -> float | None:
    s = _text(v)
    if not s:
        return None
    s = re.sub(r"[^\d.,]", "", s)
    if "," in s and "." in s:
        # 1.299,90 (TR/EU) vs 1,299.90 (US)
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".") if len(s.rsplit(",", 1)[-1]) <= 2 else s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


_CURRENCY_SYMBOLS = {"₺": "TRY", "TL": "TRY", "TRY": "TRY", "$": "USD", "USD": "USD", "€": "EUR", "EUR": "EUR", "£": "GBP"}


def _currency(text: str) -> str | None:
    for sym, code in _CURRENCY_SYMBOLS.items():
        if sym in text:
            return code
    return None


class EntityExtractor:
    """Accumulates entities/relations over many pages, merging duplicates by id."""

    def __init__(self, keywords_per_page: int = 6):
        self.keywords_per_page = keywords_per_page
        self.entities: dict[str, Entity] = {}
        self.relations: dict[tuple[str, str, str], Relation] = {}

    # ---------- primitives ----------
    def _entity(self, etype: EntityType, key: str, name: str, source_url: str | None = None, /, **props: Any) -> str:
        prefix = etype.value.lower()
        # pages keep their raw (normalised) URL in the id to avoid slug collisions
        eid = f"page:{key}" if etype is EntityType.PAGE else f"{prefix}:{slugify(key)}"
        ent = self.entities.get(eid)
        if ent is None:
            ent = Entity(id=eid, type=etype, name=name or key)
            self.entities[eid] = ent
        for k, v in props.items():
            if v not in (None, "", [], {}) and k not in ent.properties:
                ent.properties[k] = v
        if source_url and source_url not in ent.source_urls:
            ent.source_urls.append(source_url)
        return eid

    def _rel(self, src: str, dst: str, rtype: RelationType, **props: Any) -> None:
        if src == dst:
            return
        key = (src, dst, rtype.value)
        rel = self.relations.get(key)
        if rel is None:
            self.relations[key] = Relation(src, dst, rtype, {k: v for k, v in props.items() if v is not None})
        elif "weight" in props:
            rel.properties["weight"] = rel.properties.get("weight", 0) + props["weight"]

    # ---------- schema handlers ----------
    def _product(self, block: dict[str, Any], url: str, pid: str) -> str | None:
        name = _text(block.get("name"))
        if not name:
            return None
        sku = _text(block.get("sku") or block.get("mpn") or block.get("gtin13") or block.get("gtin") or block.get("productID"))
        prod_id = self._entity(
            EntityType.PRODUCT, sku or name, name, url,
            sku=sku or None,
            description=_text(block.get("description"))[:500] or None,
            image=_text(block.get("image")) or None,
            url=normalize_url(_text(block.get("url")), url) if block.get("url") else url,
        )
        self._rel(pid, prod_id, RelationType.CONTAINS_PRODUCT)
        for brand in _as_list(block.get("brand")) or _as_list(block.get("manufacturer")):
            bname = _text(brand)
            if bname:
                bid = self._entity(EntityType.BRAND, bname, bname, url)
                self._rel(prod_id, bid, RelationType.HAS_BRAND)
        for cat in _as_list(block.get("category")):
            parts = [p.strip() for p in re.split(r"[>/|]", _text(cat)) if p.strip()]
            parent = None
            for cname in parts:  # "Mutfak > Kahve Makineleri" -> hierarchy
                cid = self._entity(EntityType.CATEGORY, cname, cname, url)
                if parent:
                    self._rel(cid, parent, RelationType.HAS_CATEGORY, hierarchy="parent")
                parent = cid
            if parent:
                self._rel(prod_id, parent, RelationType.HAS_CATEGORY)
        for offer in _as_list(block.get("offers")):
            if not isinstance(offer, dict):
                continue
            if _is(offer, "AggregateOffer"):
                price = _price(offer.get("lowPrice") or offer.get("price"))
                high = _price(offer.get("highPrice"))
            else:
                price, high = _price(offer.get("price")), None
            currency = _text(offer.get("priceCurrency"))
            availability = _availability(offer.get("availability"))
            oid = self._entity(
                EntityType.OFFER, f"{prod_id}-{price}-{currency}", f"{name} offer", url,
                price=price, high_price=high, currency=currency or None, availability=availability or None,
                seller=_text(offer.get("seller")) or None,
            )
            self._rel(prod_id, oid, RelationType.HAS_OFFER)
            ent = self.entities[prod_id]
            ent.properties.setdefault("price", price)
            ent.properties.setdefault("currency", currency or None)
            ent.properties.setdefault("availability", availability or None)
        agg = block.get("aggregateRating")
        if isinstance(agg, dict):
            self.entities[prod_id].properties.setdefault("rating", _price(agg.get("ratingValue")))
            self.entities[prod_id].properties.setdefault("review_count", _price(agg.get("reviewCount") or agg.get("ratingCount")))
        for rel_key in ("isRelatedTo", "isSimilarTo", "isAccessoryOrSparePartFor", "isConsumableFor"):
            for other in _as_list(block.get(rel_key)):
                oname = _text(other)
                if oname:
                    osku = _text(other.get("sku")) if isinstance(other, dict) else ""
                    other_id = self._entity(EntityType.PRODUCT, osku or oname, oname, None)
                    self._rel(prod_id, other_id, RelationType.RELATED_PRODUCT, via=rel_key)
        return prod_id

    def _person(self, v: Any, url: str) -> str | None:
        name = _text(v)
        if not name or name.startswith("http"):
            return None
        props = {}
        if isinstance(v, dict):
            props = {"url": _text(v.get("url")) or None, "job_title": _text(v.get("jobTitle")) or None,
                     "same_as": _as_list(v.get("sameAs")) or None}
        if isinstance(v, dict) and _is(v, "Organization"):
            return self._entity(EntityType.ORGANIZATION, name, name, url, **props)
        return self._entity(EntityType.PERSON, name, name, url, **props)

    def _article(self, block: dict[str, Any], url: str, pid: str) -> None:
        page_ent = self.entities[pid]
        page_ent.properties.setdefault("headline", _text(block.get("headline") or block.get("name")) or None)
        page_ent.properties.setdefault("date_published", _text(block.get("datePublished")) or None)
        page_ent.properties.setdefault("date_modified", _text(block.get("dateModified")) or None)
        for author in _as_list(block.get("author")):
            aid = self._person(author, url)
            if aid:
                self._rel(pid, aid, RelationType.WRITTEN_BY)
        for pub in _as_list(block.get("publisher")):
            name = _text(pub)
            if name:
                oid = self._entity(EntityType.ORGANIZATION, name, name, url)
                self._rel(pid, oid, RelationType.PUBLISHED_BY)
        for sect in _as_list(block.get("articleSection")):
            name = _text(sect)
            if name:
                cid = self._entity(EntityType.CATEGORY, name, name, url)
                self._rel(pid, cid, RelationType.HAS_CATEGORY)
        for m in _as_list(block.get("about")) + _as_list(block.get("mentions")):
            name = _text(m)
            if name:
                cid = self._entity(EntityType.CONCEPT, name, name, url)
                self._rel(pid, cid, RelationType.MENTIONS_ENTITY, source="schema")

    def _question(self, q: str, a: str, url: str, pid: str, source: str) -> None:
        q = _text(q)
        if not q:
            return
        qid = self._entity(EntityType.QUESTION, hashlib.sha1(q.lower().encode()).hexdigest()[:12] + "-" + q[:40], q, url,
                           answer=_text(a)[:2000] or None, source=source)
        self._rel(pid, qid, RelationType.ANSWERS_QUESTION)

    def _faq(self, block: dict[str, Any], url: str, pid: str) -> None:
        for q in _as_list(block.get("mainEntity")):
            if not isinstance(q, dict):
                continue
            ans = q.get("acceptedAnswer") or q.get("suggestedAnswer")
            self._question(_text(q.get("name")), _text(ans.get("text") if isinstance(ans, dict) else ans), url, pid, "schema")

    def _organization(self, block: dict[str, Any], url: str, pid: str) -> None:
        name = _text(block.get("name"))
        if not name:
            return
        oid = self._entity(
            EntityType.ORGANIZATION, name, name, url,
            url=_text(block.get("url")) or None, logo=_text(block.get("logo")) or None,
            same_as=_as_list(block.get("sameAs")) or None, telephone=_text(block.get("telephone")) or None,
            address=_text(block.get("address")) if not isinstance(block.get("address"), dict)
            else ", ".join(filter(None, (_text(block["address"].get(k)) for k in ("streetAddress", "addressLocality", "addressCountry")))) or None,
        )
        self._rel(pid, oid, RelationType.MENTIONS_ENTITY, source="schema")

    def _item_list(self, block: dict[str, Any], url: str, pid: str) -> None:
        for el in _as_list(block.get("itemListElement")):
            if not isinstance(el, dict):
                continue
            item = el.get("item") if isinstance(el.get("item"), dict) else el
            if _is(item, "Product"):
                self._product(item, url, pid)

    def _walk_schema(self, block: dict[str, Any], url: str, pid: str, depth: int = 0) -> None:
        if depth > 4 or not isinstance(block, dict):
            return
        if _is(block, "Product", "ProductGroup", "IndividualProduct"):
            self._product(block, url, pid)
        elif _is(block, "Article", "BlogPosting", "NewsArticle", "TechArticle", "Report"):
            self._article(block, url, pid)
        elif _is(block, "FAQPage"):
            self._faq(block, url, pid)
        elif _is(block, "Question"):
            ans = block.get("acceptedAnswer")
            self._question(_text(block.get("name")), _text(ans.get("text") if isinstance(ans, dict) else ans), url, pid, "schema")
        elif _is(block, "Organization", "LocalBusiness", "Corporation", "Store", "OnlineStore"):
            self._organization(block, url, pid)
        elif _is(block, "ItemList", "OfferCatalog"):
            self._item_list(block, url, pid)
        elif _is(block, "Person"):
            aid = self._person(block, url)
            if aid:
                self._rel(pid, aid, RelationType.MENTIONS_ENTITY, source="schema")
        # WebPage wrappers: descend into mainEntity
        main = block.get("mainEntity")
        if main is not None and not _is(block, "FAQPage"):
            for m in _as_list(main):
                self._walk_schema(m, url, pid, depth + 1)

    # ---------- public API ----------
    def add_page(self, page: PageData, doc_freq: Counter[str] | None = None, n_docs: int = 1) -> str:
        url = page.url
        pid = self._entity(
            EntityType.PAGE, url, page.title or url, url,
            url=url, page_type=page.page_type.value, title=page.title or None,
            description=page.meta.get("description") or page.open_graph.get("description") or None,
            h1=(page.headings.get("h1") or [None])[0], depth=page.depth, word_count=page.word_count,
            has_schema=page.has_schema, schema_types=sorted(set(schema_types(page.json_ld) + schema_types(page.microdata))) or None,
            from_sitemap=page.from_sitemap, status_code=page.status_code, lang=page.lang or None,
            canonical=page.canonical or None,
        )
        for block in page.json_ld + page.microdata:
            self._walk_schema(block, url, pid)

        # OpenGraph product fallback
        if page.page_type is PageType.PRODUCT and not any(
            r.type is RelationType.CONTAINS_PRODUCT for (s, _, _), r in self.relations.items() if s == pid
        ):
            name = page.open_graph.get("title") or (page.headings.get("h1") or [page.title])[0]
            if name:
                fake = {
                    "@type": "Product", "name": name,
                    "brand": page.open_graph.get("brand") or page.meta.get("product:brand") or page.open_graph.get("product:brand"),
                    "offers": {
                        "price": page.open_graph.get("price:amount") or page.meta.get("product:price:amount") or page.open_graph.get("product:price:amount"),
                        "priceCurrency": page.open_graph.get("price:currency") or page.meta.get("product:price:currency") or page.open_graph.get("product:price:currency"),
                        "availability": page.open_graph.get("availability") or page.meta.get("product:availability") or page.open_graph.get("product:availability"),
                    },
                }
                if not fake["offers"]["price"]:
                    m = PRICE_TEXT.search(page.text[:5000])
                    if m:
                        fake["offers"]["price"] = m.group(0)
                        fake["offers"]["priceCurrency"] = _currency(m.group(0))
                        st = STOCK_TEXT.search(page.text[:5000])
                        if st and not fake["offers"]["availability"]:
                            # "yok" / "tükendi" = Turkish for "none" / "sold out" (Turkish storefronts)
                            fake["offers"]["availability"] = "OutOfStock" if re.search(r"out of|yok|tükendi", st.group(0), re.I) else "InStock"
                    else:
                        fake.pop("offers")
                self._product(fake, url, pid)

        # author fallback
        author = page.meta.get("author") or page.meta.get("article:author") or page.open_graph.get("article:author")
        if author and page.page_type is PageType.ARTICLE:
            aid = self._person(author, url)
            if aid:
                self._rel(pid, aid, RelationType.WRITTEN_BY)

        # breadcrumbs -> categories (skip home crumb and the page itself)
        crumbs = [c for c in page.breadcrumbs if c.lower() not in ("home", "anasayfa", "ana sayfa")]
        own = {(page.headings.get("h1") or [""])[0].lower(), page.title.lower()}
        # a category page *is* its last crumb; any other page drops its own crumb
        if page.page_type is not PageType.CATEGORY:
            crumbs = [c for c in crumbs if c.lower() not in own]
        prev = None
        for c in crumbs:
            cid = self._entity(EntityType.CATEGORY, c, c, url)
            if prev:
                self._rel(cid, prev, RelationType.HAS_CATEGORY, hierarchy="parent")
            prev = cid
        if prev:
            self._rel(pid, prev, RelationType.HAS_CATEGORY)
            for (s, d, t), r in list(self.relations.items()):
                if s == pid and t == RelationType.CONTAINS_PRODUCT.value and page.page_type is PageType.PRODUCT:
                    self._rel(d, prev, RelationType.HAS_CATEGORY)
            if page.page_type is PageType.CATEGORY:
                self.entities[prev].properties.setdefault("url", url)

        # HTML FAQs
        for qa in page.faqs:
            self._question(qa["question"], qa["answer"], url, pid, "html")

        # keyword concepts
        headings = [h for hs in page.headings.values() for h in hs]
        for term, score in extract_keywords(page.title, headings, page.text, self.keywords_per_page, doc_freq, n_docs):
            cid = self._entity(EntityType.CONCEPT, term, term, url)
            self._rel(pid, cid, RelationType.MENTIONS_ENTITY, source="keyword", weight=score)
        return pid

    def link_pages(self, pages: Iterable[PageData]) -> None:
        known = {p.url for p in pages}
        for p in pages:
            for link in p.internal_links:
                if link.url in known:
                    self._rel(page_id(p.url), page_id(link.url), RelationType.LINKS_TO,
                              anchor=link.text or None, nofollow=link.nofollow or None)

    def link_mentions(self, pages: Iterable[PageData]) -> None:
        """page -> mentions_entity -> product/brand when the name appears in page text."""
        named = [
            (eid, e.name.lower()) for eid, e in self.entities.items()
            if e.type in (EntityType.PRODUCT, EntityType.BRAND) and len(e.name) >= 4
        ]
        if not named:
            return
        for p in pages:
            text = p.text.lower()
            pid = page_id(p.url)
            for eid, name in named:
                if p.url in self.entities[eid].source_urls:
                    continue
                if name in text:
                    self._rel(pid, eid, RelationType.MENTIONS_ENTITY, source="text")

    def link_related_products(self, pages: Iterable[PageData]) -> None:
        """Product page linking to another product page => related_product."""
        prod_of: dict[str, list[str]] = {}
        for (s, d, t) in self.relations:
            if t == RelationType.CONTAINS_PRODUCT.value:
                prod_of.setdefault(s, []).append(d)
        by_url = {p.url: p for p in pages}
        for p in by_url.values():
            if p.page_type is not PageType.PRODUCT:
                continue
            src_prods = prod_of.get(page_id(p.url), [])
            for link in p.internal_links:
                target = by_url.get(link.url)
                if target is None or target.page_type is not PageType.PRODUCT:
                    continue
                for a in src_prods:
                    for b in prod_of.get(page_id(target.url), []):
                        self._rel(a, b, RelationType.RELATED_PRODUCT, via="link")

    def result(self) -> ExtractionResult:
        return ExtractionResult(list(self.entities.values()), list(self.relations.values()))


def page_id(url: str) -> str:
    return f"page:{url}"


def extract_entities(pages: list[PageData], keywords_per_page: int = 6) -> ExtractionResult:
    ok = [p for p in pages if p.error is None]
    doc_freq: Counter[str] = Counter()
    for p in ok:
        doc_freq.update(document_terms(p.title, [h for hs in p.headings.values() for h in hs], p.text))
    ex = EntityExtractor(keywords_per_page)
    for p in ok:
        ex.add_page(p, doc_freq, len(ok))
    ex.link_pages(ok)
    ex.link_related_products(ok)
    ex.link_mentions(ok)
    return ex.result()
