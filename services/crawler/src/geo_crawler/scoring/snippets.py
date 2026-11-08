"""Copy-paste-ready fixes (robots.txt, llms.txt, JSON-LD, server config) generated from crawl data."""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlsplit

from ..extractor import page_id
from ..models import PageData, PageType, RelationType
from .base import AuditContext
from .robots import AI_BOTS

TODO = "TODO"


def jsonld(obj: dict[str, Any]) -> str:
    return ('<script type="application/ld+json">\n'
            + json.dumps({"@context": "https://schema.org", **obj}, ensure_ascii=False, indent=2)
            + "\n</script>")


def site_name(ctx: AuditContext) -> str:
    home = next((p for p in ctx.pages if p.page_type is PageType.HOME), None)
    if home:
        if home.open_graph.get("site_name"):
            return home.open_graph["site_name"]
        if home.title:
            return home.title.split("|")[0].split(" - ")[0].strip()
    return urlsplit(ctx.origin).hostname or ctx.origin


def site_summary(ctx: AuditContext) -> str:
    home = next((p for p in ctx.pages if p.page_type is PageType.HOME), None)
    if home:
        d = home.meta.get("description") or home.open_graph.get("description")
        if d:
            return d
    return f"{site_name(ctx)} resmi web sitesi."


# ---------- crawler / access ----------

def robots_txt_fix(ctx: AuditContext, blocked: list[str]) -> str:
    tokens = blocked or [b.token for b in AI_BOTS]
    lines = ["# --- AI arama ve cevap motorları (GEO) ---"]
    for t in tokens:
        lines += [f"User-agent: {t}", "Allow: /", ""]
    lines += ["# Özel alanlar yine kapalı kalabilir:", "User-agent: *", "Disallow: /admin/", "Disallow: /sepet/",
              "", f"Sitemap: {ctx.origin}/sitemap.xml"]
    return "\n".join(lines)


def waf_fix() -> str:
    return """# Cloudflare → Security → WAF → Custom rules → "Skip" (Bot Fight Mode / Super Bot Fight Mode'dan önce)
(http.user_agent contains "GPTBot") or (http.user_agent contains "OAI-SearchBot") or
(http.user_agent contains "ChatGPT-User") or (http.user_agent contains "ClaudeBot") or
(http.user_agent contains "Claude-User") or (http.user_agent contains "PerplexityBot") or
(cf.verified_bot_category in {"AI Crawler" "AI Search" "AI Assistant"})

# Cloudflare → Security → Bots → "Block AI bots" ve "AI Labyrinth" ayarlarını kapatın.

# nginx'te UA tabanlı engel varsa istisna ekleyin:
map $http_user_agent $is_ai_bot {
    default 0;
    ~*(GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-User|PerplexityBot|Google-Extended|Applebot) 1;
}
# ... mevcut "deny"/"return 403" kuralınızı `if ($is_ai_bot = 0) { ... }` içine alın."""


def directive_fix(examples: list[str]) -> str:
    found = "\n".join(f"<!-- KALDIRIN: {e} -->" for e in examples[:3]) if examples else ""
    return f"""{found}
<!-- Yerine: -->
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">

# Sunucu başlığı (nginx) — noai / noindex içeren X-Robots-Tag'i kaldırın:
# add_header X-Robots-Tag "noindex, noai";   ← silin
add_header X-Robots-Tag "index, follow" always;""".strip()


def ssr_fix(example_url: str) -> str:
    return f"""// AI botları JavaScript çalıştırmaz; {example_url} ilk HTML'de içerik döndürmeli.
// Next.js (App Router) — sayfayı Server Component olarak render edin:
// app/urun/[slug]/page.tsx
export const revalidate = 3600; // ISR: saatte bir statik yeniden üretim

export default async function ProductPage({{ params }}: {{ params: Promise<{{ slug: string }}> }}) {{
  const {{ slug }} = await params;
  const product = await getProduct(slug); // sunucuda veri çek (useEffect + fetch DEĞİL)
  return (
    <article>
      <h1>{{product.name}}</h1>
      <p>{{product.summary}}</p>
      <ProductSpecsTable specs={{product.specs}} />
    </article>
  );
}}

// React SPA (Vite/CRA) için geçiş mümkün değilse: prerender (ör. prerender.io / rendertron)
// nginx: bot UA'larını prerender servisine yönlendirin
// if ($http_user_agent ~* "GPTBot|ClaudeBot|PerplexityBot|OAI-SearchBot|ChatGPT-User|bingbot") {{
//     rewrite .* /render?url=$scheme://$host$request_uri break;
//     proxy_pass http://prerender:3000;
// }}"""


