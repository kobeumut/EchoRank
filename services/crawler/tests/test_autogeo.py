"""AutoGEO scoring and rewrites.

Report text (labels, details, titles, rationales) is English by default and follows ``lang``; the *sample pages* are
Turkish web content on purpose: they exercise the Turkish lexicons/placeholders that are written into rewrites
for Turkish pages (the content language is independent of the report language).
"""
import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from autogeo_fixtures import EN_BLOG, PRODUCT, SERVICE_MD, STRONG_BLOG, WEAK_BLOG  # noqa: E402

from geo_crawler.blocks import ContentBlock, blocks_from_html, blocks_from_markdown  # noqa: E402
from geo_crawler.parser import parse_html  # noqa: E402
from geo_crawler.scoring import score_index  # noqa: E402
from geo_crawler.scoring.autogeo import (  # noqa: E402
    METRIC_KEYS, analyze_blocks, analyze_html, analyze_markdown, analyze_page, authority_tier, is_cited, main,
)

URL = "https://shop.example.com/blog/espresso"


def apply_diff(before: str, diff: str) -> str:
    """Minimal unified-diff applier for single-file hunks (verifies the diff is self-consistent)."""
    src = before.splitlines()
    out: list[str] = []
    pos = 0
    for hunk in re.split(r"^@@ ", diff, flags=re.M)[1:]:
        header, *lines = hunk.split("\n")
        start = int(re.match(r"-(\d+)", header).group(1)) - 1
        start = max(start, 0)
        out += src[pos:start]
        pos = start
        for ln in lines:
            if ln.startswith("-"):
                assert src[pos] == ln[1:], (src[pos], ln)
                pos += 1
            elif ln.startswith("+"):
                out.append(ln[1:])
            elif ln.startswith(" "):
                assert src[pos] == ln[1:]
                out.append(ln[1:])
                pos += 1
    return "\n".join(out + src[pos:])


@pytest.fixture(scope="module")
def weak():
    return analyze_html(WEAK_BLOG, url=URL, page_type="article")


@pytest.fixture(scope="module")
def strong():
    return analyze_html(STRONG_BLOG, url=URL, page_type="article")


# ---------------- block extraction ----------------

def test_html_blocks_skip_chrome_and_keep_structure():
    blocks = blocks_from_html(WEAK_BLOG, URL)
    kinds = [b.kind for b in blocks]
    assert kinds[0] == "heading" and blocks[0].level == 1 and blocks[0].text == "Espresso Rehberi"
    assert "list" in kinds and "blockquote" in kinds
    assert not any("Telif" in b.text or b.text == "Anasayfa Blog" for b in blocks)  # nav/footer excluded
    lst = next(b for b in blocks if b.kind == "list")
    assert lst.items == ["Kahveyi öğütün", "Portafiltreye doldurun", "Demleyin"]


def test_html_blockquote_attribution_and_links():
    blocks = blocks_from_html(STRONG_BLOG, URL)
    q = next(b for b in blocks if b.kind == "blockquote")
    assert q.cite.startswith("Dr. Ayşe Kaya") and "Dr. Ayşe" not in q.text
    table = next(b for b in blocks if b.kind == "table")
    assert table.rows[0] == ["Parametre", "Değer", "Kaynak"] and len(table.rows) == 3
    refs = next(b for b in blocks if b.kind == "paragraph" and b.links)
    assert {lk["url"] for lk in refs.links} >= {"https://doi.org/10.1016/j.foodchem.2020.1"}


def test_markdown_blocks():
    blocks = blocks_from_markdown(SERVICE_MD)
    assert [b.kind for b in blocks][:3] == ["heading", "paragraph", "heading"]
    assert blocks[1].links[0]["url"] == "https://developers.google.com/search/docs"
    assert "](" not in blocks[1].text  # inline markup stripped
    q = next(b for b in blocks if b.kind == "blockquote")
    assert q.cite == "Mehmet Demir, SEO Direktörü, Ajans X"
    lst = next(b for b in blocks if b.kind == "list")
    assert lst.ordered and lst.items[0] == "Keşif görüşmesi"
    table = next(b for b in blocks if b.kind == "table")
    assert table.rows[2] == ["Kurumsal", "6 ay", "120.000 TL"]


