"""geo_crawler — async site crawler, entity extraction and knowledge-graph (graphify) engine."""
from .crawler import CrawlConfig, SiteCrawler, crawl_site
from .extractor import EntityExtractor, extract_entities
from .gaps import detect_gaps
from .graph import KnowledgeGraph
from .models import CrawlResult, Entity, EntityType, PageData, PageType, Relation, RelationType
from .parser import parse_html
from .pipeline import IndexResult, build_index, index_site

__all__ = [
    "CrawlConfig", "SiteCrawler", "crawl_site", "EntityExtractor", "extract_entities", "detect_gaps",
    "KnowledgeGraph", "CrawlResult", "Entity", "EntityType", "PageData", "PageType", "Relation",
    "RelationType", "parse_html", "IndexResult", "build_index", "index_site",
]
__version__ = "0.1.0"
