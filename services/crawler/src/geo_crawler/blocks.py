"""Document-order content blocks (heading / paragraph / list / table / blockquote / code) from HTML or Markdown.

Flattened page text loses the structure answer engines chunk on (which paragraph sits under which H2, what is a
quotation, which sentence carries a link). The AutoGEO engine works on these blocks instead. The module has no
scoring dependencies so the parser can call it without import cycles.
"""
from __future__ import annotations

import copy
import re
from dataclasses import asdict, dataclass, field
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, NavigableString, Tag

BLOCK_KINDS = ("heading", "paragraph", "list", "table", "blockquote", "code")
_CHROME = ("nav", "header", "footer", "aside", "script", "style", "noscript", "template", "svg", "form", "iframe")
_CONTAINERS = {"div", "section", "article", "main", "body", "html", "span", "figure", "details", "summary", "center",
               "dd", "dt", "dl", "hgroup", "font"}
_WS = re.compile(r"\s+")


def _clean(s: str | None) -> str:
    return _WS.sub(" ", s or "").strip()


@dataclass
class ContentBlock:
    kind: str
    text: str
    level: int = 0  # heading level 1-6
    items: list[str] = field(default_factory=list)  # list items
    rows: list[list[str]] = field(default_factory=list)  # table cells, first row = header
    links: list[dict[str, str]] = field(default_factory=list)  # [{"url", "text"}]
    cite: str = ""  # blockquote attribution (<cite>, <footer>, "— Name")
    ordered: bool = False

    @property
    def word_count(self) -> int:
        return len(self.text.split())

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return {k: v for k, v in d.items() if v not in ("", 0, [], False) or k in ("kind", "text")}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ContentBlock":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__ if k in d})

    # ---- canonical renderings used for diffs ----
    def to_markdown(self) -> str:
        if self.kind == "heading":
            return "#" * max(1, min(self.level, 6)) + " " + self.text
        if self.kind == "list":
            return "\n".join((f"{i}. " if self.ordered else "- ") + it for i, it in enumerate(self.items, 1))
        if self.kind == "table" and self.rows:
            width = max(len(r) for r in self.rows)
            rows = [r + [""] * (width - len(r)) for r in self.rows]
            out = ["| " + " | ".join(c.replace("|", "\\|") for c in rows[0]) + " |", "|" + " --- |" * width]
            out += ["| " + " | ".join(c.replace("|", "\\|") for c in r) + " |" for r in rows[1:]]
            return "\n".join(out)
        if self.kind == "blockquote":
            lines = [f"> {self.text}"]
            if self.cite:
                lines.append(f"> — {self.cite}")
            return "\n".join(lines)
        if self.kind == "code":
            return f"```\n{self.text}\n```"
        return self.text

    def to_html(self) -> str:
        e = _esc
        if self.kind == "heading":
            lv = max(1, min(self.level, 6))
            return f"<h{lv}>{e(self.text)}</h{lv}>"
        if self.kind == "list":
            tag = "ol" if self.ordered else "ul"
            return f"<{tag}>\n" + "\n".join(f"  <li>{e(i)}</li>" for i in self.items) + f"\n</{tag}>"
        if self.kind == "table" and self.rows:
            head = "".join(f"<th>{e(c)}</th>" for c in self.rows[0])
            body = "\n".join("    <tr>" + "".join(f"<td>{e(c)}</td>" for c in r) + "</tr>" for r in self.rows[1:])
            return f"<table>\n  <thead><tr>{head}</tr></thead>\n  <tbody>\n{body}\n  </tbody>\n</table>"
        if self.kind == "blockquote":
            cite = f"\n  <footer>— <cite>{e(self.cite)}</cite></footer>" if self.cite else ""
            return f"<blockquote>\n  <p>{e(self.text)}</p>{cite}\n</blockquote>"
        if self.kind == "code":
            return f"<pre><code>{e(self.text)}</code></pre>"
        return f"<p>{e(self.text)}</p>"


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------- HTML ----------------