def test_block_rendering_roundtrip():
    b = ContentBlock("table", "", rows=[["A", "B"], ["1", "2|3"]])
    assert b.to_markdown().splitlines()[2] == "| 1 | 2\\|3 |"
    assert "<th>A</th>" in b.to_html()
    q = ContentBlock("blockquote", "x < y", cite="Ali")
    assert q.to_markdown() == "> x < y\n> — Ali" and "x &lt; y" in q.to_html()
    assert ContentBlock.from_dict(q.to_dict()) == q


def test_parser_stores_blocks_without_changing_text(monkeypatch):
    page = parse_html(STRONG_BLOG, URL)
    assert page.content_blocks and page.content_blocks[0]["kind"] == "heading"
    assert "content_blocks" not in page.to_dict()
    import geo_crawler.parser as parser_mod
    monkeypatch.setattr(parser_mod, "blocks_from_soup", lambda soup, base: [])
    plain = parse_html(STRONG_BLOG, URL)
    assert plain.text == page.text and plain.content_stats == page.content_stats  # block extraction is read-only


# ---------------- metrics ----------------

@pytest.mark.parametrize("src,kind,fn", [
    (WEAK_BLOG, "article", analyze_html), (STRONG_BLOG, "article", analyze_html), (PRODUCT, "product", analyze_html),
    (SERVICE_MD, "service", analyze_markdown), (EN_BLOG, "article", analyze_html),
])
def test_six_metrics_for_every_content_type(src, kind, fn):
    r = fn(src, url=URL, page_type=kind)
    assert tuple(r.metrics) == METRIC_KEYS
    for m in r.metrics.values():
        assert 0 <= m.score <= 100 and m.detail and m.weight > 0
    assert 0 <= r.score <= 100 and r.grade in "ABCDE"
    assert abs(sum(m.weight for m in r.metrics.values()) - 1) < 1e-6
    json.dumps(r.to_dict(), ensure_ascii=False)


def test_strong_content_outscores_weak(weak, strong):
    assert strong.score >= 85 > 40 > weak.score
    for key in ("statistics", "quotations", "citations", "answer_capsules", "authority_fluency"):
        assert strong.metrics[key].score > weak.metrics[key].score, key
    assert len(strong.improvements) < len(weak.improvements)


def test_statistics_metric(weak, strong):
    s = weak.metrics["statistics"]
    assert s.score < 20 and s.facts["vague_count"] >= 3
    assert strong.metrics["statistics"].facts["numeric_facts"] >= 15


def test_quotation_metric(weak, strong):
    assert weak.metrics["quotations"].facts == {"attributed": 0, "unattributed": 1, "target": 1.0}
    assert strong.metrics["quotations"].facts["attributed"] == 1


def test_citation_metric_and_authority_tiers(weak, strong):
    assert authority_tier("https://www.tarimorman.gov.tr/x") == 1
    assert authority_tier("https://doi.org/10.1/x") == 1
    assert authority_tier("https://www.harvard.edu/") == 1
    assert authority_tier("https://www.statista.com/s") == 2
    assert authority_tier("https://randomblog.net/a") == 3
    assert weak.metrics["citations"].score < 20
    c = strong.metrics["citations"].facts
    assert c["tier1"] == 2 and c["references_section"] is True


def test_turkish_and_english_inline_citations():
    assert is_cited("TÜİK'e göre hanelerin %40'ı kahve içiyor.")
    assert is_cited("Uluslararası Kahve Örgütü verilerine göre tüketim arttı.")
    assert is_cited("Tüketim %12 arttı [3].") and is_cited("Growth was 12% (Smith et al., 2023).")
    assert is_cited("According to the WHO, 1 in 4 adults is inactive.")
    assert not is_cited("Tüketim yüzde 12 arttı.")


def test_low_serp_rank_boosts_citation_gain():
    base = analyze_html(EN_BLOG, url=URL, page_type="article")
    ranked = analyze_html(EN_BLOG, url=URL, page_type="article", serp_rank=7)
    assert ranked.metrics["citations"].potential_gain_pct > 2 * base.metrics["citations"].potential_gain_pct


