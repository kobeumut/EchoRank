""""Ne Yapılmalı?" — turns failed checks into prioritized action cards with copy-paste fixes.

Each rule inspects pillar facts and emits zero or more ``ActionCard``s. Impact is derived from the
estimated GEO-score gain of fixing the underlying check (never lower than the rule's base impact);
priority = impact × reach / effort.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Callable
from urllib.parse import urlsplit

from ..models import PageType
from . import snippets as sn
from .base import AuditContext, Pillar

IMPACT_W = {"high": 3, "medium": 2, "low": 1}
EFFORT_W = {"low": 1, "medium": 2, "high": 3}


@dataclass
class Snippet:
    language: str  # robots | markdown | html | json-ld | nginx | tsx | text
    code: str
    filename: str | None = None
    instructions: str = ""


@dataclass
class ActionCard:
    rule_id: str
    title: str
    description: str
    category: str  # crawler | schema | content | authority | technical (ActionItem.category)
    impact: str
    effort: str
    check_id: str
    evidence: list[str] = field(default_factory=list)
    target_url: str | None = None
    affected_urls: list[str] = field(default_factory=list)
    snippet: Snippet | None = None
    expected_gain: float = 0.0  # estimated overall GEO points
    priority: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["affected_urls"] = self.affected_urls[:50]
        d["affected_count"] = len(self.affected_urls)
        return d

    def to_action_item(self) -> dict[str, Any]:
        """Row shaped for the Prisma ``ActionItem`` model (extra data lives in ``details``)."""
        return {
            "title": self.title, "description": self.description, "category": self.category,
            "impact": self.impact, "effort": self.effort, "ruleId": self.rule_id, "priority": round(self.priority, 2),
            "targetUrl": self.target_url,
            "details": {"check_id": self.check_id, "evidence": self.evidence, "expected_gain": self.expected_gain,
                        "affected_urls": self.affected_urls[:50], "affected_count": len(self.affected_urls),
                        "snippet": asdict(self.snippet) if self.snippet else None},
        }


class Rules:
    def __init__(self, ctx: AuditContext, pillars: dict[str, Pillar]):
        self.ctx = ctx
        self.p = pillars
        self.cards: list[ActionCard] = []

    def gain(self, pillar_key: str, check_id: str, fix_fraction: float = 1.0) -> float:
        pillar = self.p[pillar_key]
        c = pillar.check(check_id)
        if not c or not c.applicable:
            return 0.0
        total = sum(x.weight for x in pillar.checks if x.applicable and x.weight > 0) or 1
        return round(pillar.weight * c.weight / total * (100 - c.score) * fix_fraction, 2)

    def emit(self, pillar_key: str, check_id: str, *, base_impact: str, effort: str, fix_fraction: float = 1.0,
             blocker: bool = False, **kw: Any) -> ActionCard:
        """``blocker``: the defect caps the overall GEO score — always ranked first, whatever the effort."""
        g = self.gain(pillar_key, check_id, fix_fraction)
        impact = "high" if g >= 4 else "medium" if g >= 1.5 else "low"
        if IMPACT_W[base_impact] > IMPACT_W[impact]:
            impact = base_impact
        urls = kw.get("affected_urls") or []
        reach = 1 + min(len(urls), 50) / 50
        priority = (IMPACT_W[impact] * 10 + 2 * g) * reach / EFFORT_W[effort] ** 0.7
        if blocker:
            impact, priority = "high", priority + 100
        card = ActionCard(check_id=check_id, impact=impact, effort=effort, expected_gain=g,
                          priority=round(priority, 2), **kw)
        if not card.target_url and urls:
            card.target_url = urls[0]
        c = self.p[pillar_key].check(check_id)
        if c and c.detail not in card.evidence:
            card.evidence.insert(0, c.detail)
        self.cards.append(card)
        return card

    def failing(self, pillar_key: str, check_id: str, threshold: float = 90) -> bool:
        c = self.p[pillar_key].check(check_id)
        return bool(c and c.applicable and c.score < threshold)


Rule = Callable[[Rules], None]
RULES: list[Rule] = []


def rule(fn: Rule) -> Rule:
    RULES.append(fn)
    return fn


# ---------------- crawler / access ----------------

@rule
def site_unreachable(r: Rules) -> None:
    if r.ctx.pages:
        return
    f = r.p["ai_access"].facts
    errors = f.get("fetch_errors") or []
    r.emit("ai_access", "render_mode", base_impact="high", effort="medium", category="crawler", blocker=True,
           rule_id="crawler.site_unreachable", title="Site otomatik istemcilere hiç içerik döndürmüyor",
           description=("Tarama sırasında hiçbir sayfa alınamadı. AI crawler'ları da aynı yanıtı alır; bu durumda site "
                        "hiçbir cevap motorunda kaynak olarak görünemez. Bot koruması (Cloudflare/Akamai/Imperva), IP/ülke "
                        "engeli veya rate-limit kurallarında doğrulanmış AI botlarına izin verin; ardından denetimi tekrarlayın."),
           target_url=r.ctx.origin + "/", evidence=[f"{e['url']}: {e['error']}" for e in errors[:5]],
           snippet=Snippet("text", sn.waf_fix(), None, "Bot koruma katmanınızda AI botları için istisna tanımlayın."))

@rule
def ai_bots_blocked(r: Rules) -> None:
    f = r.p["ai_access"].facts
    bad = [b for b in f["bots"] if b["status"] != "allowed"]
    if not bad:
        return
    if f.get("robots_status") and f["robots_status"] >= 500:
        desc = (f"/robots.txt HTTP {f['robots_status']} döndürüyor; RFC 9309'a göre botlar bu durumda tüm siteyi "
                "yasaklı sayar. robots.txt'yi 200 ile sunun.")
    else:
        search = [b["token"] for b in bad if b["purpose"] in ("search", "user")]
        desc = ("ChatGPT, Claude, Perplexity gibi cevap motorları engellenen sayfaları okuyamaz, dolayısıyla "
                "kaynak olarak gösteremez. ")
        if search:
            desc += f"Arama/cevap botları ({', '.join(search)}) mutlaka açılmalı. "
        desc += "Eğitim botlarını (GPTBot, Google-Extended, CCBot) kapalı tutmak bilinçli bir politika olabilir."
    answer_bots = [b for b in f["bots"] if b["purpose"] in ("search", "user")]
    r.emit("ai_access", "robots_ai_bots", base_impact="high", effort="low", category="crawler",
           blocker=bool(answer_bots) and all(b["status"] == "blocked" for b in answer_bots),
           rule_id="crawler.robots_ai_bots",
           title=f"robots.txt'de {len(bad)} AI botunun erişimini açın", description=desc,
           evidence=[f"{b['token']} ({b['vendor']}): {b['reason']}" for b in bad],
           affected_urls=sorted({p for b in bad for p in b["blocked_paths"]}),
           target_url=r.ctx.origin + "/robots.txt",
           snippet=Snippet("robots", sn.robots_txt_fix(r.ctx, [b["token"] for b in bad]), "robots.txt",
                              "Mevcut robots.txt dosyanızın en üstüne ekleyin; engelleyen 'Disallow: /' satırlarını kaldırın."))


@rule
def waf_blocks_ai(r: Rules) -> None:
    f = r.p["ai_access"].facts
    if not f["waf_blocked"]:
        return
    r.emit("ai_access", "waf_ua_block", base_impact="high", effort="medium", category="crawler",
           blocker=len(f["waf_blocked"]) >= 3,
           rule_id="crawler.waf_ua_block", title="CDN/WAF'ın AI botlarını engellemesini kaldırın",
           description=("robots.txt izin verse de sunucu/CDN AI user-agent'larına 403/429 döndürüyor. Cloudflare'in "
                        "'Block AI bots' özelliği veya bot koruması genellikle sebeptir."),
           target_url=r.ctx.origin + "/",
           snippet=Snippet("text", sn.waf_fix(), None, "Cloudflare/nginx yapılandırmanıza uygulayın."))


@rule
def restrictive_directives(r: Rules) -> None:
    f = r.p["ai_access"].facts
    if not f["directive_pages"]:
        return
    examples = [d for ds in f["directive_pages"].values() for d in ds]
    r.emit("ai_access", "robots_directives", base_impact="high", effort="low", category="crawler",
           rule_id="crawler.noindex_noai", title="Önemli sayfalardaki noindex/noai yönergelerini kaldırın",
           description="Bu yönergeler sayfanın AI cevaplarında ve arama indeksinde kullanılmasını engeller.",
           affected_urls=sorted(f["directive_pages"]), evidence=examples[:5],
           snippet=Snippet("html", sn.directive_fix(examples)))


@rule
def client_side_rendering(r: Rules) -> None:
    f = r.p["ai_access"].facts
    weak = [u for u, v in f["render"].items() if v["mode"] in ("csr_shell", "thin", "heavy_js")]
    if not weak:
        return
    csr = f["csr_pages"]
    render = r.p["ai_access"].check("render_mode")
    r.emit("ai_access", "render_mode", base_impact="high" if csr else "medium", effort="high", category="technical",
           blocker=bool(render and render.score < 30),
           rule_id="technical.server_side_rendering",
           title=f"{len(weak)} sayfayı sunucu tarafında render edin (SSR/SSG)",
           description=("GPTBot, ClaudeBot ve PerplexityBot JavaScript çalıştırmaz; içerik ilk HTML yanıtında yoksa "
                        "sayfa onlar için boştur. Next.js/Nuxt SSR-ISR'a geçin veya botlara prerender sunun."),
           affected_urls=weak, evidence=[f"{u}: {f['render'][u]['reason']}" for u in weak[:5]],
           snippet=Snippet("tsx", sn.ssr_fix(weak[0]), "app/[slug]/page.tsx"))


# ---------------- readability / schema ----------------

@rule
def missing_llms_txt(r: Rules) -> None:
    if not r.failing("llm_readability", "llms_txt", 85):
        return
    lt = r.p["llm_readability"].facts.get("llms_txt") or {}
    exists = lt.get("status") == 200
    r.emit("llm_readability", "llms_txt", base_impact="medium", effort="low", category="technical",
           rule_id="technical.llms_txt",
           title="/llms.txt dosyasını düzeltin" if exists else "/llms.txt bağlam dosyası oluşturun",
           description=("llms.txt, LLM'lere sitenin özetini ve en önemli sayfalarını Markdown olarak sunar. Aşağıdaki "
                        "dosya taranan sayfalardan (PageRank sırasıyla) otomatik üretildi."),
           target_url=r.ctx.origin + "/llms.txt", evidence=lt.get("issues") or [],
           snippet=Snippet("markdown", sn.llms_txt(r.ctx), "llms.txt",
                              "Site köküne text/plain (UTF-8) olarak yayınlayın: https://alanadiniz/llms.txt"))


@rule
def faq_schema_missing(r: Rules) -> None:
    f = r.p["llm_readability"].facts
    for url in f["faq_schema_missing"][:3]:
        pairs = f["qa_by_page"].get(url, [])
        r.emit("llm_readability", "schema_coverage", base_impact="medium", effort="low", category="schema",
               fix_fraction=0.2, rule_id="schema.faq_page",
               title="Sayfadaki soru-cevapları FAQPage şemasıyla işaretleyin",
               description=(f"Bu sayfada {len(pairs)} soru-cevap var ama FAQPage şeması yok. Şema, cevap motorlarının "
                            "soruyu ve hap cevabı doğrudan eşleştirmesini sağlar."),
               target_url=url, affected_urls=[url], evidence=[f"Soru: {q['question']}" for q in pairs[:3]],
               snippet=Snippet("json-ld", sn.faq_jsonld(pairs), None, "<head> içine ekleyin."))


@rule
def no_direct_answers(r: Rules) -> None:
    if not r.failing("llm_readability", "direct_answers", 70):
        return
    f = r.p["llm_readability"].facts
    targets = [p for p in r.ctx.key_pages if p.url in set(f["pages_without_qa"])
               and p.page_type in (PageType.PRODUCT, PageType.SERVICE, PageType.ARTICLE, PageType.CATEGORY)] \
        or [p for p in r.ctx.key_pages if p.url in set(f["pages_without_qa"])]
    if not targets:
        return
    r.emit("llm_readability", "direct_answers", base_impact="high", effort="medium", category="content",
           rule_id="content.direct_answers", title="Önemli sayfalara doğrudan cevap (SSS) blokları ekleyin",
           description=("AI motorları 'X nedir / ne kadar / hangisi' sorularına kısa, net cevap veren bölümleri alıntılar. "
                        "Her önemli sayfaya 3-5 soru ve 40-60 kelimelik cevaplar ekleyin, ardından FAQPage şeması koyun."),
           affected_urls=[p.url for p in targets],
           snippet=Snippet("html", sn.qa_block_template(targets[0])))


@rule
def organization_schema(r: Rules) -> None:
    rf = r.p["llm_readability"].facts
    ef = r.p["eeat"].facts
    if rf["has_organization_schema"] and len(ef["same_as"]) >= 2 and ef["has_logo"]:
        return
    missing = []
    if not rf["has_organization_schema"]:
        missing.append("Organization şeması yok")
    if len(ef["same_as"]) < 2:
        missing.append(f"sameAs bağlantısı {len(ef['same_as'])} (en az 2 önerilir: LinkedIn, Wikidata, sosyal medya)")
    if not ef["has_logo"]:
        missing.append("logo yok")
    r.emit("eeat", "authoritativeness", base_impact="high" if not rf["has_organization_schema"] else "medium",
           effort="low", category="schema", rule_id="schema.organization", fix_fraction=0.5,
           title=("Ana sayfaya Organization şeması ekleyin" if not rf["has_organization_schema"]
                  else "Organization şemasını sameAs/logo ile tamamlayın"),
           description=("Organization şeması markanızı bilgi grafındaki bir varlığa bağlar; sameAs ile Wikidata/LinkedIn "
                        "profilleri LLM'lerin markayı doğrulamasını sağlar."),
           target_url=r.ctx.origin + "/", evidence=missing,
           snippet=Snippet("json-ld", sn.organization_jsonld(r.ctx, ef["same_as"], ef["contact"]), None,
                              "Ana sayfanın <head> bölümüne ekleyin, TODO alanlarını doldurun."))


def _pages_missing_family(r: Rules, page_type: PageType, family: str) -> list:
    fams = r.p["llm_readability"].facts["families_by_page"]
    return [p for p in r.ctx.pages_of(page_type) if family not in fams.get(p.url, [])]


@rule
def product_schema(r: Rules) -> None:
    missing = _pages_missing_family(r, PageType.PRODUCT, "Product")
    incomplete = [v for v in r.p["llm_readability"].facts["validations"]
                  if v["family"] == "Product" and (v["missing_required"] or v["errors"] or len(v["missing_recommended"]) > 3)]
    if missing:
        r.emit("llm_readability", "schema_coverage", base_impact="high", effort="low", category="schema",
               fix_fraction=0.4, rule_id="schema.product",
               title=f"{len(missing)} ürün sayfasına Product şeması ekleyin",
               description=("Fiyat, stok, marka ve SKU bilgisinin yapılandırılmış olması ürünün AI alışveriş cevaplarında "
                            "(ChatGPT Shopping, Perplexity, Gemini) önerilmesinin ön koşuludur."),
               affected_urls=[p.url for p in missing],
               snippet=Snippet("json-ld", sn.product_jsonld(r.ctx, missing[0]), None,
                                  "Her ürün sayfasında ürün verisinden dinamik üretin."))
    if incomplete:
        v = incomplete[0]
        page = next((p for p in r.ctx.pages if p.url == v["url"]), None)
        r.emit("llm_readability", "schema_validity", base_impact="medium", effort="low", category="schema",
               fix_fraction=0.5, rule_id="schema.product_incomplete",
               title=f"{len(incomplete)} Product şemasındaki eksik alanları tamamlayın",
               description="Eksik/hatalı alanlar zengin sonuç ve AI ürün kartı uygunluğunu düşürür.",
               affected_urls=[x["url"] for x in incomplete],
               evidence=[f"{x['url']}: eksik {', '.join(x['missing_required'] + x['missing_recommended'][:4])}"
                         + (f"; hata: {'; '.join(x['errors'])}" if x["errors"] else "") for x in incomplete[:5]],
               snippet=Snippet("json-ld", sn.product_jsonld(r.ctx, page), None) if page else None)


@rule
def article_schema_author(r: Rules) -> None:
    ef = r.p["eeat"].facts
    no_schema = _pages_missing_family(r, PageType.ARTICLE, "Article")
    targets = sorted(set(ef["articles_without_author"]) | {p.url for p in no_schema})
    if not targets:
        return
    page = next(p for p in r.ctx.pages if p.url == targets[0])
    r.emit("eeat", "experience_expertise", base_impact="high", effort="medium", category="authority",
           rule_id="authority.article_author",
           title=f"{len(targets)} makaleye yazar bilgisi ve Article şeması ekleyin",
           description=("Kimin yazdığı belli olmayan içerik E-E-A-T açısından zayıftır. Görünür bir yazar kutusu "
                        "(ad, unvan, uzmanlık, profil sayfası) ve author bilgisi içeren Article şeması ekleyin."),
           affected_urls=targets,
           evidence=[f"Yazarsız makale: {u}" for u in ef["articles_without_author"][:3]]
           + [f"Article şeması yok: {p.url}" for p in no_schema[:3]],
           snippet=Snippet("json-ld", sn.article_jsonld(r.ctx, page)))


@rule
def breadcrumbs(r: Rules) -> None:
    missing = r.p["llm_readability"].facts["breadcrumb_missing"]
    if not missing:
        return
    page = next(p for p in r.ctx.pages if p.url == missing[0])
    r.emit("llm_readability", "schema_coverage", base_impact="medium", effort="low", category="schema",
           fix_fraction=0.2, rule_id="schema.breadcrumb", title=f"{len(missing)} alt sayfaya BreadcrumbList ekleyin",
           description="Breadcrumb şeması sayfanın site hiyerarşisindeki yerini (kategori → ürün) modele açıkça anlatır.",
           affected_urls=missing, snippet=Snippet("json-ld", sn.breadcrumb_jsonld(r.ctx, page)))


@rule
def low_density(r: Rules) -> None:
    f = r.p["llm_readability"].facts
    low = f["low_density_pages"]
    if not low or not r.failing("llm_readability", "information_density", 75):
        return
    page = next(p for p in r.ctx.pages if p.url == low[0])
    d = f["density"][low[0]]
    r.emit("llm_readability", "information_density", base_impact="medium", effort="medium", category="content",
           rule_id="content.information_density", title=f"{len(low)} sayfada bilgi yoğunluğunu artırın",
           description=("Dolgu metin yerine tablo, madde işareti ve somut rakamlar kullanın; LLM'ler yapılandırılmış ve "
                        "sayısal içeriği daha sık alıntılar."),
           affected_urls=low,
           evidence=[f"{low[0]}: {d['words']} kelime, {d['tables']} tablo, {d['lists']} liste, "
                     f"{d['numbers_per_100w']} veri/100 kelime, paragraf ort. {d['avg_paragraph_words']} kelime"],
           snippet=Snippet("html", sn.density_template(page)))


# ---------------- E-E-A-T / trust ----------------

@rule
def policy_pages(r: Rules) -> None:
    f = r.p["eeat"].facts
    if not f["missing_policies"]:
        return
    r.emit("eeat", "trust", base_impact="high" if f["is_ecommerce"] else "medium", effort="medium",
           category="authority", rule_id="authority.policy_pages", fix_fraction=0.3,
           title="Eksik güven sayfalarını yayınlayın: " + ", ".join(sn.POLICY_TITLES[k][0] for k in f["missing_policies"]),
           description=("Gizlilik, kullanım koşulları ve (e-ticarette) iade/kargo politikaları hem yasal zorunluluk "
                        "(KVKK, Mesafeli Sözleşmeler Yönetmeliği) hem de güven sinyalidir."),
           target_url=r.ctx.origin + "/", evidence=[f"Bulunamadı: {sn.POLICY_TITLES[k][0]}" for k in f["missing_policies"]],
           snippet=Snippet("html", sn.policy_pages_fix(r.ctx, f["missing_policies"])))


@rule
def contact_info(r: Rules) -> None:
    f = r.p["eeat"].facts
    c = f["contact"]
    missing = [n for k, n in (("phones", "telefon"), ("emails", "e-posta"), ("addresses", "fiziksel adres")) if not c[k]]
    if not missing and f["contact_pages"]:
        return
    r.emit("eeat", "trust", base_impact="medium", effort="low", category="authority", rule_id="authority.contact_info",
           fix_fraction=0.25, title="Doğrulanabilir iletişim bilgilerini ekleyin",
           description=("Telefon, e-posta ve açık adresin hem görünür hem de şemada bulunması işletmenin gerçek olduğunu "
                        "doğrular; LLM'ler 'güvenilir mi?' sorularında bu sinyallere bakar."),
           target_url=(f["contact_pages"] or [r.ctx.origin + "/"])[0],
           evidence=[f"Eksik: {', '.join(missing)}"] + ([] if f["contact_pages"] else ["İletişim sayfası bulunamadı"]),
           snippet=Snippet("html", sn.contact_fix(r.ctx, c)))


@rule
def https_hsts(r: Rules) -> None:
    f = r.p["eeat"].facts
    if f["https"] and f["hsts"] and f.get("http_redirects_to_https") is not False:
        return
    issues = ([] if f["https"] else ["Site HTTPS üzerinden sunulmuyor"]) + \
             ([] if f["hsts"] else ["Strict-Transport-Security başlığı yok"]) + \
             (["HTTP → HTTPS yönlendirmesi yok"] if f.get("http_redirects_to_https") is False else [])
    r.emit("eeat", "trust", base_impact="high" if not f["https"] else "low", effort="low", category="technical",
           rule_id="technical.https_hsts", fix_fraction=0.25,
           title="SSL/HTTPS'i zorunlu kılın" if not f["https"] else "HSTS başlığı ve HTTPS yönlendirmesi ekleyin",
           description="Şifreli bağlantı temel güven sinyalidir; tarayıcılar ve arama motorları HTTP sitelerini işaretler.",
           target_url=r.ctx.origin + "/", evidence=issues, snippet=Snippet("nginx", sn.hsts_fix(r.ctx.origin)))


@rule
def unsourced_claims(r: Rules) -> None:
    f = r.p["eeat"].facts
    pages = f["unsourced_claim_pages"]
    if not pages:
        return
    examples = [c for u in pages for c in f["claim_examples"].get(u, [])]
    r.emit("eeat", "factual_consistency", base_impact="medium", effort="medium", category="content",
           rule_id="content.cite_sources", fix_fraction=0.5,
           title=f"{len(pages)} sayfadaki kaynaksız iddialara atıf ekleyin",
           description=("İstatistik ve 'araştırmalara göre' türü iddialar kaynaksız olduğunda LLM'ler içeriği spekülatif "
                        "sayar. Birincil kaynağa (resmî istatistik, DOI'li makale, standart) bağlantı verin."),
           affected_urls=pages, evidence=[f"İddia: “{e[:140]}”" for e in examples[:3]],
           snippet=Snippet("html", sn.citation_fix(examples)))


@rule
def spam_signals(r: Rules) -> None:
    f = r.p["eeat"].facts
    spam = f["spam_pages"]
    if not spam:
        return
    r.emit("eeat", "factual_consistency", base_impact="medium", effort="low", category="content",
           rule_id="content.spam_signals", fix_fraction=0.3,
           title=f"{len(spam)} sayfadaki spam/abartı sinyallerini temizleyin",
           description=("'En iyi', '%100 garanti', 'mucize' gibi doğrulanamaz ifadeler ve anahtar kelime tekrarı içeriği "
                        "reklam/spam olarak sınıflandırtır. Ölçülebilir, kaynaklı ifadelerle değiştirin."),
           affected_urls=sorted(spam), evidence=[f"{u}: {'; '.join(v)}" for u, v in list(spam.items())[:5]],
           snippet=Snippet("text", "Önce: \"Piyasanın en iyi, %100 garantili kahve makinesi!\"\n"
                                      "Sonra: \"15 bar basınç, 25 saniyede espresso; 2 yıl üretici garantisi "
                                      "(TSE belgeli).\""))


@rule
def data_conflicts(r: Rules) -> None:
    f = r.p["eeat"].facts
    if not f["price_conflicts"] and len(f["organization_names"]) <= 2:
        return
    ev = [f"'{c['product']}': " + ", ".join(f"{u} → {p}" for u, p in c["prices"].items()) for c in f["price_conflicts"][:3]]
    if len(f["organization_names"]) > 2:
        ev.append("Kurum adı varyasyonları: " + ", ".join(f["organization_names"]))
    r.emit("eeat", "factual_consistency", base_impact="high", effort="medium", category="content",
           rule_id="content.data_consistency", fix_fraction=0.3,
           title="Sayfalar arası çelişkili verileri tekilleştirin",
           description=("Aynı ürün için farklı fiyatlar veya farklı kurum adları, modellerin hangi bilginin doğru "
                        "olduğuna karar verememesine ve sitenizi kaynak göstermemesine yol açar. Tek veri kaynağından üretin."),
           affected_urls=sorted({u for c in f["price_conflicts"] for u in c["prices"]}), evidence=ev)


# ---------------- technical SEO ----------------

@rule
def meta_descriptions(r: Rules) -> None:
    urls = r.p["technical_seo"].facts["missing_meta_description"]
    if not urls:
        return
    pages = [p for p in r.ctx.pages if p.url in set(urls)]
    r.emit("technical_seo", "meta_description", base_impact="low", effort="low", category="technical",
           rule_id="technical.meta_description", title=f"{len(urls)} sayfaya meta description yazın",
           description="Meta description, AI arama sonuçlarında ve llms.txt'de sayfa özeti olarak kullanılır.",
           affected_urls=urls, snippet=Snippet("html", sn.meta_description_fix(pages)))


@rule
def broken_pages(r: Rules) -> None:
    broken = r.p["technical_seo"].facts["broken"]
    if not broken:
        return
    r.emit("technical_seo", "broken_pages", base_impact="medium", effort="low", category="technical",
           rule_id="technical.broken_pages", title=f"{len(broken)} kırık URL'yi düzeltin veya yönlendirin",
           description="Kırık iç linkler tarama bütçesini harcar ve botların önemli sayfalara ulaşmasını engeller.",
           affected_urls=[b["url"] for b in broken], evidence=[f"{b['url']} → {b['status'] or b['error']}" for b in broken[:5]],
           snippet=Snippet("nginx", "\n".join(f"rewrite ^{urlsplit(b['url']).path}$ /hedef-sayfa permanent;  # TODO hedef URL"
                                                for b in broken[:5]), None,
                              "Kalıcı olarak kaldırılan sayfaları en yakın içerikli sayfaya 301 ile yönlendirin."))


@rule
def thin_content(r: Rules) -> None:
    thin = r.p["technical_seo"].facts["thin"]
    if len(thin) < 2 and not r.failing("technical_seo", "thin_content", 80):
        return
    if not thin:
        return
    r.emit("technical_seo", "thin_content", base_impact="medium", effort="high", category="content",
           rule_id="content.thin_content", title=f"{len(thin)} ince içerikli sayfayı genişletin",
           description="150 kelimenin altındaki sayfalar cevap motorları için yeterli bağlam sağlamaz.",
           affected_urls=thin)


ACCESS_RULES = (site_unreachable, ai_bots_blocked, waf_blocks_ai)


def generate_actions(ctx: AuditContext, pillars: dict[str, Pillar]) -> list[ActionCard]:
    r = Rules(ctx, pillars)
    # nothing was fetched: content/schema advice would be guesswork — only access blockers are reported
    for fn in (RULES if ctx.pages else ACCESS_RULES):
        fn(r)
    return sorted(r.cards, key=lambda c: (-c.priority, c.rule_id))
