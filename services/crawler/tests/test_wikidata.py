import json

import httpx
import pytest
from fixtures import BASE
from wikidata_fixtures import ENTITIES, FakeWikidata

from geo_crawler import KnowledgeGraph, build_jsonld, validate_jsonld
from geo_crawler.extractor import page_id
from geo_crawler.models import EntityType, RelationType
from geo_crawler.reconcile_cli import main as reconcile_main
from geo_crawler.wikidata import (
    USER_AGENT, Candidate, EntityContext, EntityReconciler, WikidataClient, apply_result, candidate_from_entity,
    link_shared_identities, name_similarity, reconcile_graph, score_candidate,
)

ORG, BRAND, PERSON = "organization:kahve-dukkani-a-s", "brand:brevio", "person:ayse-yilmaz"


def client(fake: FakeWikidata, **kw) -> WikidataClient:
    return WikidataClient(httpx.AsyncClient(transport=fake.transport()), **kw)


@pytest.fixture
async def reconciled(indexed):
    # an Article "about" concept (schema-sourced) must be reconciled ahead of the many keyword bigrams
    kg = indexed.graph
    kg.add_node("concept:espresso", "Concept", "espresso", {}, [BASE + "/blog/espresso-rehberi"])
    kg.add_edge(page_id(BASE + "/blog/espresso-rehberi"), "concept:espresso", "mentions_entity", {"source": "schema"})
    fake = FakeWikidata()
    async with client(fake) as c:
        summary = await reconcile_graph(kg, c, max_concepts=5)
    return indexed, summary, fake


def props(kg, n):
    return kg.g.nodes[n]["properties"]


# ---------------------------------------------------------------- matching


def test_name_similarity_folds_turkish_and_legal_suffixes():
    assert name_similarity("Kahve Dükkanı A.Ş.", ["KAHVE DUKKANI"]) == 1.0
    assert name_similarity("Ayşe Yılmaz", ["Ayse Yilmaz"]) == 1.0
    # containment is penalised by the extra words: "Apple" must not auto-match "Apple Records"
    assert 0.4 < name_similarity("Brevio", ["Brevio Kahve Makineleri"]) < name_similarity("Brevio", ["Brevio Kahve"]) < 1.0
    assert name_similarity("Brevio", ["Nespresso"]) < 0.5


async def test_organization_matched_by_official_website(reconciled):
    indexed, summary, fake = reconciled
    p = props(indexed.graph, ORG)
    assert p["wikidataId"] == "Q1001" and p["confidence"] >= 0.97
    assert p["reconciliation"]["status"] == "matched" and p["reconciliation"]["method"] == "wikidata_search"
    assert p["wikipediaUrl"] == "https://tr.wikipedia.org/wiki/Kahve_Dükkanı"
    # Wikidata, Wikipedia, LinkedIn, Crunchbase first; the site's own declared profile kept
    assert p["sameAs"][:4] == [
        "https://www.wikidata.org/wiki/Q1001", "https://tr.wikipedia.org/wiki/Kahve_Dükkanı",
        "https://www.linkedin.com/company/kahve-dukkani", "https://www.crunchbase.com/organization/kahve-dukkani",
    ]
    assert "https://instagram.com/kahve" in p["sameAs"] and "https://x.com/kahvedukkani" in p["sameAs"]
    # the disambiguation page ranked first by search is rejected
    cands = {c["qid"]: c for c in p["reconciliation"]["candidates"]}
    assert cands["Q1002"]["score"] < 0.3 and cands["Q1002"]["signals"]["type"] == 0.0
    assert USER_AGENT in fake.user_agents


async def test_brand_matched_with_sector_context(reconciled):
    indexed, *_ = reconciled
    p = props(indexed.graph, BRAND)
    assert p["wikidataId"] == "Q2001" and p["reconciliation"]["status"] == "matched"
    assert p["reconciliation"]["candidates"][0]["signals"]["context"] > 0  # "kahve" in description