def test_answer_capsule_metric(weak, strong):
    secs = weak.metrics["answer_capsules"].facts["sections"]
    assert len(secs) == 3 and secs[1]["reason"].startswith("there is a list instead of a paragraph right under the heading")
    assert strong.metrics["answer_capsules"].score == 100


def test_authority_fluency_metric(weak):
    f = weak.metrics["authority_fluency"].facts
    assert f["hedged"] >= 2 and f["filler"] >= 2 and f["hype"] >= 1


def test_keyword_stuffing_detection_and_cap(weak, strong):
    k = weak.metrics["keyword_stuffing"]
    assert k.score < 40 and k.facts["risk"] == "-25%" and k.facts["top_term"] == "espresso makinesi"
    assert weak.score <= 60 and weak.caps
    assert strong.metrics["keyword_stuffing"].facts["risk"] == "none"


def test_brand_terms_are_not_stuffing():
    text = " ".join(["Acme ürünleri dayanıklı ve hafif tasarımıyla öne çıkar."] * 3 +
                    [f"Model {i} için {i * 3} yıl garanti ve {i * 10} gün iade süresi sunulur." for i in range(1, 9)])
    with_brand = analyze_markdown(text, url="https://acme.com/x", brand_terms=["acme"])
    assert with_brand.metrics["keyword_stuffing"].facts["top_word"] != "acme"


def test_content_type_weight_profiles():
    p = analyze_html(PRODUCT, url=URL, page_type="product")
    a = analyze_html(PRODUCT, url=URL, page_type="article")
    assert p.metrics["quotations"].weight < a.metrics["quotations"].weight
    assert p.metrics["keyword_stuffing"].weight > a.metrics["keyword_stuffing"].weight


# ---------------- improvements & diffs ----------------

def test_every_rewrite_diff_applies_and_one_rewrite_per_block(weak):
    rewrites = [i for i in weak.improvements if i.kind == "rewrite"]
    assert len({i.block_index for i in rewrites}) == len(rewrites)
    for imp in weak.improvements:
        assert imp.diff_markdown.startswith("--- a/blog/espresso.md\n+++ b/blog/espresso.md")
        assert imp.diff_html.startswith("--- a/blog/espresso.html")
        target = imp.after_markdown if imp.kind == "rewrite" else f"{imp.before_markdown}\n\n{imp.after_markdown}"
        assert apply_diff(imp.before_markdown, imp.diff_markdown) == target.strip("\n")


def test_statistics_rewrite_inserts_placeholders_and_citation(weak):
    imp = next(i for i in weak.improvements if "statistics" in i.metrics and i.kind == "rewrite"
               and i.before_markdown.startswith("Günümüzde"))
    assert imp.after_markdown.startswith("[SAYI] insan güne espresso ile başlıyor ([Kaynak, Yıl](https://kaynak-adresi))")
    assert "Günümüzde" not in imp.after_markdown and "Bu yazımızda" not in imp.after_markdown  # merged fluency fix
    assert set(imp.metrics) == {"statistics", "authority_fluency"}
    assert '<a href="https://kaynak-adresi">Kaynak, Yıl</a>' in imp.after_html and imp.after_html.startswith("<p>")


def test_key_figures_and_comparison_table_inserts(weak, strong):
    tables = [i for i in weak.improvements if i.kind == "insert" and i.after_markdown.startswith("| ")]
    assert {i.rule_id for i in tables} == {"autogeo.statistics", "autogeo.comparison_table"}
    assert weak.comparison_table and weak.comparison_table["rows"][0][0] == "Kriter"
    assert strong.comparison_table is None  # page already has a table


def test_quotation_improvements(weak):
    imp = next(i for i in weak.improvements if i.metric == "quotations")
    assert imp.kind == "rewrite" and imp.after_markdown.endswith("> — [Ad Soyad], [Unvan], [Kurum]")
    assert "<cite>[Ad Soyad], [Unvan], [Kurum]</cite>" in imp.after_html
    prod = analyze_html(PRODUCT, url=URL, page_type="product")
    ins = next(i for i in prod.improvements if i.metric == "quotations")
    assert ins.kind == "insert" and ins.after_markdown.startswith("> [Uzmanın doğrudan alıntısı]")


