"""Copy-paste-ready fixes (robots.txt, llms.txt, JSON-LD, server config) generated from crawl data.

Only the human-readable parts (comments inside the generated snippets, example text, placeholder values) are
localized, through the ``snippets.*`` message catalog; code, JSON-LD keys and schema.org terms are language-neutral.
Catalog messages never contain literal braces: code that needs braces is built in Python and joined with the
translated comment lines.
"""
from __future__ import annotations

import json
from collections import Counter
from typing import Any
from urllib.parse import urlsplit

from ..extractor import page_id
from ..i18n import DEFAULT_LANG, Translator, get_translator
from ..models import PageData, PageType, RelationType
from .base import AuditContext
from .robots import AI_BOTS

TODO = "TODO"
POLICY_KINDS = ("privacy", "terms", "returns", "shipping")


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
    return ctx.t("snippets.site_summary_default", name=site_name(ctx))


def _site_languages(ctx: AuditContext) -> list[str]:
    """BCP 47 primary language codes of the crawled pages, most common first (schema.org ``availableLanguage``).

    Falls back to the report language when no page declares ``<html lang>``."""
    counts = Counter(p.lang.split("-")[0].lower() for p in ctx.pages if p.lang)
    return [code for code, _ in counts.most_common(3)] or [ctx.lang]


def policy_info(t: Translator, kind: str) -> tuple[str, str]:
    """(page title, URL path) of a policy page kind (privacy | terms | returns | shipping)."""
    return t(f"snippets.policy.{kind}.title"), t(f"snippets.policy.{kind}.path")


# ---------- crawler / access ----------

def robots_txt_fix(ctx: AuditContext, blocked: list[str]) -> str:
    t = ctx.t
    tokens = blocked or [b.token for b in AI_BOTS]
    lines = [t("snippets.robots.header")]
    for token in tokens:
        lines += [f"User-agent: {token}", "Allow: /", ""]
    lines += [t("snippets.robots.private_comment"), "User-agent: *", "Disallow: /admin/",
              f"Disallow: {t('snippets.robots.cart_path')}", "", f"Sitemap: {ctx.origin}/sitemap.xml"]
    return "\n".join(lines)


def waf_fix(*, lang: str = DEFAULT_LANG) -> str:
    t = get_translator(lang)
    return "\n".join([
        t("snippets.waf.cloudflare_rule"),
        '(http.user_agent contains "GPTBot") or (http.user_agent contains "OAI-SearchBot") or',
        '(http.user_agent contains "ChatGPT-User") or (http.user_agent contains "ClaudeBot") or',
        '(http.user_agent contains "Claude-User") or (http.user_agent contains "PerplexityBot") or',
        '(cf.verified_bot_category in {"AI Crawler" "AI Search" "AI Assistant"})',
        "",
        t("snippets.waf.cloudflare_bots"),
        "",
        t("snippets.waf.nginx_intro"),
        "map $http_user_agent $is_ai_bot {",
        "    default 0;",
        "    ~*(GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-User|PerplexityBot|Google-Extended|Applebot) 1;",
        "}",
        t("snippets.waf.nginx_wrap", code="`if ($is_ai_bot = 0) { ... }`"),
    ])


def directive_fix(examples: list[str], *, lang: str = DEFAULT_LANG) -> str:
    t = get_translator(lang)
    lines = [t("snippets.directive.remove", example=e) for e in examples[:3]]
    lines += [
        t("snippets.directive.replace_with"),
        '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">',
        "",
        t("snippets.directive.header_comment"),
        t("snippets.directive.delete_line"),
        'add_header X-Robots-Tag "index, follow" always;',
    ]
    return "\n".join(lines).strip()


def ssr_fix(example_url: str, *, lang: str = DEFAULT_LANG) -> str:
    t = get_translator(lang)
    return "\n".join([
        t("snippets.ssr.intro", url=example_url),
        t("snippets.ssr.next_comment"),
        t("snippets.ssr.file_comment"),
        "export const revalidate = 3600; " + t("snippets.ssr.revalidate_comment"),
        "",
        "export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {",
        "  const { slug } = await params;",
        "  const product = await getProduct(slug); " + t("snippets.ssr.fetch_comment"),
        "  return (",
        "    <article>",
        "      <h1>{product.name}</h1>",
        "      <p>{product.summary}</p>",
        "      <ProductSpecsTable specs={product.specs} />",
        "    </article>",
        "  );",
        "}",
        "",
        t("snippets.ssr.spa_comment"),
        t("snippets.ssr.nginx_comment"),
        '// if ($http_user_agent ~* "GPTBot|ClaudeBot|PerplexityBot|OAI-SearchBot|ChatGPT-User|bingbot") {',
        "//     rewrite .* /render?url=$scheme://$host$request_uri break;",
        "//     proxy_pass http://prerender:3000;",
        "// }",
    ])


