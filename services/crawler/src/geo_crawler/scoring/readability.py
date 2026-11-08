"""Pillar 2 — LLM readability & semantic structure (GEO): direct answers, information density, schema, llms.txt."""
from __future__ import annotations

from typing import Any

from ..extractor import page_id
from ..gaps import EXPECTED_SCHEMA
from ..models import EntityType, PageData, PageType, RelationType
from . import text as tx
from .base import AuditContext, Check, Pillar, clamp, ratio_score
from .schema_rules import FAMILIES, page_families, validate_page

_DENSITY_TYPES = (PageType.PRODUCT, PageType.SERVICE, PageType.ARTICLE, PageType.CATEGORY, PageType.FAQ,
                  PageType.HOME, PageType.ABOUT)
EXPECTED_FAMILIES: dict[PageType, set[str]] = {
    pt: {FAMILIES.get(t, t) for t in types} for pt, types in EXPECTED_SCHEMA.items()
}


def page_qa(ctx: AuditContext, p: PageData) -> list[dict[str, str]]:
    """Q/A pairs on a page: HTML-detected + FAQPage schema (via graph Question nodes)."""
    pairs = list(p.faqs)
    seen = {q["question"].lower() for q in pairs}
    pid = page_id(p.url)
    if ctx.graph.g.has_node(pid):
        for qid in ctx.graph.neighbors(pid, RelationType.ANSWERS_QUESTION):
            d = ctx.graph.g.nodes[qid]
            q = d.get("label", "")
            if q and q.lower() not in seen:
                seen.add(q.lower())
                pairs.append({"question": q, "answer": d.get("properties", {}).get("answer") or "",
                              "source": d.get("properties", {}).get("source", "schema")})
    return pairs


def density_profile(p: PageData) -> dict[str, Any]:
    s = p.content_stats or {}
    toks = tx.words(p.text)
    n = max(len(toks), 1)
    structure = s.get("lists", 0) + s.get("tables", 0) * 2 + s.get("definition_lists", 0)
    structure_per_300 = structure * 300 / n
    nums_per_100 = len(tx.numbers(p.text)) * 100 / n
    filler = sum(tx.count_phrases(p.text, tx.FILLER_PHRASES).values())
    filler_per_100 = filler * 100 / n
    avg_par = s.get("avg_paragraph_words", 0.0) or (n if s.get("paragraphs", 0) == 0 else 0)
    ttr = tx.lexical_diversity(toks)

    structure_s = clamp(100 * structure_per_300)  # >=1 list/table per 300 words
    numeric_s = clamp(100 * nums_per_100 / 1.5)  # >=1.5 concrete figures per 100 words
    paragraph_s = clamp(100 - (avg_par - 60) * (100 / 90)) if avg_par > 60 else 100.0
    filler_s = clamp(100 - filler_per_100 * 100)
    lexical_s = clamp((ttr - 0.3) / 0.2 * 100)
    score = 0.3 * structure_s + 0.25 * numeric_s + 0.15 * paragraph_s + 0.15 * filler_s + 0.15 * lexical_s
    if p.word_count < 150:
        score *= max(p.word_count, 0) / 150
    return {
        "score": round(score, 1), "words": p.word_count, "structure_per_300w": round(structure_per_300, 2),
        "numbers_per_100w": round(nums_per_100, 2), "avg_paragraph_words": avg_par,
        "filler_per_100w": round(filler_per_100, 2), "lexical_diversity": round(ttr, 3),
        "tables": s.get("tables", 0), "lists": s.get("lists", 0),
    }