async def test_person_disambiguated_by_employer_and_enriched(reconciled):
    indexed, *_ = reconciled
    p = props(indexed.graph, PERSON)
    # search ranks the unrelated actress first; employer (P108 = matched org Q1001) + context pick the barista
    assert p["wikidataId"] == "Q3001"
    assert p["alumniOf"] == [{"name": "Boğaziçi Üniversitesi", "wikidataId": "Q4001"}]
    assert p["knowsAbout"] == [{"name": "kahve", "wikidataId": "Q4002"}]
    assert p["hasCredential"] == [{"name": "lisans derecesi", "wikidataId": "Q4003"}]
    assert "https://www.linkedin.com/in/ayse-yilmaz" in p["sameAs"]
    assert "https://orcid.org/0000-0002-1825-0097" in p["sameAs"]


async def test_uncorroborated_person_goes_to_review_not_sameas():
    fake = FakeWikidata()
    async with client(fake) as c:
        res = await EntityReconciler(c).reconcile(
            "person:ayse-yilmaz", EntityContext("Ayşe Yılmaz", EntityType.PERSON, lang="tr"))
    assert res.status == "review" and res.qid is None and res.same_as == []
    assert res.confidence <= 0.7


async def test_unknown_product_falls_back_to_wikipedia_suggestion(reconciled):
    indexed, *_ = reconciled
    p = props(indexed.graph, "product:bpx-100")
    rec = p["reconciliation"]
    assert rec["status"] == "review" and rec["method"] == "wikipedia"
    assert rec["suggested"]["wikipediaUrl"] == "https://tr.wikipedia.org/wiki/Barista_Pro_X"
    assert "wikidataId" not in p and "sameAs" not in p  # suggestions are never published


async def test_sparql_subclass_closure_and_graceful_failure():
    ctx = EntityContext("Mini Espresso", EntityType.PRODUCT, lang="tr")
    for fake, expected_type in ((FakeWikidata(), 1.0), (FakeWikidata(sparql_status=503), 0.4)):
        async with client(fake) as c:
            res = await EntityReconciler(c).reconcile("product:me-20", ctx)
        assert "sparql" in fake.calls
        assert res.candidates[0]["signals"]["type"] == expected_type
    assert res.status in ("review", "matched", "unmatched")  # degraded, but no exception


async def test_concepts_and_unmatched(reconciled):
    indexed, summary, _ = reconciled
    kg = indexed.graph
    assert props(kg, "concept:espresso")["wikidataId"] == "Q5001"
    reconciled_concepts = [n for n in kg.nodes_of_type(EntityType.CONCEPT) if "reconciliation" in props(kg, n)]
    assert len(reconciled_concepts) == 5  # max_concepts bounds the API calls
    assert summary["by_status"]["matched"] >= 4
    assert summary["by_status"].get("unmatched", 0) >= 1
    assert all(r["wikidataId"] is None for r in summary["results"] if r["status"] != "matched")


async def test_declared_wikidata_same_as_is_trusted():
    fake = FakeWikidata()
    async with client(fake) as c:
        res = await EntityReconciler(c).reconcile("organization:x", EntityContext(
            "Whatever", EntityType.ORGANIZATION, declared_same_as=["https://www.wikidata.org/wiki/Q1001"]))
    assert res.status == "declared" and res.qid == "Q1001" and res.confidence == 1.0
    assert not any(c.startswith("wbsearchentities") for c in fake.calls)


async def test_wikipedia_linked_item_and_crunchbase_fallbacks():
    fake = FakeWikidata()
    async with client(fake, crunchbase_key="cb-test") as c:
        r = EntityReconciler(c)
        wiki = await r.reconcile("organization:fkd", EntityContext("Filtre Kahve Derneği", EntityType.ORGANIZATION,
                                                                  lang="tr", context_terms={"kahve"}))
        cb = await r.reconcile("organization:moka", EntityContext("Moka House", EntityType.ORGANIZATION, lang="tr"))
        none = await r.reconcile("brand:nope", EntityContext("Nope Brand", EntityType.BRAND, lang="tr"))
    assert wiki.method == "wikipedia" and wiki.status == "matched" and wiki.qid == "Q7001"
    assert cb.method == "crunchbase" and cb.status == "review" and cb.same_as == ["https://www.crunchbase.com/organization/moka-house"]
    assert none.status == "unmatched" and none.method == "none"


