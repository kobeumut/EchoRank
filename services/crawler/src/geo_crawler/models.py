"""Core data models shared across the crawler, extractor and graph builder."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class PageType(str, Enum):
    HOME = "home"
    PRODUCT = "product"
    SERVICE = "service"
    CATEGORY = "category"
    ARTICLE = "article"
    ABOUT = "about"
    CONTACT = "contact"
    FAQ = "faq"
    OTHER = "other"


class EntityType(str, Enum):
    PAGE = "Page"
    PRODUCT = "Product"
    BRAND = "Brand"
    OFFER = "Offer"
    PERSON = "Person"  # authors
    CATEGORY = "Category"
    QUESTION = "Question"
    ORGANIZATION = "Organization"
    CONCEPT = "Concept"  # keyword / topic


class RelationType(str, Enum):
    HAS_CATEGORY = "has_category"
    CONTAINS_PRODUCT = "contains_product"
    WRITTEN_BY = "written_by"
    MENTIONS_ENTITY = "mentions_entity"
    LINKS_TO = "links_to"
    ANSWERS_QUESTION = "answers_question"
    HAS_BRAND = "has_brand"
    HAS_OFFER = "has_offer"
    PUBLISHED_BY = "published_by"
    RELATED_PRODUCT = "related_product"


@dataclass
class Link:
    url: str
    text: str = ""
    internal: bool = True
    nofollow: bool = False
    in_nav: bool = False  # inside <nav>/<header>/<footer>/<aside> (template link)


@dataclass
class PageData:
    """Everything parsed from a single HTML page."""

    url: str
    status_code: int = 200
    depth: int = 0
    content_type: str = "text/html"
    title: str = ""
    lang: str = ""
    canonical: str = ""
    meta: dict[str, str] = field(default_factory=dict)
    open_graph: dict[str, str] = field(default_factory=dict)
    twitter: dict[str, str] = field(default_factory=dict)
    headings: dict[str, list[str]] = field(default_factory=dict)  # h1..h6
    json_ld: list[dict[str, Any]] = field(default_factory=list)
    microdata: list[dict[str, Any]] = field(default_factory=list)
    text: str = ""
    word_count: int = 0
    internal_links: list[Link] = field(default_factory=list)
    external_links: list[Link] = field(default_factory=list)
    breadcrumbs: list[str] = field(default_factory=list)
    faqs: list[dict[str, str]] = field(default_factory=list)  # HTML-detected Q/A pairs
    from_sitemap: bool = False
    page_type: PageType = PageType.OTHER
    # raw-HTML signals for render / density / trust scoring (see parser._content_stats)
    content_stats: dict[str, Any] = field(default_factory=dict)
    # subset of response headers relevant to auditing (x-robots-tag, hsts, last-modified, ...)
    headers: dict[str, str] = field(default_factory=dict)
    error: str | None = None

    @property
    def has_schema(self) -> bool:
        return bool(self.json_ld or self.microdata)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["page_type"] = self.page_type.value
        d["has_schema"] = self.has_schema
        return d


@dataclass
class Entity:
    id: str
    type: EntityType
    name: str
    properties: dict[str, Any] = field(default_factory=dict)
    source_urls: list[str] = field(default_factory=list)


@dataclass
class Relation:
    source: str
    target: str
    type: RelationType
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class ExtractionResult:
    entities: list[Entity] = field(default_factory=list)
    relations: list[Relation] = field(default_factory=list)


@dataclass
class CrawlResult:
    start_url: str
    pages: dict[str, PageData] = field(default_factory=dict)
    sitemap_urls: set[str] = field(default_factory=set)
    robots_disallowed: list[str] = field(default_factory=list)
    robots_txt: str = ""
    robots_status: int | None = None
    errors: dict[str, str] = field(default_factory=dict)
    started_at: str = ""
    finished_at: str = ""

    @property
    def ok_pages(self) -> list[PageData]:
        return [p for p in self.pages.values() if p.error is None and p.status_code < 400]