def analyze_readability(ctx: AuditContext) -> Pillar:
    pillar = Pillar("llm_readability", "LLM Okunabilirlik ve Semantik Yapı (GEO)", 0.35)
    pages = ctx.pages
    key = ctx.key_pages

    # 1) direct answers / FAQ blocks
    qa_by_page = {p.url: page_qa(ctx, p) for p in pages}
    qa_key = [p for p in key if qa_by_page.get(p.url)]
    all_pairs = [q for v in qa_by_page.values() for q in v]
    concise = [q for q in all_pairs if 3 <= len((q.get("answer") or "").split()) <= 90]
    lead_pages = ctx.pages_of(PageType.PRODUCT, PageType.SERVICE, PageType.ARTICLE)
    good_leads = [p for p in lead_pages
                  if 15 <= len((p.content_stats or {}).get("first_paragraph", "").split()) <= 100]
    coverage = len(qa_key) / len(key) if key else 0.0
    qa_s = (50 * min(1.0, coverage / 0.3) + 30 * ratio_score(len(concise), len(all_pairs), 0) / 100
            + 20 * ratio_score(len(good_leads), len(lead_pages), 50) / 100)
    if all_pairs:
        detail = (f"{len(all_pairs)} soru-cevap çifti, {len(qa_key)}/{len(key)} önemli sayfada doğrudan cevap bloğu var; "
                  f"hap bilgi uzunluğundaki (3-90 kelime) cevap oranı %{round(100 * len(concise) / len(all_pairs))}")
    else:
        detail = "Sitede hiç soru-cevap / doğrudan cevap bloğu bulunamadı (FAQ şeması veya 'Soru?' başlıkları yok)"
    if lead_pages:
        detail += f"; {len(good_leads)}/{len(lead_pages)} içerik sayfası özet bir giriş paragrafıyla başlıyor"
    pillar.add(Check("direct_answers", "SSS / Doğrudan cevap blokları", qa_s, 25, detail,
                     urls=sorted(p.url for p in key if not qa_by_page.get(p.url))))

    # 2) information density
    # JS shells / near-empty pages are judged by the render check, not here
    dens_pages = [p for p in pages if p.page_type in _DENSITY_TYPES and p.word_count >= 50] \
        or [p for p in pages if p.word_count >= 50]
    profiles = {p.url: density_profile(p) for p in dens_pages}
    dens = sum(v["score"] for v in profiles.values()) / len(profiles) if profiles else 0.0
    low = sorted(u for u, v in profiles.items() if v["score"] < 50)
    if profiles:
        avg = lambda k: sum(v[k] for v in profiles.values()) / len(profiles)  # noqa: E731
        detail = (f"Ortalama: 300 kelimede {avg('structure_per_300w'):.1f} liste/tablo, 100 kelimede "
                  f"{avg('numbers_per_100w'):.1f} somut veri, paragraf {avg('avg_paragraph_words'):.0f} kelime, "
                  f"dolgu ifadesi {avg('filler_per_100w'):.2f}/100 kelime; {len(low)} sayfa düşük yoğunlukta")
    else:
        detail = "Analiz edilecek içerik sayfası yok (sunucu HTML'inde metin bulunamadı)"
    pillar.add(Check("information_density", "Bilgi yoğunluğu", dens, 25, detail, urls=low, applicable=bool(profiles)))

    # 3) schema coverage
    fams = {p.url: page_families(p) for p in pages}
    site_fams = set().union(*fams.values()) if fams else set()
    expected = [(p, EXPECTED_FAMILIES[p.page_type]) for p in pages if p.page_type in EXPECTED_FAMILIES]
    exp_missing = sorted(p.url for p, e in expected if not (fams[p.url] & e))
    # FAQPage markup is expected where Q&A content is primary (not on legal/other boilerplate pages)
    faq_needed = [p for p in pages if qa_by_page.get(p.url) and p.page_type is not PageType.OTHER]
    faq_missing = sorted(p.url for p in faq_needed if "FAQPage" not in fams[p.url])
    crumb_needed = [p for p in pages if p.page_type in (PageType.PRODUCT, PageType.CATEGORY, PageType.ARTICLE,
                                                        PageType.SERVICE)]
    crumb_missing = sorted(p.url for p in crumb_needed if "BreadcrumbList" not in fams[p.url])
    has_org = bool(site_fams & {"Organization", "LocalBusiness"}) or bool(ctx.graph.nodes_of_type(EntityType.ORGANIZATION))
    cov = (20 * has_org
           + 40 * ratio_score(len(expected) - len(exp_missing), len(expected)) / 100
           + 20 * ratio_score(len(faq_needed) - len(faq_missing), len(faq_needed)) / 100
           + 20 * ratio_score(len(crumb_needed) - len(crumb_missing), len(crumb_needed)) / 100)
    parts = [f"Organization şeması {'var' if has_org else 'YOK'}",
             f"{len(expected) - len(exp_missing)}/{len(expected)} sayfa türüne uygun şemaya sahip",
             f"soru-cevap içeren sayfalarda FAQPage eksik: {len(faq_missing)}/{len(faq_needed)}",
             f"BreadcrumbList eksik alt sayfa: {len(crumb_missing)}/{len(crumb_needed)}"]
    pillar.add(Check("schema_coverage", "Schema.org kapsamı (Product/Organization/FAQPage/Article/Breadcrumb)", cov, 20,
                     "; ".join(parts), urls=sorted(set(exp_missing) | set(faq_missing))))

    # 4) schema validity / completeness
    validations = [v for p in pages for v in validate_page(p)]
    val_s = sum(v.score for v in validations) / len(validations) if validations else 0.0
    broken = [v for v in validations if v.missing_required or v.errors]
    if validations:
        by_family: dict[str, list[float]] = {}
        for v in validations:
            by_family.setdefault(v.family, []).append(v.score)
        fam_txt = ", ".join(f"{f} %{round(sum(s) / len(s))}" for f, s in sorted(by_family.items()))
        detail = f"{len(validations)} şema bloğu doğrulandı ({fam_txt}); {len(broken)} blokta zorunlu alan/hata var"
        if broken:
            b = broken[0]
            detail += f" — örn. {b.type}: {', '.join(b.missing_required + b.errors)[:160]}"
    else:
        detail = "Doğrulanacak desteklenen şema bloğu yok"
    pillar.add(Check("schema_validity", "Şema eksiksizliği ve geçerliliği", val_s, 15, detail,
                     urls=sorted({v.url for v in broken})))

    # 5) llms.txt
    sig = ctx.signals
    lt = sig.llms_txt if sig else None
    full = sig.llms_full_txt if sig else None
    if lt is None:
        pillar.add(Check("llms_txt", "llms.txt bağlam dosyası", 0, 15, "llms.txt kontrol edilmedi", applicable=False))
    else:
        if lt.valid:
            s, d = 100.0, f"/llms.txt geçerli ({lt.sections} bölüm, {lt.links} bağlantı)"
            if lt.issues:
                s, d = 85.0, d + f"; iyileştirme: {'; '.join(lt.issues)}"
        elif lt.status == 200:
            s, d = 40.0, f"/llms.txt var ama geçersiz: {'; '.join(lt.issues)}"
        else:
            s, d = 0.0, f"/llms.txt bulunamadı (HTTP {lt.status or 'hata'})"
        if full and full.status == 200 and full.content_type != "text/html":
            s, d = min(100.0, s + 10), d + "; /llms-full.txt mevcut"
        pillar.add(Check("llms_txt", "llms.txt bağlam dosyası", s, 15, d))

    pillar.facts = {
        "qa_by_page": {u: v for u, v in qa_by_page.items() if v},
        "pages_without_qa": [p.url for p in key if not qa_by_page.get(p.url)],
        "density": profiles, "low_density_pages": low,
        "families_by_page": {u: sorted(f) for u, f in fams.items()},
        "expected_schema_missing": exp_missing, "faq_schema_missing": faq_missing,
        "breadcrumb_missing": crumb_missing, "has_organization_schema": has_org,
        "validations": [v.to_dict() for v in validations],
        "llms_txt": {"status": lt.status, "valid": lt.valid, "issues": lt.issues} if lt else None,
    }
    return pillar
