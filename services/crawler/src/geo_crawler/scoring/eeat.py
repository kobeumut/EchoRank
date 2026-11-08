"""Pillar 3 — Information trust: E-E-A-T (experience, expertise, authority, trust) + factual consistency."""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Any
from urllib.parse import urlsplit

from ..extractor import page_id
from ..urls import registrable_host
from ..models import EntityType, PageData, PageType, RelationType
from . import text as tx
from .base import AuditContext, Check, Pillar, clamp, ratio_score
from .schema_rules import get_path, page_schema_nodes, types_of

AUTHORITY_SUFFIXES = (".gov", ".edu", ".gov.tr", ".edu.tr", ".ac.uk", ".gov.uk", ".int", ".mil", ".k12.tr", ".bel.tr")
AUTHORITY_HOSTS = (
    "wikipedia.org", "wikidata.org", "doi.org", "ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov", "who.int",
    "arxiv.org", "nature.com", "sciencedirect.com", "springer.com", "thelancet.com", "nejm.org", "bmj.com",
    "iso.org", "w3.org", "europa.eu", "oecd.org", "worldbank.org", "tuik.gov.tr", "resmigazete.gov.tr",
    "tse.org.tr", "scholar.google.com", "jstor.org", "ieee.org", "acm.org", "cochranelibrary.com",
)
SOCIAL_HOSTS = ("facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "youtube.com",
                "tiktok.com", "pinterest.com", "t.me", "wa.me", "whatsapp.com")

POLICY_PATTERNS: dict[str, re.Pattern[str]] = {
    "privacy": re.compile(r"gizlilik|kvkk|kişisel veri|kisisel-veri|aydınlatma|aydinlatma|privacy|çerez|cerez|cookie", re.I),
    "terms": re.compile(r"kullanım koşul|kullanim-kosul|kullanim-sartlari|kullanım şart|üyelik sözleşme|uyelik-sozlesme|"
                        r"mesafeli|terms|conditions|legal", re.I),
    "returns": re.compile(r"iade|cayma|değişim|degisim|return|refund", re.I),
    "shipping": re.compile(r"kargo|teslimat|gönderim|gonderim|shipping|delivery", re.I),
}
AUTHOR_URL_RE = re.compile(r"/(author|authors|yazar|yazarlar|ekip|ekibimiz|team|uzman|uzmanlar|people|profile)(/|$)", re.I)


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower().removeprefix("www.")


def is_authoritative(url: str) -> bool:
    h = host_of(url)
    return h.endswith(AUTHORITY_SUFFIXES) or any(h == d or h.endswith("." + d) for d in AUTHORITY_HOSTS)


def is_social(url: str) -> bool:
    h = host_of(url)
    return any(h == d or h.endswith("." + d) for d in SOCIAL_HOSTS)


def _link_index(ctx: AuditContext) -> list[tuple[str, str]]:
    """(url, anchor text) of every crawled URL and same-organisation link (incl. sibling subdomains)."""
    own = registrable_host(ctx.origin)
    seen: dict[str, str] = {}
    for p in ctx.crawl.pages.values():
        seen.setdefault(p.url, p.title)
        for link in p.internal_links:
            seen.setdefault(link.url, link.text)
        for link in p.external_links:
            h = registrable_host(link.url)
            if h == own or h.endswith("." + own):  # e.g. policies.example.com
                seen.setdefault(link.url, link.text)
    return list(seen.items())


def brand_tokens(ctx: AuditContext) -> set[str]:
    host = (urlsplit(ctx.origin).hostname or "").removeprefix("www.")
    toks = set(tx.words(host.replace(".", " ").replace("-", " ")))
    for o in _org_nodes(ctx)[:3]:
        if isinstance(o.get("name"), str):
            toks.update(tx.words(o["name"]))
    home = next((p for p in ctx.pages if p.page_type is PageType.HOME), None)
    if home and home.title:
        toks.update(tx.words(home.title.split("|")[0].split(" - ")[0])[:3])
    return {t for t in toks if len(t) > 2}


def _find_policies(ctx: AuditContext) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {k: [] for k in POLICY_PATTERNS}
    for url, anchor in _link_index(ctx):
        hay = f"{urlsplit(url).path} {anchor}"
        for kind, rx in POLICY_PATTERNS.items():
            if rx.search(hay) and len(found[kind]) < 5:
                found[kind].append(url)
    return found


