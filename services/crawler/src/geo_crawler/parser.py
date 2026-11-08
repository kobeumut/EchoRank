"""HTML -> PageData parsing (headings, meta, OG, Twitter, JSON-LD, microdata, text, links)."""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from bs4 import BeautifulSoup, Tag

from .models import Link, PageData
from .urls import is_crawlable_resource, is_internal, normalize_url

log = logging.getLogger(__name__)

_WS = re.compile(r"\s+")
_NOISE_TAGS = ("script", "style", "noscript", "template", "svg", "iframe")


def _clean(text: str | None) -> str:
    return _WS.sub(" ", text or "").strip()


def _parse_json_ld(soup: BeautifulSoup) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for script in soup.find_all("script", attrs={"type": re.compile(r"application/ld\+json", re.I)}):
        raw = script.string or script.get_text() or ""
        raw = raw.strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            # common breakage: trailing commas / control chars
            try:
                data = json.loads(re.sub(r",\s*([}\]])", r"\1", raw), strict=False)
            except json.JSONDecodeError:
                log.debug("invalid JSON-LD block skipped")
                continue
        blocks.extend(flatten_json_ld(data))
    return blocks


def flatten_json_ld(data: Any) -> list[dict[str, Any]]:
    """Flatten lists and @graph containers into a list of typed nodes."""
    out: list[dict[str, Any]] = []
    if isinstance(data, list):
        for item in data:
            out.extend(flatten_json_ld(item))
    elif isinstance(data, dict):
        if "@graph" in data and isinstance(data["@graph"], list):
            for item in data["@graph"]:
                out.extend(flatten_json_ld(item))
        else:
            out.append(data)
    return out


_MICRODATA_ATTR = {
    "meta": "content", "a": "href", "link": "href", "area": "href", "img": "src",
    "audio": "src", "video": "src", "source": "src", "iframe": "src", "embed": "src",
    "object": "data", "time": "datetime", "data": "value", "meter": "value",
}


def _microdata_value(el: Tag) -> Any:
    if el.has_attr("itemscope"):
        return _parse_item(el)
    if el.has_attr("content"):
        return _clean(str(el["content"]))
    attr = _MICRODATA_ATTR.get(el.name)
    if attr and el.has_attr(attr):
        return str(el[attr]).strip()
    return _clean(el.get_text(" "))


def _parse_item(scope: Tag) -> dict[str, Any]:
    item: dict[str, Any] = {}
    itemtype = scope.get("itemtype")
    if itemtype:
        item["@type"] = itemtype.rsplit("/", 1)[-1] if isinstance(itemtype, str) else itemtype
    for el in scope.find_all(attrs={"itemprop": True}):
        # only direct properties: nearest itemscope ancestor must be `scope`
        parent = el.find_parent(attrs={"itemscope": True})
        if parent is not scope:
            continue
        names = el["itemprop"].split() if isinstance(el["itemprop"], str) else el["itemprop"]
        value = _microdata_value(el)
        for name in names:
            if name in item:
                if not isinstance(item[name], list):
                    item[name] = [item[name]]
                item[name].append(value)
            else:
                item[name] = value
    return item


def _parse_microdata(soup: BeautifulSoup) -> list[dict[str, Any]]:
    items = []
    for scope in soup.find_all(attrs={"itemscope": True}):
        # top-level items only (nested ones are embedded into their parent)
        if scope.has_attr("itemprop") and scope.find_parent(attrs={"itemscope": True}):
            continue
        items.append(_parse_item(scope))
    return items


def _parse_breadcrumbs(soup: BeautifulSoup, json_ld: list[dict[str, Any]]) -> list[str]:
    for block in json_ld:
        if _type_matches(block, "BreadcrumbList"):
            names = []
            for el in block.get("itemListElement", []) or []:
                if isinstance(el, dict):
                    item = el.get("item")
                    name = el.get("name") or (item.get("name") if isinstance(item, dict) else None)
                    if name:
                        names.append(_clean(str(name)))
            if names:
                return names
    nav = soup.find(attrs={"aria-label": re.compile("breadcrumb", re.I)}) or soup.find(
        class_=re.compile("breadcrumb", re.I)
    )
    if nav:
        crumbs = [_clean(a.get_text(" ")) for a in nav.find_all(["a", "span", "li"]) if _clean(a.get_text(" "))]
        # dedupe preserving order (li wraps a)
        seen, out = set(), []
        for c in crumbs:
            if c not in seen:
                seen.add(c)
                out.append(c)
        return out
    return []