def test_scoring_rules():
    lang = "tr"
    actress = candidate_from_entity(ENTITIES["Q3002"], lang, 0)
    barista = candidate_from_entity(ENTITIES["Q3001"], lang, 1)
    ctx = EntityContext("Ayşe Yılmaz", EntityType.PERSON, lang=lang, org_qids={"Q1001"})
    assert score_candidate(ctx, barista) >= 0.8 > score_candidate(ctx, actress)
    # a brand is never a human
    human = Candidate("Q9", "Brevio", instance_of=["Q5"])
    assert score_candidate(EntityContext("Brevio", EntityType.BRAND), human) < 0.3


def test_downgraded_match_clears_published_facts():
    from geo_crawler.wikidata import ReconciliationResult
    kg = KnowledgeGraph("https://shop.example.com/")
    kg.add_node(PERSON, "Person", "Ayşe Yılmaz", {"same_as": ["https://ayse.example"]})
    apply_result(kg, ReconciliationResult(PERSON, "matched", "wikidata_search", 0.9, "Q3001", "Ayşe", None,
                                          ["https://www.wikidata.org/wiki/Q3001"], person={"alumniOf": [{"name": "X"}]}))
    assert props(kg, PERSON)["alumniOf"]
    apply_result(kg, ReconciliationResult(PERSON, "review", "wikidata_search", 0.6))
    p = props(kg, PERSON)
    assert "alumniOf" not in p and "wikidataId" not in p and p["sameAs"] == ["https://ayse.example"]


def test_shared_identity_and_apply_result_idempotent():
    kg = KnowledgeGraph("https://shop.example.com/")
    kg.add_node("brand:kd", "Brand", "Kahve Dükkanı", {"wikidataId": "Q1001"})
    kg.add_node("organization:kd", "Organization", "Kahve Dükkanı A.Ş.", {"wikidataId": "Q1001"})
    assert link_shared_identities(kg) == 1
    assert link_shared_identities(kg) == 0
    assert kg.neighbors("brand:kd", RelationType.SAME_AS) == ["organization:kd"]


async def test_graph_export_and_db_records(reconciled):
    indexed, *_ = reconciled
    kg = indexed.graph
    assert kg.neighbors(ORG, RelationType.SAME_AS) == ["wikidata:Q1001"]
    assert kg.g.nodes["wikidata:Q1001"]["type"] == "WikidataEntity"
    data = json.loads(indexed.export_graph_json())
    assert data["stats"]["edges_by_type"]["same_as"] >= 4
    rows = indexed.to_db_records()
    org = next(e for e in rows["graphEntities"] if e["key"] == ORG)
    assert org["properties"]["wikidataId"] == "Q1001" and org["properties"]["confidence"] >= 0.97
    assert any(r["relationType"] == "same_as" and r["sourceKey"] == ORG for r in rows["graphRelations"])
    # reconciliation can run again on the same graph without duplicating edges
    before = kg.g.number_of_edges()
    async with client(FakeWikidata()) as c:
        await reconcile_graph(kg, c, max_concepts=5)
    assert kg.g.number_of_edges() == before


# ---------------------------------------------------------------- JSON-LD