def llms_txt(ctx: AuditContext, max_links: int = 12) -> str:
    groups: list[tuple[str, tuple[PageType, ...]]] = [
        ("Ürünler", (PageType.PRODUCT,)), ("Hizmetler", (PageType.SERVICE,)), ("Kategoriler", (PageType.CATEGORY,)),
        ("Rehberler ve Blog", (PageType.ARTICLE,)), ("Sıkça Sorulan Sorular", (PageType.FAQ,)),
        ("Kurumsal", (PageType.ABOUT, PageType.CONTACT)),
    ]
    out = [f"# {site_name(ctx)}", "", f"> {site_summary(ctx)}", ""]
    pr = ctx.graph.pagerank()
    ranked = sorted(ctx.pages, key=lambda p: -pr.get(page_id(p.url), 0))
    for title, types in groups:
        items = [p for p in ranked if p.page_type in types][:max_links]
        if not items:
            continue
        out += [f"## {title}", ""]
        for p in items:
            desc = (p.meta.get("description") or p.open_graph.get("description") or "").strip()
            label = (p.headings.get("h1") or [p.title or p.url])[0]
            out.append(f"- [{label}]({p.url})" + (f": {desc[:160]}" if desc else ""))
        out.append("")
    out += ["## Optional", "", f"- [Sitemap]({ctx.origin}/sitemap.xml)"]
    return "\n".join(out)


# ---------- schema ----------

def faq_jsonld(pairs: list[dict[str, str]]) -> str:
    return jsonld({"@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": q["question"],
         "acceptedAnswer": {"@type": "Answer", "text": (q.get("answer") or TODO)[:600]}} for q in pairs[:10]]})


def qa_block_template(p: PageData) -> str:
    topic = (p.headings.get("h1") or [p.title or "Bu ürün"])[0]
    return f"""<section id="sss">
  <h2>{topic} hakkında sık sorulan sorular</h2>
  <h3>{topic} nedir / ne işe yarar?</h3>
  <p><!-- 1-2 cümlede doğrudan cevap, 40-60 kelime. İlk cümle soruyu tekrar etmeden cevaplasın. --></p>
  <h3>{topic} fiyatı ne kadar, neler dahil?</h3>
  <p><!-- Net rakam + birim: "12.499 TL, 2 yıl garanti ve ücretsiz kargo dahil." --></p>
  <h3>{topic} kimler için uygun değil?</h3>
  <p><!-- Dürüst sınırlamalar güven sinyalidir. --></p>
</section>
<!-- Ardından aynı soruları FAQPage JSON-LD olarak ekleyin. -->"""


def organization_jsonld(ctx: AuditContext, same_as: list[str], contact: dict[str, list[str]], kind: str = "Organization") -> str:
    home = next((p for p in ctx.pages if p.page_type is PageType.HOME), None)
    social = same_as or sorted({link.url for p in ctx.pages for link in p.external_links
                                if any(s in link.url for s in ("instagram.com", "facebook.com", "linkedin.com",
                                                               "x.com", "twitter.com", "youtube.com"))})[:6]
    obj: dict[str, Any] = {
        "@type": kind, "name": site_name(ctx), "url": ctx.origin + "/",
        "logo": (home.open_graph.get("image") if home else None) or f"{ctx.origin}/logo.png",
        "description": site_summary(ctx),
        "sameAs": social or [f"https://www.linkedin.com/company/{TODO}", f"https://www.wikidata.org/wiki/{TODO}"],
        "contactPoint": {"@type": "ContactPoint", "contactType": "customer service",
                         "telephone": (contact.get("phones") or [f"+90-{TODO}"])[0],
                         "email": (contact.get("emails") or [f"info@{urlsplit(ctx.origin).hostname}"])[0],
                         "availableLanguage": ["Turkish", "English"]},
        "address": {"@type": "PostalAddress", "streetAddress": TODO, "addressLocality": TODO, "addressCountry": "TR"},
    }
    return jsonld(obj)


