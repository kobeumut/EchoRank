"""Knowledge graph built from the Turkish sample site (UTF-8 content must survive the export unescaped)."""
import json

from fixtures import BASE

from geo_crawler import KnowledgeGraph
from geo_crawler.extractor import page_id
from geo_crawler.models import EntityType, RelationType


def node(kg, nid):
    return kg.g.nodes[nid]


async def test_entities_extracted(indexed):
    kg = indexed.graph
    products = {node(kg, n)["label"] for n in kg.nodes_of_type(EntityType.PRODUCT)}
    assert {"Barista Pro X", "Mini Espresso", "Filtre Klasik"} <= products
    bpx = node(kg, "product:bpx-100")["properties"]
    assert bpx["price"] == 12499.90 and bpx["currency"] == "TRY" and bpx["availability"] == "in_stock"
    assert bpx["rating"] == 4.7
    me = node(kg, "product:me-20")["properties"]
    assert me["price"] == 3999.0 and me["availability"] == "out_of_stock"
    fk = [n for n in kg.nodes_of_type(EntityType.PRODUCT) if node(kg, n)["label"] == "Filtre Klasik"][0]
    assert node(kg, fk)["properties"]["price"] == 1499.0  # OpenGraph fallback
    assert "brand:brevio" in kg.nodes_of_type(EntityType.BRAND)
    assert "person:ayse-yilmaz" in kg.nodes_of_type(EntityType.PERSON)
    assert "organization:kahve-dukkani-a-s" in kg.nodes_of_type(EntityType.ORGANIZATION)
    questions = {node(kg, n)["label"] for n in kg.nodes_of_type(EntityType.QUESTION)}
    assert {"Kargo ücretsiz mi?", "Garanti süresi nedir?", "Ne zaman kurulduk?"} <= questions
    cats = {node(kg, n)["label"] for n in kg.nodes_of_type(EntityType.CATEGORY)}
    assert {"Kahve Makineleri", "Mutfak", "Rehberler"} <= cats
    assert kg.nodes_of_type(EntityType.CONCEPT)


async def test_required_relations(indexed):
    kg = indexed.graph
    types = set(kg.stats()["edges_by_type"])
    for rel in ("has_category", "contains_product", "written_by", "mentions_entity", "links_to", "answers_question"):
        assert rel in types, rel
    blog = page_id(BASE + "/blog/espresso-rehberi")
    assert kg.neighbors(blog, RelationType.WRITTEN_BY) == ["person:ayse-yilmaz"]
    assert "product:bpx-100" in kg.neighbors(blog, RelationType.MENTIONS_ENTITY)  # text mention
    assert "brand:brevio" in kg.neighbors("product:bpx-100", RelationType.HAS_BRAND)
    assert "category:kahve-makineleri" in kg.neighbors("product:bpx-100", RelationType.HAS_CATEGORY)
    assert "category:mutfak" in kg.neighbors("category:kahve-makineleri", RelationType.HAS_CATEGORY)
    assert "product:me-20" in kg.neighbors("product:bpx-100", RelationType.RELATED_PRODUCT)
    assert page_id(BASE + "/urun/barista-pro-x") in kg.neighbors(page_id(BASE + "/"), RelationType.LINKS_TO)
    assert kg.neighbors(page_id(BASE + "/sss"), RelationType.ANSWERS_QUESTION)


async def test_export_roundtrip(indexed, tmp_path):
    out = tmp_path / "graph.json"
    text = indexed.export_graph_json(out)
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data == json.loads(text)
    assert data["schema_version"] == "1.0" and data["site"] == BASE + "/"
    assert data["stats"]["node_count"] == len(data["nodes"])
    assert data["stats"]["edge_count"] == len(data["edges"])
    ids = {n["id"] for n in data["nodes"]}
    assert all(e["source"] in ids and e["target"] in ids for e in data["edges"])
    assert "Kahve Dükkanı" in text  # UTF-8 preserved, not escaped
    home = next(n for n in data["nodes"] if n["id"] == page_id(BASE + "/"))
    assert home["properties"]["page_type"] == "home" and home["properties"]["pagerank"] > 0
    assert "gaps" in data
    kg2 = KnowledgeGraph.from_dict(data)
    assert kg2.stats() == indexed.graph.stats()
    graphml = tmp_path / "g.graphml"
    indexed.graph.to_graphml(graphml)
    assert graphml.stat().st_size > 0
    assert indexed.graph.to_node_link()["nodes"]


async def test_gaps(indexed):
    gaps = indexed.gaps
    assert BASE + "/kampanya-gizli" in gaps["orphan_pages"]
    assert BASE + "/" not in gaps["orphan_pages"]
    assert BASE + "/urun/mini-espresso" not in gaps["orphan_pages"]
    assert BASE + "/hakkimizda" in gaps["pages_without_schema"]
    missing = {m["url"] for m in gaps["pages_missing_expected_schema"]}
    assert BASE + "/urun/filtre-klasik" in missing  # OG-only product
    assert BASE + "/urun/barista-pro-x" not in missing
    filtre = [n for n in indexed.graph.nodes_of_type(EntityType.PRODUCT)
              if indexed.graph.g.nodes[n]["label"] == "Filtre Klasik"][0]
    assert filtre in gaps["products_without_related"]
    assert "product:bpx-100" not in gaps["products_without_related"]
    assert BASE + "/urun/filtre-klasik" in gaps["thin_content_pages"]
    assert BASE + "/urun/filtre-klasik" in gaps["multiple_h1"]
    assert BASE + "/urun/mini-espresso" in gaps["sitemap_missing_pages"]
    assert any(b["url"] == BASE + "/kirik-sayfa" for b in gaps["broken_pages"])
    s = gaps["summary"]
    assert 0 < s["schema_coverage"] < 1 and s["site_has_faq_content"] and s["site_has_organization_schema"]


async def test_crawl_summary(indexed):
    s = indexed.crawl_summary()
    assert s["pages_crawled"] >= 10 and s["page_types"]["product"] == 3


async def test_db_records(indexed):
    rec = indexed.to_db_records()
    keys = {e["key"] for e in rec["graphEntities"]}
    assert len(keys) == len(rec["graphEntities"])  # unique per site
    assert all(r["sourceKey"] in keys and r["targetKey"] in keys for r in rec["graphRelations"])
    triples = [(r["sourceKey"], r["targetKey"], r["relationType"]) for r in rec["graphRelations"]]
    assert len(triples) == len(set(triples))  # matches @@unique([sourceId, targetId, relationType])
    home = next(p for p in rec["crawledPages"] if p["url"] == BASE + "/")
    assert home["pageType"] == "home" and home["metaDescription"] and home["h1"] == "Kahve Dükkanı"
    assert rec["crawlSession"]["status"] == "completed" and rec["crawlSession"]["pagesCrawled"] >= 10
    json.dumps(rec, default=str)