async def test_jsonld_graph_is_connected_and_valid(reconciled):
    indexed, *_ = reconciled
    doc = build_jsonld(indexed.graph)
    assert validate_jsonld(doc) == []
    assert doc["@context"] == "https://schema.org"
    by_id = {n["@id"]: n for n in doc["@graph"]}
    site = by_id[BASE + "/#website"]
    org = by_id[BASE + "/#organization"]
    assert site["publisher"] == {"@id": org["@id"]}
    assert org["name"] == "Kahve Dükkanı A.Ş." and org["sameAs"][0] == "https://www.wikidata.org/wiki/Q1001"
    person = next(n for n in doc["@graph"] if n["@type"] == "Person")
    assert person["jobTitle"] == "Barista" and person["worksFor"] == {"@id": org["@id"]}
    assert {"@type": "EducationalOrganization", "name": "Boğaziçi Üniversitesi",
            "sameAs": "https://www.wikidata.org/wiki/Q4001"} in person["alumniOf"]
    assert person["hasCredential"][0]["@type"] == "EducationalOccupationalCredential"
    assert any(k.get("name") == "kahve" for k in person["knowsAbout"])
    thing = by_id[BASE + "/#/schema/concept/espresso"]
    assert thing["@type"] == "Thing" and thing["sameAs"][0] == "https://www.wikidata.org/wiki/Q5001"
    assert {"@id": thing["@id"]} in person["knowsAbout"]  # topics of the articles they wrote
    article = by_id[BASE + "/blog/espresso-rehberi#article"]
    assert article["author"] == [{"@id": person["@id"]}] and article["publisher"] == {"@id": org["@id"]}
    assert article["isPartOf"] == {"@id": site["@id"]}
    assert article["about"] == [{"@id": thing["@id"]}]
    product = next(n for n in doc["@graph"] if n["@type"] == "Product" and n["name"] == "Barista Pro X")
    assert product["offers"]["price"] == "12499.90" and product["offers"]["priceCurrency"] == "TRY"
    assert product["offers"]["availability"] == "https://schema.org/InStock"
    assert by_id[product["brand"]["@id"]]["sameAs"][0] == "https://www.wikidata.org/wiki/Q2001"


async def test_jsonld_without_reconciliation_still_valid(indexed):
    doc = build_jsonld(indexed.graph)
    assert validate_jsonld(doc) == []
    assert not any(n["@type"] == "Thing" for n in doc["@graph"])  # only reconciled concepts become nodes


def test_validator_rejects_broken_documents():
    bad = {"@context": "https://schema.org", "@graph": [
        {"@type": "Organization", "@id": "https://x.test/#org", "name": "X", "sameAs": ["wikidata.org/wiki/Q1", "https://a.test", "https://a.test"]},
        {"@type": "Product", "@id": "https://x.test/p#product", "name": "P"},
        {"@type": "Product", "@id": "https://x.test/q#product", "name": "Q",
         "offers": {"@type": "Offer", "price": "1.299,90", "priceCurrency": "TL", "availability": "InStock"}},
        {"@type": "Article", "@id": "https://x.test/a#article", "headline": "h" * 120, "author": [{"@id": "https://x.test/#nobody"}],
         "datePublished": "8 Kasım 2026"},
    ]}
    errors = "\n".join(validate_jsonld(bad))
    for expected in ("not an absolute URL", "duplicate URLs", "Product requires offers", "priceCurrency must be ISO 4217",
                     "price must be a plain number", "ItemAvailability", "headline longer", "dangling reference",
                     "datePublished must be ISO 8601"):
        assert expected in errors, expected
    assert validate_jsonld({"@context": "http://schema.org", "@graph": []})


def test_reconcile_cli(tmp_path, monkeypatch):
    kg = KnowledgeGraph("https://shop.example.com/")
    kg.add_node(page_id("https://shop.example.com/"), "Page", "Anasayfa", {"page_type": "home", "lang": "tr", "url": "https://shop.example.com/"})
    kg.add_node(ORG, "Organization", "Kahve Dükkanı A.Ş.", {"url": "https://shop.example.com/"})
    src = tmp_path / "graph.json"
    kg.export_graph_json(src)
    fake = FakeWikidata()
    real = httpx.AsyncClient
    monkeypatch.setattr("geo_crawler.wikidata.httpx.AsyncClient", lambda **kw: real(transport=fake.transport(), **kw))
    out, ld = tmp_path / "out.json", tmp_path / "schema.json"
    assert reconcile_main([str(src), "-o", str(out), "--jsonld", str(ld)]) == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert next(n for n in data["nodes"] if n["id"] == ORG)["properties"]["wikidataId"] == "Q1001"
    doc = json.loads(ld.read_text(encoding="utf-8"))
    assert validate_jsonld(doc) == []