def test_answer_capsule_improvements(weak):
    caps = [i for i in weak.improvements if "answer_capsules" in i.metrics]
    rewrite = next(i for i in caps if i.kind == "rewrite")
    assert rewrite.after_markdown.startswith("Espresso ")  # dangling "Bu" replaced by the heading subject
    insert = next(i for i in caps if i.kind == "insert")
    assert insert.before_markdown == "## Espresso nasıl hazırlanır?"
    assert insert.after_markdown.startswith("Espresso nasıl hazırlanır: Kahveyi öğütün")


def test_answer_capsule_length_window():
    long_section = ("## Kahve çekirdeği nasıl saklanır?\n\n" + " ".join(
        f"Kural {i}: çekirdekleri {i * 2} gün içinde tüketin ve hava almayan kapta saklayın." for i in range(1, 12)))
    r = analyze_markdown("# Saklama\n\nGiriş metni burada yer alır ve konu özetlenir.\n\n" + long_section)
    imp = next(i for i in r.improvements if "answer_capsules" in i.metrics)
    assert imp.kind == "insert" and 40 <= len(imp.after_markdown.split()) <= 60
    # the intro is only 9 words: the page capsule keeps it and asks the editor for the missing facts
    assert r.answer_capsule["text"].startswith("Giriş metni") and "[Ölçülebilir" in r.answer_capsule["text"]


def test_fluency_rewrite_has_no_holes():
    r = analyze_html(EN_BLOG, url=URL, page_type="article")
    imp = next(i for i in r.improvements if "authority_fluency" in i.metrics)
    assert "I think" not in imp.after_markdown and "probably" not in imp.after_markdown
    assert "In today's world" not in imp.after_markdown
    assert "It is a [measurable advantage" in imp.after_markdown


def test_keyword_stuffing_rewrite_keeps_first_use(weak):
    imp = next(i for i in weak.improvements if "keyword_stuffing" in i.metrics)
    after = imp.after_markdown.lower()
    assert after.count("espresso makinesi") == 1 and after.count("[eş anlamlı/zamir]") >= 5
    assert "[eş anlamlı/zamir] [eş anlamlı/zamir]" not in after


def test_strong_page_needs_no_rewrites(strong):
    assert all(i.kind != "rewrite" for i in strong.improvements)


def test_analyze_page_fallback_without_blocks():
    page = parse_html(WEAK_BLOG, URL)
    page.content_blocks = []
    r = analyze_page(page)
    assert tuple(r.metrics) == METRIC_KEYS and r.word_count > 50


def test_analyze_blocks_accepts_dicts():
    page = parse_html(WEAK_BLOG, URL)
    r = analyze_blocks(page.content_blocks, URL, "article")
    assert r.score == analyze_html(WEAK_BLOG, URL, "article").score


# ---------------- integration ----------------

async def test_audit_report_carries_autogeo(indexed):
    report = score_index(indexed)
    assert report.autogeo is not None and report.autogeo.pages
    rows = report.to_db_records()
    ag = rows["autogeo"]
    assert ag["version"] and 0 <= ag["score"] <= 100 and set(ag["metrics"]) == set(METRIC_KEYS)
    assert all(p["url"].startswith("https://shop.example.com") for p in ag["pages"])
    assert rows["audit"]["metrics"]["autogeo"]["pageCount"] == len(ag["pages"])
    assert report.to_dict()["autogeo"]["page_count"] == len(ag["pages"])
    json.dumps(rows, ensure_ascii=False)