def _parse_html_faqs(soup: BeautifulSoup, limit: int = 50) -> list[dict[str, str]]:
    """Detect Q/A pairs without schema: <details><summary>, <dt>/<dd>, and question headings."""
    pairs: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(q: str, a: str) -> None:
        q, a = _clean(q), _clean(a)
        if q and a and q.lower() not in seen and len(pairs) < limit:
            seen.add(q.lower())
            pairs.append({"question": q, "answer": a[:2000]})

    for det in soup.find_all("details"):
        summary = det.find("summary")
        if summary:
            q = summary.get_text(" ")
            a = det.get_text(" ").replace(summary.get_text(" "), "", 1)
            add(q, a)
    for dt in soup.find_all("dt"):
        dd = dt.find_next_sibling("dd")
        if dd and _clean(dt.get_text(" ")).endswith("?"):
            add(dt.get_text(" "), dd.get_text(" "))
    for h in soup.find_all(["h2", "h3", "h4", "h5"]):
        q = _clean(h.get_text(" "))
        if not q.endswith("?"):
            continue
        answer_parts = []
        for sib in h.find_next_siblings():
            if sib.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
                break
            answer_parts.append(sib.get_text(" "))
            if len(answer_parts) >= 3:
                break
        add(q, " ".join(answer_parts))
    return pairs


def _type_matches(block: dict[str, Any], name: str) -> bool:
    t = block.get("@type")
    if isinstance(t, list):
        return any(str(x).rsplit("/", 1)[-1] == name for x in t)
    return isinstance(t, str) and t.rsplit("/", 1)[-1] == name


def parse_html(html: str | bytes, url: str, root_url: str | None = None, status_code: int = 200, depth: int = 0) -> PageData:
    soup = BeautifulSoup(html, "lxml")
    root_url = root_url or url
    page = PageData(url=url, status_code=status_code, depth=depth)

    html_tag = soup.find("html")
    if html_tag and html_tag.get("lang"):
        page.lang = str(html_tag["lang"]).strip()
    if soup.title:
        page.title = _clean(soup.title.get_text())

    for m in soup.find_all("meta"):
        content = m.get("content")
        if content is None:
            continue
        content = _clean(str(content))
        prop = (m.get("property") or "").strip().lower()
        name = (m.get("name") or "").strip().lower()
        if prop.startswith("og:") or name.startswith("og:"):
            page.open_graph[(prop or name)[3:]] = content
        elif name.startswith("twitter:") or prop.startswith("twitter:"):
            page.twitter[(name or prop)[8:]] = content
        elif name:
            page.meta[name] = content
        elif prop:
            page.meta[prop] = content

    canonical = soup.find("link", rel=lambda v: v and "canonical" in (v if isinstance(v, list) else [v]))
    if canonical and canonical.get("href"):
        page.canonical = normalize_url(canonical["href"], url) or ""

    page.json_ld = _parse_json_ld(soup)
    page.microdata = _parse_microdata(soup)
    page.breadcrumbs = _parse_breadcrumbs(soup, page.json_ld)

    for level in range(1, 7):
        hs = [_clean(h.get_text(" ")) for h in soup.find_all(f"h{level}")]
        hs = [h for h in hs if h]
        if hs:
            page.headings[f"h{level}"] = hs

    # links (before noise removal so nav links are kept)
    seen_links: set[str] = set()
    base_tag = soup.find("base", href=True)
    base = normalize_url(base_tag["href"], url) if base_tag else url
    for a in soup.find_all("a", href=True):
        target = normalize_url(a["href"], base)
        if not target or target in seen_links:
            continue
        seen_links.add(target)
        rel = a.get("rel") or []
        rel = rel if isinstance(rel, list) else [rel]
        in_nav = a.find_parent(["nav", "header", "footer", "aside"]) is not None or a.find_parent(
            class_=re.compile(r"(^|[-_ ])(nav|menu|sidebar|footer|header|breadcrumb)", re.I)
        ) is not None
        link = Link(url=target, text=_clean(a.get_text(" "))[:200], nofollow="nofollow" in rel, in_nav=in_nav)
        if is_internal(target, root_url):
            if is_crawlable_resource(target):
                page.internal_links.append(link)
        else:
            link.internal = False
            page.external_links.append(link)

    page.faqs = _parse_html_faqs(soup)

    stats = _raw_stats(soup, html)
    for tag in soup.find_all(_NOISE_TAGS):
        tag.decompose()
    # template chrome is excluded from body text (keeps keywords/word counts content-focused)
    for tag in soup.find_all(["nav", "header", "footer", "aside"]):
        tag.decompose()
    body = soup.body or soup
    stats.update(_content_stats(body))
    page.text = _clean(body.get_text(" "))
    page.word_count = len(page.text.split())
    stats["text_bytes"] = len(page.text.encode("utf-8"))
    stats["text_ratio"] = round(stats["text_bytes"] / stats["html_bytes"], 4) if stats["html_bytes"] else 0.0
    page.content_stats = stats
    return page


# ---------- raw-HTML signals used by the scoring module ----------

