"""Schema.org JSON-LD / microdata completeness & validity rules (Google rich-result requirements, simplified)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..models import PageData

# type family -> (required props, recommended props). "a|b" = any of; "x.y" = nested path.
RULES: dict[str, tuple[list[str], list[str]]] = {
    "Product": (["name", "offers|review|aggregateRating"],
                ["image", "description", "sku", "brand", "offers.price|offers.lowPrice", "offers.priceCurrency",
                 "offers.availability", "gtin|gtin13|gtin8|mpn", "aggregateRating"]),
    "Organization": (["name", "url"], ["logo", "sameAs", "contactPoint|telephone", "address", "description"]),
    "LocalBusiness": (["name", "address"], ["telephone", "url", "openingHoursSpecification|openingHours", "geo",
                                            "image", "priceRange"]),
    "FAQPage": (["mainEntity"], []),
    "Article": (["headline"], ["author", "author.name", "datePublished", "dateModified", "image", "publisher",
                               "author.url|author.sameAs"]),
    "BreadcrumbList": (["itemListElement"], []),
    "WebSite": (["url"], ["name", "potentialAction"]),
}

FAMILIES: dict[str, str] = {
    "Product": "Product", "ProductGroup": "Product", "IndividualProduct": "Product",
    "Organization": "Organization", "Corporation": "Organization", "OnlineStore": "Organization",
    "NGO": "Organization", "EducationalOrganization": "Organization",
    "LocalBusiness": "LocalBusiness", "Store": "LocalBusiness", "Restaurant": "LocalBusiness",
    "MedicalBusiness": "LocalBusiness", "ProfessionalService": "LocalBusiness",
    "FAQPage": "FAQPage",
    "Article": "Article", "BlogPosting": "Article", "NewsArticle": "Article", "TechArticle": "Article",
    "BreadcrumbList": "BreadcrumbList",
    "WebSite": "WebSite",
}


def types_of(block: dict[str, Any]) -> list[str]:
    t = block.get("@type")
    return [x.rsplit("/", 1)[-1] for x in (t if isinstance(t, list) else [t]) if isinstance(x, str)]


def _present(v: Any) -> bool:
    if v is None:
        return False
    if isinstance(v, str):
        return bool(v.strip())
    if isinstance(v, (list, dict)):
        return bool(v)
    return True


def get_path(block: Any, path: str) -> list[Any]:
    cur = [block]
    for part in path.split("."):
        nxt = []
        for c in cur:
            for item in c if isinstance(c, list) else [c]:
                if isinstance(item, dict) and _present(item.get(part)):
                    v = item[part]
                    nxt.extend(v if isinstance(v, list) else [v])
        cur = nxt
    return cur


def has(block: dict[str, Any], spec: str) -> bool:
    return any(get_path(block, alt) for alt in spec.split("|"))


@dataclass
class SchemaValidation:
    url: str
    type: str
    family: str
    missing_required: list[str] = field(default_factory=list)
    missing_recommended: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    score: float = 100.0

    def to_dict(self) -> dict[str, Any]:
        return {"url": self.url, "type": self.type, "family": self.family, "score": round(self.score),
                "missing_required": self.missing_required, "missing_recommended": self.missing_recommended,
                "errors": self.errors}


def _extra_errors(family: str, block: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    if family == "FAQPage":
        qs = [q for q in get_path(block, "mainEntity") if isinstance(q, dict)]
        bad = [q for q in qs if not (_present(q.get("name")) and has(q, "acceptedAnswer.text"))]
        if bad:
            errs.append(f"{len(bad)}/{len(qs)} Question öğesinde name veya acceptedAnswer.text eksik")
    elif family == "BreadcrumbList":
        items = [i for i in get_path(block, "itemListElement") if isinstance(i, dict)]
        if any(not _present(i.get("position")) for i in items):
            errs.append("ListItem öğelerinde position eksik")
        if any(not (_present(i.get("name")) or has(i, "item.name")) for i in items):
            errs.append("ListItem öğelerinde name eksik")
    elif family == "Product":
        for offer in get_path(block, "offers"):
            if isinstance(offer, dict) and _present(offer.get("price")):
                raw = str(offer["price"])
                if "," in raw and "." in raw or any(c.isalpha() for c in raw):
                    errs.append(f"offers.price '{raw}' sayısal değil (örn. 12499.90 olmalı)")
    return errs


def validate_block(block: dict[str, Any], url: str) -> SchemaValidation | None:
    for t in types_of(block):
        family = FAMILIES.get(t)
        if not family:
            continue
        required, recommended = RULES[family]
        v = SchemaValidation(url=url, type=t, family=family)
        v.missing_required = [r for r in required if not has(block, r)]
        v.missing_recommended = [r for r in recommended if not has(block, r)]
        v.errors = _extra_errors(family, block)
        req_ratio = 1 - len(v.missing_required) / len(required) if required else 1.0
        rec_ratio = 1 - len(v.missing_recommended) / len(recommended) if recommended else 1.0
        v.score = max(0.0, 60 * req_ratio + 40 * rec_ratio - 15 * len(v.errors))
        if v.missing_required:
            v.score = min(v.score, 50.0)
        return v
    return None


def page_schema_nodes(page: PageData) -> list[dict[str, Any]]:
    """Top-level JSON-LD/microdata nodes plus typed nested nodes (e.g. Organization inside WebPage.publisher)."""
    out: list[dict[str, Any]] = []

    def walk(node: Any, depth: int) -> None:
        if depth > 4:
            return
        if isinstance(node, list):
            for n in node:
                walk(n, depth)
        elif isinstance(node, dict):
            if types_of(node):
                out.append(node)
            for k, v in node.items():
                if not k.startswith("@") and isinstance(v, (dict, list)):
                    walk(v, depth + 1)

    walk(page.json_ld, 0)
    walk(page.microdata, 0)
    return out


def page_families(page: PageData) -> set[str]:
    return {FAMILIES[t] for n in page_schema_nodes(page) for t in types_of(n) if t in FAMILIES}


def validate_page(page: PageData) -> list[SchemaValidation]:
    """Validates top-level nodes only (nested Organization-as-publisher is not expected to be complete)."""
    out = []
    for block in [*page.json_ld, *page.microdata]:
        if isinstance(block, dict) and (v := validate_block(block, page.url)):
            out.append(v)
    return out