def product_jsonld(ctx: AuditContext, p: PageData) -> str:
    props: dict[str, Any] = {}
    brand = None
    pid = page_id(p.url)
    if ctx.graph.g.has_node(pid):
        for prod in ctx.graph.neighbors(pid, RelationType.CONTAINS_PRODUCT):
            props = ctx.graph.g.nodes[prod].get("properties", {})
            brands = ctx.graph.neighbors(prod, RelationType.HAS_BRAND)
            brand = ctx.graph.g.nodes[brands[0]]["label"] if brands else None
            break
    price = props.get("price")
    avail = props.get("availability") or "InStock"
    obj = {
        "@type": "Product", "name": (p.headings.get("h1") or [p.title])[0] or TODO,
        "description": p.meta.get("description") or p.open_graph.get("description") or TODO,
        "image": p.open_graph.get("image") or props.get("image") or TODO, "sku": props.get("sku") or TODO,
        "brand": {"@type": "Brand", "name": brand or TODO},
        "offers": {"@type": "Offer", "url": p.url, "price": f"{price:.2f}" if isinstance(price, (int, float)) else TODO,
                   "priceCurrency": props.get("currency") or "TRY",
                   "availability": f"https://schema.org/{avail}", "itemCondition": "https://schema.org/NewCondition"},
    }
    if props.get("rating"):
        obj["aggregateRating"] = {"@type": "AggregateRating", "ratingValue": props["rating"],
                                  "reviewCount": props.get("review_count") or 1}
    return jsonld(obj)


def article_jsonld(ctx: AuditContext, p: PageData) -> str:
    hint = ((p.content_stats or {}).get("author_hints") or [p.meta.get("author") or ""])[0]
    props = ctx.graph.g.nodes[page_id(p.url)].get("properties", {}) if ctx.graph.g.has_node(page_id(p.url)) else {}
    published = props.get("date_published") or ((p.content_stats or {}).get("time_tags") or [TODO])[0]
    return jsonld({
        "@type": "Article", "headline": (p.headings.get("h1") or [p.title])[0] or TODO,
        "image": p.open_graph.get("image") or TODO, "datePublished": published,
        "dateModified": props.get("date_modified") or published,
        "author": {"@type": "Person", "name": hint or TODO, "jobTitle": TODO,
                   "url": f"{ctx.origin}/yazar/{TODO}", "sameAs": [f"https://www.linkedin.com/in/{TODO}"]},
        "publisher": {"@type": "Organization", "name": site_name(ctx), "logo": {"@type": "ImageObject",
                                                                             "url": f"{ctx.origin}/logo.png"}},
        "mainEntityOfPage": p.url,
    })


def breadcrumb_jsonld(ctx: AuditContext, p: PageData) -> str:
    if p.breadcrumbs:
        names = p.breadcrumbs
        urls: list[str | None] = [None] * len(names)
    else:
        segs = [s for s in urlsplit(p.url).path.split("/") if s]
        names = ["Anasayfa"] + [s.replace("-", " ").title() for s in segs]
        urls = [ctx.origin + "/"] + [ctx.origin + "/" + "/".join(segs[:i + 1]) for i in range(len(segs))]
    items = []
    for i, name in enumerate(names):
        it: dict[str, Any] = {"@type": "ListItem", "position": i + 1, "name": name}
        if i < len(names) - 1:
            it["item"] = urls[i] or TODO
        items.append(it)
    return jsonld({"@type": "BreadcrumbList", "itemListElement": items})


# ---------- content / trust ----------

def density_template(p: PageData) -> str:
    topic = (p.headings.get("h1") or [p.title or "Ürün"])[0]
    return f"""<!-- Uzun paragrafları AI'ın alıntılayabileceği yapılara bölün -->
<p><strong>Özet:</strong> {topic}, <!-- tek cümlelik net tanım + en önemli 1 rakam --></p>

<h2>Teknik özellikler</h2>
<table>
  <tr><th>Özellik</th><th>Değer</th></tr>
  <tr><td>Güç</td><td>1.450 W</td></tr>
  <tr><td>Kapasite</td><td>1,8 L</td></tr>
  <tr><td>Garanti</td><td>2 yıl</td></tr>
</table>

<h2>Öne çıkanlar</h2>
<ul>
  <li><!-- Ölçülebilir fayda: "25 saniyede espresso" --></li>
  <li><!-- Karşılaştırma: "X modeline göre %30 daha sessiz (52 dB)" --></li>
</ul>
<!-- Kaçının: "günümüzde", "son derece", "hepimizin bildiği gibi" gibi dolgu ifadeler. -->"""