def test_cli_markdown_file(tmp_path, capsys):
    f = tmp_path / "hizmet.md"
    f.write_text(SERVICE_MD, encoding="utf-8")
    assert main([str(f), "--type", "service", "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["page_type"] == "service" and set(data["metrics"]) == set(METRIC_KEYS)
    assert main([str(f)]) == 0
    assert capsys.readouterr().out.startswith("AutoGEO ")


def test_cli_lang_option_selects_report_language(tmp_path, capsys):
    f = tmp_path / "hizmet.md"
    f.write_text(SERVICE_MD, encoding="utf-8")
    assert main([str(f), "--type", "service"]) == 0
    en = capsys.readouterr().out
    assert "Statistics and numeric data" in en and " words]" in en and "improvement" in en and "İstatistik" not in en
    assert main([str(f), "--type", "service", "--lang", "tr"]) == 0
    tr = capsys.readouterr().out
    assert "İstatistik ve sayısal veri" in tr and " kelime]" in tr and "iyileştirme" in tr
    assert main([str(f), "--type", "service", "--lang", "de"]) == 0  # unsupported -> English
    assert "Statistics and numeric data" in capsys.readouterr().out
    assert main([str(f), "--type", "service", "--json", "--lang", "tr"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["metrics"]["statistics"]["label"] == "İstatistik ve sayısal veri" and data["language"] == "tr"


# ---------------- report language vs. content language ----------------

def test_report_language_follows_lang_not_content_language():
    en = analyze_html(WEAK_BLOG, URL, "article")  # Turkish page, English report (default)
    tr = analyze_html(WEAK_BLOG, URL, "article", lang="tr")  # Turkish page, Turkish report
    assert en.language == tr.language == "tr"
    assert en.metrics["statistics"].label == "Statistics and numeric data"
    assert tr.metrics["statistics"].label == "İstatistik ve sayısal veri"
    assert en.metrics["statistics"].detail.startswith("Numeric figures: ")
    assert tr.metrics["statistics"].detail.endswith("tablo.")
    # identical analysis: scores, ids, improvement structure and the inserted (content-language) rewrites
    assert en.score == tr.score and en.caps != tr.caps and len(en.caps) == len(tr.caps) == 1
    assert [(i.rule_id, i.kind, i.block_index, i.metrics) for i in en.improvements] == \
           [(i.rule_id, i.kind, i.block_index, i.metrics) for i in tr.improvements]
    assert [i.after_markdown for i in en.improvements] == [i.after_markdown for i in tr.improvements]
    assert en.improvements[0].title != tr.improvements[0].title
    assert any(i.title.startswith("Replace vague quantities with concrete figures") for i in en.improvements)
    assert any(i.title.startswith("Muğlak nicelikleri somut veriye çevirin") for i in tr.improvements)
    assert en.caps == ["excessive keyword repetition (cap 60)"] and tr.caps == ["aşırı anahtar kelime tekrarı (üst sınır 60)"]
    # rewrites inserted into a Turkish page keep the Turkish placeholders even in an English report
    assert any("[SAYI]" in i.after_markdown for i in en.improvements)


def test_english_page_in_turkish_report_keeps_english_placeholders():
    r = analyze_html(EN_BLOG, URL, "article", lang="tr")
    assert r.language == "en"
    assert r.metrics["citations"].label == "Yetkili kaynak gösterimi"
    inserted = " ".join(i.after_markdown for i in r.improvements)
    assert "[NUMBER]" in inserted or "[Source, Year]" in inserted or "[Expert's direct quotation]" in inserted
    assert all(i.title and i.rationale for i in r.improvements)
    assert any("kapsül" in i.title.lower() or "kaynak" in i.title.lower() or "ifade" in i.title.lower()
               for i in r.improvements)


def test_content_language_hint_is_separate_from_report_language():
    text = "# Rehber\n\nEspresso hazırlamak için 18 gram kahve kullanılır ve birçok kişi bunu sever.\n"
    assert analyze_markdown(text, URL, "article", content_lang="en").language == "en"
    assert analyze_markdown(text, URL, "article", content_lang="en", lang="tr").language == "en"
    assert analyze_markdown(text, URL, "article").language == "tr"  # detected from the text


def test_answer_capsule_diagnostics_are_localized_but_ids_are_not():
    en = analyze_html(WEAK_BLOG, URL, "article")
    tr = analyze_html(WEAK_BLOG, URL, "article", lang="tr")
    secs_en, secs_tr = en.metrics["answer_capsules"].facts["sections"], tr.metrics["answer_capsules"].facts["sections"]
    assert [(r["heading"], r["block_index"], r["quality"]) for r in secs_en] == \
           [(r["heading"], r["block_index"], r["quality"]) for r in secs_tr]
    assert secs_tr[1]["reason"].startswith("başlığın hemen altında paragraf yerine liste")
    assert secs_en[1]["reason"].startswith("there is a list instead of a paragraph")
    assert " words" in secs_en[0]["reason"] and " kelime" in secs_tr[0]["reason"]