def llms_txt(ctx: AuditContext, max_links: int = 12) -> str:
    t = ctx.t
    groups: list[tuple[str, tuple[PageType, ...]]] = [
        (t("snippets.llms.group.products"), (PageType.PRODUCT,)),
        (t("snippets.llms.group.services"), (PageType.SERVICE,)),
        (t("snippets.llms.group.categories"), (PageType.CATEGORY,)),
        (t("snippets.llms.group.guides"), (PageType.ARTICLE,)),
        (t("snippets.llms.group.faq"), (PageType.FAQ,)),
        (t("snippets.llms.group.company"), (PageType.ABOUT, PageType.CONTACT)),
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
    out += ["## Optional", "", f"- [Sitemap]({ctx.origin}/sitemap.xml)"]  # "Optional" is a reserved llms.txt heading
    return "\n".join(out)


# ---------- schema ----------

def faq_jsonld(pairs: list[dict[str, str]]) -> str:
    return jsonld({"@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": q["question"],
         "acceptedAnswer": {"@type": "Answer", "text": (q.get("answer") or TODO)[:600]}} for q in pairs[:10]]})


def qa_block_template(p: PageData, *, lang: str = DEFAULT_LANG) -> str:
    t = get_translator(lang)
    topic = (p.headings.get("h1") or [p.title or t("snippets.qa.default_topic")])[0]
    return t("snippets.qa.template", topic=topic)


def organization_jsonld(ctx: AuditContext, same_as: list[str], contact: dict[str, list[str]], kind: str = "Organization") -> str:
    t = ctx.t
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
                         "telephone": (contact.get("phones") or [t("snippets.default.phone_jsonld")])[0],
                         "email": (contact.get("emails") or [f"info@{urlsplit(ctx.origin).hostname}"])[0],
                         "availableLanguage": _site_languages(ctx)},
        "address": {"@type": "PostalAddress", "streetAddress": TODO, "addressLocality": TODO,
                    "addressCountry": t("snippets.default.country")},
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
                   "priceCurrency": props.get("currency") or ctx.t("snippets.default.currency"),
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
                   "url": f"{ctx.origin}{ctx.t('snippets.default.author_path')}{TODO}",
                   "sameAs": [f"https://www.linkedin.com/in/{TODO}"]},
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
        names = [ctx.t("snippets.breadcrumb.home")] + [s.replace("-", " ").title() for s in segs]
        urls = [ctx.origin + "/"] + [ctx.origin + "/" + "/".join(segs[:i + 1]) for i in range(len(segs))]
    items = []
    for i, name in enumerate(names):
        it: dict[str, Any] = {"@type": "ListItem", "position": i + 1, "name": name}
        if i < len(names) - 1:
            it["item"] = urls[i] or TODO
        items.append(it)
    return jsonld({"@type": "BreadcrumbList", "itemListElement": items})


# ---------- content / trust ----------

def density_template(p: PageData, *, lang: str = DEFAULT_LANG) -> str:
    t = get_translator(lang)
    topic = (p.headings.get("h1") or [p.title or t("snippets.density.default_topic")])[0]
    return t("snippets.density.template", topic=topic)


def policy_pages_fix(ctx: AuditContext, missing: list[str]) -> str:
    t = ctx.t
    info = {k: policy_info(t, k) for k in missing}
    links = "\n".join(f'    <li><a href="{info[k][1]}">{info[k][0]}</a></li>' for k in missing)
    pages = "\n".join(
        f"""<!-- {info[k][1]} -->
{jsonld({"@type": "WebPage", "name": info[k][0], "url": ctx.origin + info[k][1],
         "dateModified": TODO, "publisher": {"@type": "Organization", "name": site_name(ctx)}})}""" for k in missing)
    return "\n".join([
        t("snippets.policy.footer_comment"),
        "<footer>",
        "  <ul>",
        links,
        "  </ul>",
        "</footer>",
        "",
        t("snippets.policy.pages_comment"),
        pages,
    ])


def contact_fix(ctx: AuditContext, contact: dict[str, list[str]]) -> str:
    t = ctx.t
    phone = (contact.get("phones") or [t("snippets.default.phone")])[0]
    email = (contact.get("emails") or [f"info@{urlsplit(ctx.origin).hostname}"])[0]
    return "\n".join([
        t("snippets.contact.comment"),
        "<address>",
        f"  <strong>{site_name(ctx)}</strong><br>",
        f"  {t('snippets.contact.sample_address')}<br>",
        f"  {t('snippets.contact.phone_label')}: <a href=\"tel:{phone.replace(' ', '')}\">{phone}</a><br>",
        f"  {t('snippets.contact.email_label')}: <a href=\"mailto:{email}\">{email}</a><br>",
        f"  {t('snippets.contact.registry_label')}: {TODO}",
        "</address>",
        jsonld({"@type": "Organization", "name": site_name(ctx), "url": ctx.origin + "/",
                "contactPoint": {"@type": "ContactPoint", "telephone": phone, "email": email,
                                 "contactType": "customer service",
                                 "areaServed": t("snippets.default.country")},
                "address": {"@type": "PostalAddress", "streetAddress": TODO,
                            "addressLocality": t("snippets.default.locality"),
                            "postalCode": TODO, "addressCountry": t("snippets.default.country")}}),
    ])


def citation_fix(examples: list[str], *, lang: str = DEFAULT_LANG) -> str:
    t = get_translator(lang)
    claim = (examples[0] if examples else t("snippets.citation.default_claim"))[:160]
    return t("snippets.citation.template", claim=claim, todo=TODO)


def hsts_fix(origin: str, *, lang: str = DEFAULT_LANG) -> str:
    t = get_translator(lang)
    host = urlsplit(origin).hostname
    return f"""{t("snippets.hsts.comment")}
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