def _links(el: Tag, base: str) -> list[dict[str, str]]:
    out = []
    for a in el.find_all("a", href=True):
        href = str(a["href"]).strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        out.append({"url": urljoin(base, href) if base else href, "text": _clean(a.get_text(" "))[:200]})
    return out


def _blockquote(src: Tag, base: str) -> ContentBlock:
    cite = ""
    el = copy.copy(src)  # attribution tags are removed from a copy; the caller's tree stays intact
    for c in el.find_all(["footer", "cite", "figcaption"]):
        cite = cite or _clean(c.get_text(" ")).lstrip("—–- ").strip()
        c.extract()
    parent = src.parent if isinstance(src.parent, Tag) else None
    if not cite and parent is not None and parent.name == "figure":
        cap = parent.find("figcaption")
        if cap:
            cite = _clean(cap.get_text(" ")).lstrip("—–- ").strip()
    text = _clean(el.get_text(" "))
    if not cite:
        m = re.search(r"\s[—–]\s?([^—–]{3,120})$", text)
        if m:
            cite, text = m.group(1).strip(), text[: m.start()].strip()
    return ContentBlock("blockquote", text.strip("“”\" "), cite=cite, links=_links(el, base))


def _walk(node: Tag, base: str, out: list[ContentBlock]) -> None:
    loose: list[str] = []

    def flush() -> None:
        t = _clean(" ".join(loose))
        loose.clear()
        if len(t.split()) >= 3:
            out.append(ContentBlock("paragraph", t))

    for child in list(node.children):
        if isinstance(child, NavigableString):
            if child.__class__.__name__ in ("Comment", "Doctype", "CData", "ProcessingInstruction"):
                continue
            if str(child).strip():
                loose.append(str(child))
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name.lower() if child.name else ""
        if name in _CHROME and not (name in ("header", "footer") and child.find_parent(["article", "main"])):
            continue
        if name in ("a", "strong", "b", "em", "i", "u", "small", "mark", "abbr", "time", "code", "sup", "sub",
                    "label", "q", "cite", "br"):
            loose.append(child.get_text(" "))
            continue
        flush()
        if re.fullmatch(r"h[1-6]", name):
            t = _clean(child.get_text(" "))
            if t:
                out.append(ContentBlock("heading", t, level=int(name[1])))
        elif name == "p":
            t = _clean(child.get_text(" "))
            if t:
                out.append(ContentBlock("paragraph", t, links=_links(child, base)))
        elif name in ("ul", "ol"):
            items = [_clean(li.get_text(" ")) for li in child.find_all("li", recursive=False)]
            items = [i for i in items if i]
            if items:
                out.append(ContentBlock("list", "; ".join(items), items=items, ordered=name == "ol",
                                        links=_links(child, base)))
        elif name == "table":
            rows = []
            for tr in child.find_all("tr"):
                cells = [_clean(c.get_text(" ")) for c in tr.find_all(["th", "td"])]
                if any(cells):
                    rows.append(cells)
            if rows:
                out.append(ContentBlock("table", " ".join(" ".join(r) for r in rows), rows=rows,
                                        links=_links(child, base)))
        elif name == "blockquote":
            b = _blockquote(child, base)
            if b.text:
                out.append(b)
        elif name == "pre":
            t = child.get_text("\n").strip()
            if t:
                out.append(ContentBlock("code", t))
        elif name in _CONTAINERS or name not in ("img", "video", "audio", "picture", "canvas", "button", "input",
                                                  "select", "textarea", "object", "embed", "hr", "head", "meta",
                                                  "link", "title"):
            _walk(child, base, out)
    flush()


def blocks_from_soup(soup: BeautifulSoup | Tag, base_url: str = "") -> list[ContentBlock]:
    """Blocks of the main content area (``<main>``/``<article>`` when present); template chrome is skipped."""
    root = soup.find("main") or soup.find("article") or getattr(soup, "body", None) or soup
    out: list[ContentBlock] = []
    _walk(root, base_url, out)
    return out