def _org_nodes(ctx: AuditContext) -> list[dict[str, Any]]:
    out = []
    for p in ctx.pages:
        for n in page_schema_nodes(p):
            if set(types_of(n)) & {"Organization", "Corporation", "LocalBusiness", "Store", "OnlineStore"}:
                out.append(n)
    return out


def _contact(ctx: AuditContext, orgs: list[dict[str, Any]]) -> dict[str, list[str]]:
    phones, emails, addresses = set(), set(), set()
    for p in ctx.pages:
        s = p.content_stats or {}
        phones.update(s.get("phones", []))
        emails.update(s.get("emails", []))
        if p.page_type is PageType.CONTACT:
            phones.update(s.get("text_phones", []))
            emails.update(s.get("text_emails", []))
        addresses.update(s.get("addresses", []))
    for o in orgs:
        for t in get_path(o, "telephone") + get_path(o, "contactPoint.telephone"):
            phones.add(re.sub(r"[^\d+]", "", str(t)))
        for e in get_path(o, "email") + get_path(o, "contactPoint.email"):
            emails.add(str(e).lower().removeprefix("mailto:"))
        for a in get_path(o, "address"):
            addresses.add(a if isinstance(a, str) else ", ".join(str(v) for k, v in a.items() if not k.startswith("@")))
    return {"phones": sorted(x for x in phones if x), "emails": sorted(x for x in emails if x),
            "addresses": sorted(x for x in addresses if x)}


def _page_sourced(p: PageData) -> bool:
    s = p.content_stats or {}
    ext = [link.url for link in p.external_links if not is_social(link.url)]
    return bool(ext and (any(is_authoritative(u) for u in ext) or len(ext) >= 2)) or s.get("cite_tags", 0) > 0 \
        or s.get("footnotes", 0) >= 2 or bool(tx.SOURCE_MARKERS.search(p.text[-3000:]))


def _price_conflicts(ctx: AuditContext) -> list[dict[str, Any]]:
    prices: dict[str, dict[str, str]] = defaultdict(dict)
    for p in ctx.pages:
        for n in page_schema_nodes(p):
            if "Product" in types_of(n) and isinstance(n.get("name"), str):
                for price in get_path(n, "offers.price"):
                    prices[n["name"].strip().lower()][p.url] = str(price)
    return [{"product": name, "prices": by_url} for name, by_url in prices.items() if len(set(by_url.values())) > 1]