POLICY_TITLES = {"privacy": ("Gizlilik ve KVKK Aydınlatma Metni", "/gizlilik-politikasi"),
                 "terms": ("Kullanım Koşulları / Mesafeli Satış Sözleşmesi", "/kullanim-kosullari"),
                 "returns": ("İade ve Cayma Hakkı Politikası", "/iade-politikasi"),
                 "shipping": ("Kargo ve Teslimat Bilgileri", "/kargo-teslimat")}


def policy_pages_fix(ctx: AuditContext, missing: list[str]) -> str:
    links = "\n".join(f'    <li><a href="{POLICY_TITLES[k][1]}">{POLICY_TITLES[k][0]}</a></li>' for k in missing)
    pages = "\n".join(
        f"""<!-- {POLICY_TITLES[k][1]} -->
{jsonld({"@type": "WebPage", "name": POLICY_TITLES[k][0], "url": ctx.origin + POLICY_TITLES[k][1],
         "dateModified": TODO, "publisher": {"@type": "Organization", "name": site_name(ctx)}})}""" for k in missing)
    return f"""<!-- 1) Footer'a (tüm sayfalarda) bağlantı ekleyin -->
<footer>
  <ul>
{links}
  </ul>
</footer>

<!-- 2) Her politika sayfasına güncelleme tarihi içeren WebPage şeması -->
{pages}"""


def contact_fix(ctx: AuditContext, contact: dict[str, list[str]]) -> str:
    phone = (contact.get("phones") or ["+90 212 000 00 00"])[0]
    email = (contact.get("emails") or [f"info@{urlsplit(ctx.origin).hostname}"])[0]
    return f"""<!-- İletişim sayfası + footer: makinece okunabilir ve doğrulanabilir iletişim -->
<address>
  <strong>{site_name(ctx)}</strong><br>
  Örnek Mah. Örnek Cad. No:1, 34000 İstanbul, Türkiye<br>
  Tel: <a href="tel:{phone.replace(' ', '')}">{phone}</a><br>
  E-posta: <a href="mailto:{email}">{email}</a><br>
  MERSİS / Vergi No: {TODO}
</address>
{jsonld({"@type": "Organization", "name": site_name(ctx), "url": ctx.origin + "/",
         "contactPoint": {"@type": "ContactPoint", "telephone": phone, "email": email,
                          "contactType": "customer service", "areaServed": "TR"},
         "address": {"@type": "PostalAddress", "streetAddress": TODO, "addressLocality": "İstanbul",
                     "postalCode": TODO, "addressCountry": "TR"}})}"""


def citation_fix(examples: list[str]) -> str:
    ex = examples[0] if examples else "Araştırmalara göre kullanıcıların %70'i ..."
    return f"""<!-- Kaynaksız iddia: "{ex[:160]}" -->
<p>
  {ex[:160]}
  <sup><a href="#kaynak-1" id="ref-1">[1]</a></sup>
</p>

<section id="kaynaklar">
  <h2>Kaynaklar</h2>
  <ol>
    <li id="kaynak-1">
      <cite><a href="https://doi.org/{TODO}" rel="noopener">Yazar, A. (2025). Çalışma başlığı. Dergi Adı.</a></cite>
      <a href="#ref-1">↩</a>
    </li>
  </ol>
</section>
<!-- Article şemasına da ekleyin: "citation": ["https://doi.org/..."] -->"""


def hsts_fix(origin: str) -> str:
    host = urlsplit(origin).hostname
    return f"""# nginx — HTTP'yi kalıcı olarak HTTPS'e yönlendir + HSTS
server {{
    listen 80;
    server_name {host};
    return 301 https://$host$request_uri;
}}
server {{
    listen 443 ssl http2;
    server_name {host};
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    # ssl_certificate /etc/letsencrypt/live/{host}/fullchain.pem;   # certbot --nginx -d {host}
}}"""


def meta_description_fix(pages: list[PageData]) -> str:
    out = []
    for p in pages[:5]:
        lead = ((p.content_stats or {}).get("first_paragraph") or p.text)[:155].rsplit(" ", 1)[0]
        out.append(f'<!-- {p.url} -->\n<meta name="description" content="{lead.replace(chr(34), "")}">')
    return "\n".join(out)