def blocks_from_html(html: str | bytes, base_url: str = "") -> list[ContentBlock]:
    return blocks_from_soup(BeautifulSoup(html, "lxml"), base_url)


# ---------------- Markdown ----------------

_MD_LINK = re.compile(r"!?\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_MD_AUTOLINK = re.compile(r"<(https?://[^>\s]+)>")
_MD_LIST = re.compile(r"^\s{0,3}([-*+]|\d+[.)])\s+(.*)$")


def _md_inline(s: str) -> tuple[str, list[dict[str, str]]]:
    links = [{"url": u, "text": t} for t, u in _MD_LINK.findall(s)]
    links += [{"url": u, "text": u} for u in _MD_AUTOLINK.findall(s)]
    s = _MD_LINK.sub(lambda m: m.group(1), s)
    s = _MD_AUTOLINK.sub(lambda m: m.group(1), s)
    s = re.sub(r"(\*\*|__|\*|_|`)(.+?)\1", r"\2", s)
    return _clean(s), links


def blocks_from_markdown(md: str) -> list[ContentBlock]:
    out: list[ContentBlock] = []
    lines = md.replace("\r\n", "\n").split("\n")
    i = 0
    para: list[str] = []

    def flush() -> None:
        if para:
            t, links = _md_inline(" ".join(para))
            if t:
                out.append(ContentBlock("paragraph", t, links=links))
            para.clear()

    while i < len(lines):
        line = lines[i]
        s = line.strip()
        if not s:
            flush()
            i += 1
            continue
        if s.startswith("```") or s.startswith("~~~"):
            flush()
            fence, buf = s[:3], []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith(fence):
                buf.append(lines[i])
                i += 1
            out.append(ContentBlock("code", "\n".join(buf).strip()))
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*?)\s*#*$", s)
        if m:
            flush()
            t, _ = _md_inline(m.group(2))
            out.append(ContentBlock("heading", t, level=len(m.group(1))))
            i += 1
            continue
        if s.startswith(">"):
            flush()
            buf = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip()[1:].strip())
                i += 1
            cite = ""
            if buf and re.match(r"^[—–-]{1,2}\s*\S", buf[-1]) and len(buf) > 1:
                cite = _md_inline(buf.pop().lstrip("—–- "))[0]
            t, links = _md_inline(" ".join(buf))
            if not cite:
                mm = re.search(r"\s[—–]\s?([^—–]{3,120})$", t)
                if mm:
                    cite, t = mm.group(1).strip(), t[: mm.start()].strip()
            out.append(ContentBlock("blockquote", t.strip("“”\" "), cite=cite, links=links))
            continue
        if s.startswith("|") and i + 1 < len(lines) and re.match(r"^\|?\s*:?-{2,}", lines[i + 1].strip()):
            flush()
            rows, links = [], []
            while i < len(lines) and lines[i].strip().startswith("|"):
                row = lines[i].strip().strip("|")
                if not re.fullmatch(r"[\s:|-]+", row):
                    cells = []
                    for c in re.split(r"(?<!\\)\|", row):
                        t, lk = _md_inline(c.replace("\\|", "|"))
                        cells.append(t)
                        links += lk
                    rows.append(cells)
                i += 1
            out.append(ContentBlock("table", " ".join(" ".join(r) for r in rows), rows=rows, links=links))
            continue
        lm = _MD_LIST.match(line)
        if lm:
            flush()
            items, links = [], []
            ordered = lm.group(1)[0].isdigit()
            while i < len(lines):
                lm = _MD_LIST.match(lines[i])
                if lm:
                    t, lk = _md_inline(lm.group(2))
                    items.append(t)
                    links += lk
                elif lines[i].strip() and lines[i].startswith((" ", "\t")) and items:
                    t, lk = _md_inline(lines[i])
                    items[-1] = f"{items[-1]} {t}".strip()
                    links += lk
                else:
                    break
                i += 1
            out.append(ContentBlock("list", "; ".join(items), items=items, ordered=ordered, links=links))
            continue
        para.append(s)
        i += 1
    flush()
    return out