def analyze_eeat(ctx: AuditContext) -> Pillar:
    pillar = Pillar("eeat", "Bilgi Güvenilirliği (E-E-A-T & Olgusal Tutarlılık)", 0.25)
    pages = ctx.pages
    kg = ctx.graph
    articles = ctx.pages_of(PageType.ARTICLE)
    links = _link_index(ctx)
    orgs = _org_nodes(ctx)

    # ---- 1) Experience & expertise
    def authors_of(p: PageData) -> list[str]:
        pid = page_id(p.url)
        ids = kg.neighbors(pid, RelationType.WRITTEN_BY) if kg.g.has_node(pid) else []
        return ids or ([f"hint:{h}" for h in (p.content_stats or {}).get("author_hints", [])[:1]]) \
            or ([f"meta:{p.meta['author']}"] if p.meta.get("author") else [])

    authored = {p.url: authors_of(p) for p in articles}
    with_author = [u for u, a in authored.items() if a]
    person_ids = {a for a_list in authored.values() for a in a_list if a.startswith("person:")}
    rich_authors = [a for a in person_ids
                    if any(kg.g.nodes[a].get("properties", {}).get(k) for k in ("job_title", "url", "same_as"))]
    author_pages = sorted({u for u, _ in links if AUTHOR_URL_RE.search(urlsplit(u).path)})
    exp_pages = [p.url for p in pages if tx.count_phrases(p.text, tx.EXPERIENCE_MARKERS)]
    about = [p.url for p in ctx.pages_of(PageType.ABOUT)]
    if articles:
        exp_s = (45 * ratio_score(len(with_author), len(articles)) / 100
                 + 25 * ratio_score(len(rich_authors), len(person_ids), 0) / 100
                 + 15 * bool(author_pages) + 15 * min(1.0, len(exp_pages) / max(1, len(articles) * 0.3)))
        detail = (f"{len(with_author)}/{len(articles)} makalede yazar belirtilmiş; {len(rich_authors)}/{len(person_ids)} "
                  f"yazarın unvan/profil/sameAs bilgisi var; yazar/ekip sayfası {'var' if author_pages else 'yok'}; "
                  f"{len(exp_pages)} sayfada birinci el deneyim ifadesi")
    else:
        exp_s = 40 * bool(about) + 30 * bool(author_pages) + 30 * min(1.0, len(exp_pages) / 2)
        detail = (f"Makale yok — yayıncı kimliği değerlendirildi: hakkımızda sayfası {'var' if about else 'yok'}, "
                  f"ekip/uzman sayfası {'var' if author_pages else 'yok'}, {len(exp_pages)} sayfada deneyim ifadesi")
    pillar.add(Check("experience_expertise", "Deneyim & Uzmanlık", exp_s, 25, detail,
                     urls=sorted(u for u, a in authored.items() if not a)))

    # ---- 2) Authoritativeness
    same_as = sorted({str(s) for o in orgs for s in get_path(o, "sameAs")})
    has_logo = any(get_path(o, "logo") for o in orgs)
    content_pages = [p for p in pages if p.page_type in (PageType.ARTICLE, PageType.FAQ, PageType.SERVICE,
                                                         PageType.PRODUCT, PageType.OTHER)]
    auth_cite_pages = [p.url for p in content_pages if any(is_authoritative(link.url) for link in p.external_links)]
    cited_domains = sorted({host_of(link.url) for p in pages for link in p.external_links
                            if not is_social(link.url)})
    products = [n for n in kg.nodes_of_type(EntityType.PRODUCT) if not kg.g.nodes[n]["properties"].get("placeholder")]
    rated = [n for n in products if kg.g.nodes[n]["properties"].get("rating") or kg.g.nodes[n]["properties"].get("review_count")]
    auth_s = (25 * min(1.0, len(same_as) / 2) + 10 * has_logo + 15 * bool(about) + 15 * bool(orgs)
              + 20 * min(1.0, len(auth_cite_pages) / max(1, len(content_pages) * 0.2))
              + 15 * (ratio_score(len(rated), len(products)) / 100 if products else min(1.0, len(cited_domains) / 5)))
    detail = (f"Organization şeması {'var' if orgs else 'yok'} (sameAs: {len(same_as)}, logo: {'var' if has_logo else 'yok'}); "
              f"hakkımızda {'var' if about else 'yok'}; {len(auth_cite_pages)}/{len(content_pages)} içerik sayfası otoriter "
              f"kaynağa (.gov/.edu/Wikipedia/DOI...) atıf yapıyor; {len(cited_domains)} farklı dış alan adına bağlantı")
    if products:
        detail += f"; {len(rated)}/{len(products)} üründe puan/yorum verisi"
    pillar.add(Check("authoritativeness", "Otoriterlik", auth_s, 20, detail))

    # ---- 3) Trust
    sig = ctx.signals
    https = sig.https if sig else ctx.origin.startswith("https://")
    hsts = sig.hsts if sig else any("strict-transport-security" in p.headers for p in pages)
    contact = _contact(ctx, orgs)
    contact_page = [p.url for p in ctx.pages_of(PageType.CONTACT)] or \
        [u for u, a in links if re.search(r"iletisim|contact|bize-ulasin", u, re.I)][:1]
    policies = _find_policies(ctx)
    needed = ["privacy", "terms"] + (["returns", "shipping"] if products else [])
    missing_policies = [k for k in needed if not policies[k]]
    dated = [p.url for p in articles if kg.g.has_node(page_id(p.url)) and (
        kg.g.nodes[page_id(p.url)]["properties"].get("date_published")
        or kg.g.nodes[page_id(p.url)]["properties"].get("date_modified")) or (p.content_stats or {}).get("time_tags")]
    contact_kinds = sum(bool(contact[k]) for k in ("phones", "emails", "addresses"))
    trust_s = (20 * https + 5 * hsts + 10 * bool(contact_page) + 25 * contact_kinds / 3
               + 30 * ratio_score(len(needed) - len(missing_policies), len(needed)) / 100
               + 10 * (ratio_score(len(dated), len(articles)) / 100 if articles else 1))
    names = {"privacy": "gizlilik/KVKK", "terms": "kullanım koşulları/mesafeli satış", "returns": "iade/cayma",
             "shipping": "kargo/teslimat"}
    detail = (f"SSL/HTTPS {'aktif' if https else 'YOK'}{' + HSTS' if hsts else ''}; iletişim sayfası "
              f"{'var' if contact_page else 'yok'}; doğrulanabilir iletişim: {len(contact['phones'])} telefon, "
              f"{len(contact['emails'])} e-posta, {len(contact['addresses'])} adres; politikalar: "
              + ", ".join(f"{names[k]} {'✓' if policies[k] else '✗'}" for k in needed))
    if articles:
        detail += f"; {len(dated)}/{len(articles)} makalede yayın/güncelleme tarihi"
    pillar.add(Check("trust", "Güven (SSL, iletişim, politikalar)", trust_s, 30, detail))

    # ---- 4) Factual consistency
    claims_by_page = {p.url: tx.claim_sentences(p.text) for p in pages}
    claim_pages = [p for p in pages if claims_by_page[p.url]]
    unsourced = sorted(p.url for p in claim_pages if not _page_sourced(p))
    spam: dict[str, list[str]] = {}
    brand = brand_tokens(ctx)
    for p in pages:
        toks = tx.words(p.text)
        n = max(len(toks), 1)
        reasons = []
        hype = tx.count_phrases(p.text, tx.HYPE_PHRASES)
        if sum(hype.values()) * 100 / n > 0.5 and sum(hype.values()) >= 3:
            reasons.append("abartılı/pazarlama ifadeleri: " + ", ".join(f"'{k}'×{v}" for k, v in hype.most_common(3)))
        stuffed = tx.keyword_stuffing(toks, brand)
        if stuffed:
            reasons.append(f"anahtar kelime doldurma: '{stuffed[0]}' metnin %{stuffed[1] * 100:.1f}'i")
        if p.text.count("!") * 100 / n > 1.5 and p.text.count("!") >= 8:
            reasons.append(f"{p.text.count('!')} ünlem işareti")
        if reasons:
            spam[p.url] = reasons
    conflicts = _price_conflicts(ctx)
    distinct_org_names = sorted({str(o.get("name")).strip() for o in orgs if isinstance(o.get("name"), str)})
    inconsistent = len(conflicts) + (1 if len(distinct_org_names) > 2 else 0)
    fact_s = (50 * ratio_score(len(claim_pages) - len(unsourced), len(claim_pages)) / 100
              + 30 * ratio_score(len(pages) - len(spam), len(pages)) / 100
              + 20 * clamp(100 - 34 * inconsistent) / 100)
    detail = (f"{sum(len(v) for v in claims_by_page.values())} doğrulanabilir iddia ({len(claim_pages)} sayfa); "
              f"{len(unsourced)} sayfada iddialar kaynaksız; {len(spam)} sayfada spam/spekülatif sinyal")
    if conflicts:
        c = conflicts[0]
        detail += f"; çelişkili veri: '{c['product']}' farklı fiyatlarla ({', '.join(sorted(set(c['prices'].values())))})"
    if len(distinct_org_names) > 2:
        detail += f"; {len(distinct_org_names)} farklı kurum adı kullanılıyor"
    if spam:
        u = next(iter(spam))
        detail += f" — örn. {u}: {spam[u][0]}"
    pillar.add(Check("factual_consistency", "Olgusal tutarlılık (kaynak, spam, çelişki)", fact_s, 25, detail,
                     urls=sorted(set(unsourced) | set(spam))))

    pillar.facts = {
        "articles": [p.url for p in articles], "articles_without_author": sorted(u for u, a in authored.items() if not a),
        "author_pages": author_pages, "experience_pages": exp_pages[:20], "about_pages": about,
        "organizations": [{k: v for k, v in o.items() if k in ("@type", "name", "url", "logo", "sameAs", "telephone")}
                          for o in orgs[:3]],
        "same_as": same_as, "has_logo": has_logo, "authoritative_citation_pages": auth_cite_pages,
        "https": https, "hsts": hsts, "http_redirects_to_https": sig.http_redirects_to_https if sig else None,
        "contact": contact, "contact_pages": contact_page, "policies": policies, "missing_policies": missing_policies,
        "is_ecommerce": bool(products), "dated_articles": dated,
        "unsourced_claim_pages": unsourced,
        "claim_examples": {u: claims_by_page[u][:3] for u in unsourced[:5]},
        "spam_pages": spam, "price_conflicts": conflicts, "organization_names": distinct_org_names,
    }
    return pillar