_SPA_ROOT_IDS = ("root", "app", "__next", "__nuxt", "___gatsby", "svelte", "main-app", "q-app")
_HYDRATION_MARKERS = (
    ("__NEXT_DATA__", "nextjs"), ("self.__next_f", "nextjs-app"), ("__NUXT__", "nuxt"),
    ("ng-version", "angular"), ("data-reactroot", "react"), ("data-server-rendered", "vue-ssr"),
    ("__remixContext", "remix"), ("data-sveltekit", "sveltekit"), ("astro-island", "astro"),
)
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"(?:\+\d{1,3}[\s.-]?)?(?:\(?0?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b")
_AUTHOR_CLASS_RE = re.compile(r"(^|[-_ ])(author|byline|yazar|writer)([-_ ]|$)", re.I)


def _raw_stats(soup: BeautifulSoup, html: str | bytes) -> dict[str, Any]:
    raw = html.decode("utf-8", "ignore") if isinstance(html, bytes) else html
    scripts = soup.find_all("script")
    inline_bytes = sum(len(s.string or "") for s in scripts if not s.get("src")
                       and "ld+json" not in str(s.get("type") or ""))
    spa_root = None
    for rid in _SPA_ROOT_IDS:
        el = soup.find(id=rid)
        if el is not None:
            text = _clean(el.get_text(" "))
            spa_root = {"id": rid, "empty": len(text.split()) < 20}
            break
    hydration = sorted({name for marker, name in _HYDRATION_MARKERS if marker in raw})
    noscript = " ".join(_clean(n.get_text(" ")) for n in soup.find_all("noscript"))

    mailto = {str(a["href"])[7:].split("?")[0].lower() for a in soup.find_all("a", href=True)
              if str(a["href"]).lower().startswith("mailto:")}
    tel = {re.sub(r"[^\d+]", "", str(a["href"])[4:]) for a in soup.find_all("a", href=True)
           if str(a["href"]).lower().startswith("tel:")}
    authors: list[str] = []
    for el in soup.find_all(attrs={"rel": True}):
        rel = el.get("rel")
        if "author" in (rel if isinstance(rel, list) else [rel]) and _clean(el.get_text(" ")):
            authors.append(_clean(el.get_text(" "))[:100])
    for el in soup.find_all(class_=_AUTHOR_CLASS_RE):
        t = _clean(el.get_text(" "))
        if t and len(t) < 120:
            authors.append(t)
    return {
        "html_bytes": len(raw.encode("utf-8", "ignore")),
        "script_tags": len(scripts),
        "external_scripts": sum(1 for s in scripts if s.get("src")),
        "inline_script_bytes": inline_bytes,
        "spa_root": spa_root,
        "hydration": hydration,
        "noscript_words": len(noscript.split()),
        "emails": sorted(mailto)[:10],
        "phones": sorted(t for t in tel if len(t) >= 7)[:10],
        "address_tags": len(soup.find_all("address")),
        "addresses": list(dict.fromkeys(_clean(a.get_text(" "))[:200] for a in soup.find_all("address")
                                        if _clean(a.get_text(" "))))[:3],
        "author_hints": list(dict.fromkeys(authors))[:5],
        "time_tags": [str(t.get("datetime")) for t in soup.find_all("time") if t.get("datetime")][:10],
        "images": len(soup.find_all("img")),
        "images_without_alt": sum(1 for i in soup.find_all("img") if not (i.get("alt") or "").strip()),
    }


def _content_stats(body: Tag | BeautifulSoup) -> dict[str, Any]:
    paragraphs = [_clean(p.get_text(" ")) for p in body.find_all("p")]
    paragraphs = [p for p in paragraphs if p]
    p_words = [len(p.split()) for p in paragraphs]
    tables = body.find_all("table")
    lists = body.find_all(["ul", "ol"])
    text = _clean(body.get_text(" "))
    return {
        "paragraphs": len(paragraphs),
        "avg_paragraph_words": round(sum(p_words) / len(p_words), 1) if p_words else 0.0,
        "long_paragraphs": sum(1 for w in p_words if w > 120),
        "first_paragraph": paragraphs[0][:500] if paragraphs else "",
        "tables": len(tables),
        "table_rows": sum(len(t.find_all("tr")) for t in tables),
        "lists": len(lists),
        "list_items": sum(len(lst.find_all("li", recursive=False)) for lst in lists),
        "definition_lists": len(body.find_all("dl")),
        "blockquotes": len(body.find_all("blockquote")),
        "cite_tags": len(body.find_all("cite")),
        "footnotes": len(body.find_all("sup")),
        "text_emails": sorted(set(e.lower() for e in _EMAIL_RE.findall(text)))[:10],
        "text_phones": sorted(set(re.sub(r"[^\d+]", "", m) for m in _PHONE_RE.findall(text)))[:10],
    }
