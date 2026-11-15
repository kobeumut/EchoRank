"""AutoGEO — content-level citation-likelihood scoring and copy-paste rewrites for generative engines.

Research basis
--------------
* Aggarwal et al., "GEO: Generative Engine Optimization", KDD 2024 (arXiv:2311.09735): on GEO-bench the
  visibility gains of Quotation Addition (~+41%), Statistics Addition (~+37%), Cite Sources (~+30-40%, up to
  +115.1% for sources ranked 5th or lower in the SERP) and Fluency Optimization / authoritative tone (~+25%)
  beat traditional SEO tactics, while Keyword Stuffing gave no gain or a loss (-10% .. -25% risk).
* Wu et al., "AutoGEO", ICLR 2026 (arXiv:2510.11438): preference rules learned from generative engines favour
  self-contained, directly-answering passages under each heading — modelled here as 40-60 word answer capsules.

Six page metrics (0-100 each)
-----------------------------
``statistics``         concrete figures per 100 words, minus vague quantity claims ("many", "most", ...)
``quotations``         attributed expert quotations (blockquote + inline "..." with a speaker)
``citations``          claim coverage by source references + authority of the linked domains (.gov/.edu/DOI)
``answer_capsules``    first passage under each H2/H3 is a self-contained 40-60 word direct answer
``authority_fluency``  hedges, filler, hype, passive voice and overlong sentences
``keyword_stuffing``   repetition of one term / phrase beyond natural density (higher = cleaner)

Every weak block yields an ``Improvement`` with Markdown + HTML replacements and unified diffs. Numbers, names
and sources are never invented: the rewrites insert explicit ``[PLACEHOLDER]`` tokens the editor must fill.

    report = analyze_html(html, url="https://example.com/blog/x", page_type="article")
    report.score, report.metrics["statistics"].score, report.improvements[0].diff_markdown

Two different languages are involved. ``lang`` ("en" | "tr", default "en") is the language of the *report*: metric
labels, detail lines, improvement titles/rationales and the text CLI output (``geo_crawler.i18n`` catalogs).
The *content* language (``content_lang`` hint, otherwise detected from the page text) selects the lexicons and the
bracketed placeholders (``[NUMBER]`` / ``[SAYI]``...) that are written into the suggested rewrites, because those
are inserted into the page itself and must match its language.
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.parse import urlsplit

from ..blocks import ContentBlock, blocks_from_html, blocks_from_markdown
from ..i18n import DEFAULT_LANG, Translator, get_translator, normalize_lang
from ..keywords import STOPWORDS
from ..netguard import SYNC_GUARD_HOOKS
from ..models import PageData, PageType
from . import text as tx
from .base import clamp

AUTOGEO_VERSION = "1.0"
METRIC_KEYS = ("statistics", "quotations", "citations", "answer_capsules", "authority_fluency", "keyword_stuffing")

# published visibility gain (%) of fully applying the strategy, ActionItem category, effort
# (the display label of each metric is the catalog message ``autogeo.metric.<key>.label``)
METRIC_INFO: dict[str, dict[str, Any]] = {
    "statistics": {"gain": 37.0, "category": "content", "effort": "medium"},
    "quotations": {"gain": 41.0, "category": "authority", "effort": "medium"},
    "citations": {"gain": 35.0, "category": "authority", "effort": "medium"},
    "answer_capsules": {"gain": 20.0, "category": "content", "effort": "low"},
    "authority_fluency": {"gain": 25.0, "category": "content", "effort": "low"},
    "keyword_stuffing": {"gain": 25.0, "category": "content", "effort": "low"},
}
LOW_RANK_CITATION_GAIN = 115.1  # Cite Sources gain for pages ranked 5th or lower

# Weight profiles per content type: product pages rarely carry expert quotes but must be precise and spam-free.
WEIGHTS: dict[str, dict[str, float]] = {
    "default": {"statistics": .20, "quotations": .17, "citations": .20, "answer_capsules": .18,
                "authority_fluency": .13, "keyword_stuffing": .12},
    "article": {"statistics": .20, "quotations": .20, "citations": .22, "answer_capsules": .16,
                "authority_fluency": .12, "keyword_stuffing": .10},
    "product": {"statistics": .26, "quotations": .07, "citations": .13, "answer_capsules": .20,
                "authority_fluency": .16, "keyword_stuffing": .18},
    "service": {"statistics": .22, "quotations": .14, "citations": .18, "answer_capsules": .20,
                "authority_fluency": .13, "keyword_stuffing": .13},
}
_PROFILE = {"article": "article", "blog": "article", "faq": "article", "product": "product", "category": "product",
            "service": "service", "home": "service", "about": "service"}
MAX_IMPROVEMENTS_PER_METRIC = 3

# ---------------------------------------------------------------- lexicons
# Content-language data (NOT report text): these lexicons recognise weak wording in the analysed page and the
# placeholders are written into the suggested rewrites, so they exist per content language. The Turkish ("tr")
# entries are deliberately kept in Turkish — they let the analyzer work on Turkish web pages.

VAGUE_TERMS: dict[str, dict[str, str]] = {
    # vague phrase -> measurable placeholder
    "tr": {
        "büyük çoğunluğu": "%[ORAN]'i", "pek çok": "[SAYI]", "bir çok": "[SAYI]", "birçok": "[SAYI]",
        "çok sayıda": "[SAYI]", "binlerce": "[SAYI]", "milyonlarca": "[SAYI]", "çoğu": "%[ORAN]",
        "önemli ölçüde": "%[ORAN] oranında", "büyük ölçüde": "%[ORAN] oranında", "ciddi oranda": "%[ORAN] oranında",
        "yüksek oranda": "%[ORAN] oranında", "oldukça": "[ÖLÇÜLEBİLİR DEĞER]", "son yıllarda": "[YIL]-[YIL] arasında",
        "giderek artan": "yılda %[ORAN] artan", "hızla artan": "yılda %[ORAN] artan", "çok daha": "[X kat] daha",
    },
    "en": {
        "a large number of": "[NUMBER]", "the majority of": "[X]% of", "a lot of": "[NUMBER]", "lots of": "[NUMBER]",
        "many": "[NUMBER]", "numerous": "[NUMBER]", "several": "[NUMBER]", "thousands of": "[NUMBER]",
        "millions of": "[NUMBER]", "most": "[X]% of", "significantly": "by [X]%", "substantially": "by [X]%",
        "dramatically": "by [X]%", "in recent years": "between [YEAR] and [YEAR]", "increasingly": "[X]% more",
        "much more": "[X times] more",
    },
}
HEDGES: dict[str, dict[str, str]] = {
    # weak phrase -> replacement ("" = delete)
    "tr": {
        "belki de": "", "belki": "", "sanırım": "", "galiba": "", "bence": "", "kanımca": "", "bir nevi": "",
        "adeta": "", "gibi görünüyor": "", "diye düşünüyoruz": "", "diye düşünülmektedir": "",
        "olabileceği düşünülmektedir": "olduğu [Kaynak]'a göre belirlenmiştir", "olduğu düşünülmektedir":
        "olduğu [Kaynak]'a göre belirlenmiştir", "söylenebilir": "belirlenmiştir", "denilebilir": "denir",
        "muhtemelen": "",
    },
    "en": {
        "i think": "", "we think": "", "i believe": "", "we believe": "", "in my opinion": "", "perhaps": "",
        "maybe": "", "probably": "", "possibly": "", "kind of": "", "sort of": "", "arguably": "",
        "it seems that": "", "it seems": "", "might be": "is", "may be": "is", "could be": "is",
    },
}
HYPE_REPLACEMENT = {"tr": "[ölçülebilir üstünlük: ör. %XX daha hızlı]", "en": "[measurable advantage: e.g. XX% faster]"}
_HYPE_REWRITE = ("en iyi", "rakipsiz", "mucize", "mucizevi", "inanılmaz", "tartışmasız", "efsane", "best ever",
                 "number one", "miracle", "unbelievable", "world-class", "best-in-class", "game-changer")
# Attribution verbs, expert titles, citation patterns and question words in Turkish *and* English (content-language data:
# they recognise quotes / citations / question headings on Turkish pages; "göre" = "according to").
QUOTE_VERBS = re.compile(
    r"(?<!\w)(diyor|dedi|diyerek|belirtiyor|belirtti|açıkladı|açıklıyor|ifade etti|ifade ediyor|vurguluyor|vurguladı|"
    r"aktarıyor|söylüyor|söyledi|göre|said|says|according to|notes|noted|explains|explained|stated|states|"
    r"adds|added|told)(?!\w)", re.I)
EXPERT_TITLES = re.compile(
    r"(?<!\w)(dr\.|prof\.|doç\.|uzm\.|av\.|op\.|ceo|cto|cfo|kurucu|founder|direktör|director|müdür|başkan|"
    r"uzmanı|uzman|analyst|analist|araştırmacı|researcher|professor|profesör|editör|editor|başhekim)", re.I)
_QUOTE_RE = re.compile(r"[“\"«]([^”\"»]{25,400})[”\"»]")
_INLINE_CITE = re.compile(
    r"\[\d{1,3}\]"  # numeric footnote [1]
    r"|\(\s*[A-ZÇĞİÖŞÜ][\w'’-]+(?:\s+(?:et al\.?|vd\.?|ve ark\.?)|\s*(?:&|ve|and)\s*[A-ZÇĞİÖŞÜ][\w-]+)?"
    r",?\s*(?:19|20)\d{2}[a-z]?\s*\)"  # (Author, 2024)
    r"|(?<!\w)(?:kaynak|source|ref)\s*:|\bdoi:\s*10\."
    r"|\b[Aa]ccording to\s+(?:the\s+)?[A-Z0-9]"
    r"|(?:verilerine|raporuna|araştırmasına|çalışmasına|açıklamasına|istatistiklerine|yönergelerine)\s+göre"
    r"|[A-ZÇĞİÖŞÜ][\w-]*['’](?:n?[ae]|y[ae]|n?[ıiuü]n)\s+göre", re.U)
DANGLING_START = {
    "tr": ("bu ", "bunlar", "şu ", "bunun", "bununla", "ayrıca", "öte yandan", "o ", "onlar", "dolayısıyla", "ancak"),
    "en": ("this ", "these ", "it ", "they ", "that ", "also", "however", "additionally", "moreover", "such "),
}
_QUESTION_RE = re.compile(r"\?$|^(ne|nasıl|neden|niçin|hangi|kim|nerede|kaç|what|how|why|which|who|where|when|"
                          r"can|does|do|is|are)\b|\b(nedir|nelerdir|midir|mıdır|mi|mı|mu|mü)\b", re.I)
_Q_STRIP = re.compile(r"\?|\b(nedir|nelerdir|nasıl yapılır|nasıl|neden|niçin|hangi|nelerdir|midir|mıdır|"
                      r"what is|what are|how to|how do|how does|why|which)\b", re.I)
_EN_PASSIVE = re.compile(r"\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b", re.I)
_YEAR = re.compile(r"^(?:19|20)\d{2}$")

AUTHORITY_TIER1 = ("doi.org", "arxiv.org", "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "nih.gov", "who.int",
                   "europa.eu", "oecd.org", "worldbank.org", "un.org", "imf.org", "nature.com", "science.org",
                   "sciencedirect.com", "springer.com", "link.springer.com", "ieee.org", "acm.org", "jstor.org",
                   "scholar.google.com", "thelancet.com", "nejm.org", "bmj.com", "cochranelibrary.com",
                   "resmigazete.gov.tr", "tuik.gov.tr", "dergipark.org.tr")
AUTHORITY_TIER2 = ("statista.com", "gartner.com", "mckinsey.com", "forrester.com", "pewresearch.org", "nielsen.com",
                   "deloitte.com", "pwc.com", "kpmg.com", "ey.com", "iso.org", "w3.org", "wikipedia.org",
                   "reuters.com", "bloomberg.com", "bbc.com", "bbc.co.uk", "ft.com", "hbr.org", "mit.edu",
                   "similarweb.com", "semrush.com", "ahrefs.com", "developers.google.com", "schema.org")
_GOV_EDU = re.compile(r"(^|\.)(gov|edu|mil|ac|gob|gouv|bund)(\.[a-z]{2})?$|\.(gov|edu|ac|k12)\.[a-z]{2}$|"
                      r"(^|\.)int$", re.I)

PLACEHOLDER = {
    "tr": {"cite": "Kaynak, Yıl", "cite_url": "https://kaynak-adresi", "quote": "[Uzmanın doğrudan alıntısı]",
           "speaker": "[Ad Soyad], [Unvan], [Kurum]", "synonym": "[eş anlamlı/zamir]",
           "fill": "[Ölçülebilir bir veri ya da koşul ekleyin: %XX, süre, fiyat aralığı]"},
    "en": {"cite": "Source, Year", "cite_url": "https://source-url", "quote": "[Expert's direct quotation]",
           "speaker": "[Full Name], [Title], [Organisation]", "synonym": "[synonym/pronoun]",
           "fill": "[Add a measurable fact or condition: XX%, duration, price range]"},
}


# ---------------------------------------------------------------- data model

@dataclass
class AutoGeoMetric:
    key: str
    label: str
    score: float
    weight: float
    detail: str
    facts: dict[str, Any] = field(default_factory=dict)
    potential_gain_pct: float = 0.0  # estimated visibility gain (%) of fixing this metric

    @property
    def passed(self) -> bool:
        return self.score >= 70

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key, "label": self.label, "score": round(self.score), "weight": self.weight,
                "passed": self.passed, "detail": self.detail, "facts": self.facts,
                "potential_gain_pct": round(self.potential_gain_pct, 1)}


@dataclass
class Improvement:
    rule_id: str
    metric: str  # primary metric
    kind: str  # rewrite | insert
    title: str
    rationale: str
    block_index: int | None  # rewrite: target block; insert: new block goes after this index (-1 = top)
    before_markdown: str
    after_markdown: str
    after_html: str
    diff_markdown: str
    diff_html: str
    expected_gain_pct: float = 0.0
    metrics: list[str] = field(default_factory=list)  # every metric a merged rewrite addresses

    def to_dict(self) -> dict[str, Any]:
        d = dict(self.__dict__)
        d["metrics"] = self.metrics or [self.metric]
        return d


@dataclass
class AutoGeoReport:
    url: str
    page_type: str
    language: str
    word_count: int
    metrics: dict[str, AutoGeoMetric]
    improvements: list[Improvement] = field(default_factory=list)
    answer_capsule: dict[str, Any] | None = None
    comparison_table: dict[str, Any] | None = None
    caps: list[str] = field(default_factory=list)

    @property
    def score(self) -> int:
        total = sum(m.weight for m in self.metrics.values()) or 1
        raw = round(sum(m.score * m.weight for m in self.metrics.values()) / total)
        stuffing = self.metrics.get("keyword_stuffing")
        if stuffing and stuffing.score < 40:  # semantic spam filters drop the page regardless of other merits
            raw = min(raw, 60)
        return raw

    @property
    def grade(self) -> str:
        s = self.score
        return "A" if s >= 85 else "B" if s >= 70 else "C" if s >= 55 else "D" if s >= 40 else "E"

    def to_dict(self) -> dict[str, Any]:
        return {"version": AUTOGEO_VERSION, "url": self.url, "page_type": self.page_type, "language": self.language,
                "word_count": self.word_count, "score": self.score, "grade": self.grade, "caps": self.caps,
                "metrics": {k: m.to_dict() for k, m in self.metrics.items()},
                "improvements": [i.to_dict() for i in self.improvements],
                "answer_capsule": self.answer_capsule, "comparison_table": self.comparison_table}


@dataclass
class AutoGeoSiteReport:
    pages: list[AutoGeoReport]

    @property
    def score(self) -> int:
        if not self.pages:
            return 0
        w = [max(min(p.word_count, 2000), 100) for p in self.pages]
        return round(sum(p.score * x for p, x in zip(self.pages, w)) / sum(w))

    def metric_means(self) -> dict[str, int]:
        if not self.pages:
            return {}
        return {k: round(sum(p.metrics[k].score for p in self.pages) / len(self.pages)) for k in METRIC_KEYS}

    def to_dict(self) -> dict[str, Any]:
        return {"version": AUTOGEO_VERSION, "score": self.score, "metrics": self.metric_means(),
                "page_count": len(self.pages), "pages": [p.to_dict() for p in self.pages]}


# ---------------------------------------------------------------- helpers

# sentence boundary: the next sentence starts with an upper-case letter (incl. the Turkish Ç Ğ İ Ö Ş Ü), digit or quote
_SPLIT = re.compile(r"(?<=[.!?…])\s+(?=[\"“(\[]?[A-ZÇĞİÖŞÜ0-9])")


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SPLIT.split(text.strip()) if s.strip()]


def detect_language(text: str, hint: str = "") -> str:
    """Content language of a page: "tr" or "en" (the ``<html lang>`` hint wins, else a stop-word/letter heuristic).

    The Turkish branch counts Turkish-only letters and the most frequent Turkish function words — this is
    deliberate language data, it makes the analyzer work on Turkish pages."""
    if hint[:2].lower() in ("tr", "en"):
        return hint[:2].lower()
    low = f" {text.lower()[:20000]} "
    tr = len(re.findall(r"[çğışöü]", low)) + 3 * sum(low.count(f" {w} ") for w in ("ve", "bir", "bu", "için", "ile"))
    en = 3 * sum(low.count(f" {w} ") for w in ("the", "and", "of", "to", "is", "for"))
    return "tr" if tr >= en else "en"


def _phrase_re(phrase: str) -> re.Pattern[str]:
    return re.compile(rf"(?<!\w){re.escape(phrase)}(?!\w)", re.I)


_PHRASE_CACHE: dict[str, re.Pattern[str]] = {}


def _has(text: str, phrase: str) -> bool:
    p = _PHRASE_CACHE.get(phrase) or _PHRASE_CACHE.setdefault(phrase, _phrase_re(phrase))
    return bool(p.search(text))


def numeric_facts(text: str) -> list[str]:
    return [n for n in tx.numbers(text) if not _YEAR.match(n.strip())]


def _domain(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def authority_tier(url: str) -> int:
    """1 = academic / government / intergovernmental, 2 = recognised industry source, 3 = other."""
    host = _domain(url)
    if not host:
        return 3
    if _GOV_EDU.search(host) or any(host == d or host.endswith("." + d) for d in AUTHORITY_TIER1):
        return 1
    if any(host == d or host.endswith("." + d) for d in AUTHORITY_TIER2):
        return 2
    return 3


def _capitalize(s: str, lang: str = "en") -> str:
    """Upper-case the first letter; ``lang`` is the *content* language (Turkish "i" becomes dotted "İ")."""
    s = s.lstrip()
    if not s:
        return s
    return ("İ" if s[0] == "i" and lang == "tr" else s[0].upper()) + s[1:]


def _tidy(s: str) -> str:
    s = re.sub(r"\s{2,}", " ", s)
    s = re.sub(r"\s+([,.;:!?])", r"\1", s)
    s = re.sub(r"([,;:])\1+", r"\1", s)
    s = re.sub(r"^[,;:\s]+", "", s)
    return s.strip()


def _udiff(before: str, after: str, path: str) -> str:
    lines = difflib.unified_diff(before.splitlines(), after.splitlines(), fromfile=f"a/{path}",
                                 tofile=f"b/{path}", lineterm="", n=2)
    return "\n".join(lines)


def _subject(heading: str) -> str:
    s = _Q_STRIP.sub(" ", heading)
    return _tidy(re.sub(r"\s+", " ", s)).strip(" -:–") or heading.strip()


def _words(text: str) -> list[str]:
    return text.split()


# Tokens inside generated text that render differently in Markdown and HTML.
_CITE_TOKEN = "⟦CITE⟧"


def _render_tokens(rendered: str, lang: str, html: bool) -> str:
    """Replace citation tokens in an already rendered Markdown / HTML block."""
    ph = PLACEHOLDER[lang]
    if html:
        return rendered.replace(_CITE_TOKEN, f'(<a href="{ph["cite_url"]}">{ph["cite"]}</a>)')
    return rendered.replace(_CITE_TOKEN, f'([{ph["cite"]}]({ph["cite_url"]}))')


def _append_cite(sentence: str) -> str:
    return re.sub(r"([.!?…])?$", lambda m: f" {_CITE_TOKEN}{m.group(1) or '.'}", sentence.rstrip(), count=1)


def is_claim(sentence: str) -> bool:
    """Verifiable claim: statistic / percentage, research or authority appeal, or a figure in a real sentence."""
    return bool(tx.claim_sentences(sentence + " .", limit=1) or re.search(r"%\s?\d|\d\s?%", sentence)
                or (numeric_facts(sentence) and len(sentence.split()) >= 6))


def is_cited(sentence: str) -> bool:
    return _CITE_TOKEN in sentence or bool(_INLINE_CITE.search(sentence))


# ---------------------------------------------------------------- analyzer

class _Page:
    def __init__(self, blocks: list[ContentBlock], url: str, page_type: str, lang_hint: str, title: str,
                 serp_rank: int | None, brand_terms: Iterable[str], lang: str = DEFAULT_LANG):
        self.lang = normalize_lang(lang)  # report language (labels, details, titles, rationales)
        self.t: Translator = get_translator(self.lang)
        self.blocks = blocks
        self.url = url
        self.page_type = page_type
        self.title = title
        self.serp_rank = serp_rank
        self.text = " ".join(b.text for b in blocks if b.kind != "code")
        self.content_lang = detect_language(self.text, lang_hint)  # language of the page itself
        self.tokens = tx.words(self.text)
        self.n = len(self.tokens)
        self.sentences = [s for b in blocks if b.kind in ("paragraph", "blockquote", "list")
                          for s in (split_sentences(b.text) if b.kind != "list" else b.items)]
        host = _domain(url)
        self.brand = {t for t in re.split(r"[^\w]+", (host.rsplit(".", 2)[0] if host else "").lower()) if len(t) > 2}
        self.brand |= {t.lower() for t in brand_terms}
        self.path = (urlsplit(url).path.strip("/") or "index") + ".md" if url else "content.md"
        self.improvements: list[Improvement] = []
        self.cur: dict[int, str] = {}
        self.rewrites: dict[int, Improvement] = {}
        h1 = next((b.text for b in blocks if b.kind == "heading" and b.level == 1), "")
        # "konu" = Turkish for "topic": the fallback is written into the suggested rewrites (content language)
        self.topic = h1 or title or next((b.text for b in blocks if b.kind == "heading"), "") \
            or ("konu" if self.content_lang == "tr" else "topic")

    # -- improvement plumbing
    def text_of(self, idx: int) -> str:
        """Working text of a block: rules chain on top of earlier rewrites of the same block."""
        return self.cur.get(idx, self.blocks[idx].text)

    def rewrite(self, metric: str, idx: int, new_text: str, title: str, rationale: str, gain: float,
                cite: str | None = None) -> None:
        """Rewrite a block. Several rules touching one block merge into ONE improvement whose diff is taken
        against the original block, so every emitted diff applies cleanly on its own."""
        b = self.blocks[idx]
        new_text = _tidy(new_text)
        if new_text == self.text_of(idx).strip() and (cite is None or cite == b.cite):
            return
        self.cur[idx] = new_text
        nb = ContentBlock(b.kind, new_text, level=b.level, items=b.items, rows=b.rows,
                          cite=b.cite if cite is None else cite, ordered=b.ordered)
        if b.kind == "list":
            nb = ContentBlock("paragraph", new_text)
        before_md, before_html = b.to_markdown(), b.to_html()
        after_md = _render_tokens(nb.to_markdown(), self.content_lang, False)
        after_html = _render_tokens(nb.to_html(), self.content_lang, True)
        diff_md = _udiff(before_md, after_md, self.path)
        diff_html = _udiff(before_html, after_html, self.path.replace(".md", ".html"))
        imp = self.rewrites.get(idx)
        if imp:
            if metric not in imp.metrics:
                imp.metrics.append(metric)
                imp.title = f"{imp.title} + {title[:1].lower()}{title[1:]}"
                imp.rationale = f"{imp.rationale} {rationale}"
            imp.after_markdown, imp.after_html, imp.diff_markdown, imp.diff_html = after_md, after_html, diff_md, \
                diff_html
            imp.expected_gain_pct = round(imp.expected_gain_pct + gain, 1)
            return
        imp = Improvement(
            rule_id=f"autogeo.{metric}", metric=metric, kind="rewrite", title=title, rationale=rationale,
            block_index=idx, before_markdown=before_md, after_markdown=after_md, after_html=after_html,
            diff_markdown=diff_md, diff_html=diff_html, expected_gain_pct=round(gain, 1), metrics=[metric])
        self.rewrites[idx] = imp
        self.improvements.append(imp)

    def insert(self, metric: str, after_idx: int, new_md: str, new_html: str, title: str, rationale: str,
               gain: float, rule_id: str | None = None) -> None:
        ctx_block = self.blocks[after_idx] if 0 <= after_idx < len(self.blocks) else None
        ctx_md = ctx_block.to_markdown() if ctx_block else ""
        ctx_html = ctx_block.to_html() if ctx_block else ""
        join = lambda a, b: f"{a}\n\n{b}" if a else b  # noqa: E731
        self.improvements.append(Improvement(
            rule_id=rule_id or f"autogeo.{metric}", metric=metric, kind="insert", title=title, rationale=rationale,
            block_index=after_idx, before_markdown=ctx_md, after_markdown=new_md, after_html=new_html,
            diff_markdown=_udiff(ctx_md, join(ctx_md, new_md), self.path),
            diff_html=_udiff(ctx_html, join(ctx_html, new_html).replace("\n\n", "\n"),
                             self.path.replace(".md", ".html")),
            expected_gain_pct=round(gain, 1), metrics=[metric]))

    def paragraphs(self) -> list[tuple[int, ContentBlock]]:
        return [(i, b) for i, b in enumerate(self.blocks) if b.kind == "paragraph"]

    def intro_index(self) -> int:
        """Index after which page-level inserts go: the first paragraph after the H1 (or the H1 itself)."""
        h1 = next((i for i, b in enumerate(self.blocks) if b.kind == "heading" and b.level == 1), -1)
        for i in range(h1 + 1, len(self.blocks)):
            if self.blocks[i].kind == "paragraph":
                return i
            if self.blocks[i].kind == "heading":
                break
        return h1

    def gain(self, metric: str, score: float) -> float:
        base = METRIC_INFO[metric]["gain"]
        if metric == "citations" and self.serp_rank and self.serp_rank >= 5:
            base = LOW_RANK_CITATION_GAIN
        return base * (100 - score) / 100

    # -- 1. statistics -------------------------------------------------
    def statistics(self) -> tuple[float, str, dict[str, Any]]:
        facts = numeric_facts(self.text)
        per100 = len(facts) * 100 / max(self.n, 1)
        vague_terms = VAGUE_TERMS[self.content_lang]
        vague = [s for s in self.sentences if any(_has(s, t) for t in vague_terms) and not numeric_facts(s)]
        vague_share = len(vague) / max(len(self.sentences), 1)
        tables = sum(1 for b in self.blocks if b.kind == "table")
        density = clamp(100 * per100 / 1.5)  # >= 1.5 concrete figures per 100 words
        score = clamp(0.75 * density + 0.25 * (100 - min(100, vague_share * 400)) + (8 if tables else 0))
        if self.n < 40:
            score = min(score, 50.0)
        detail = self.t("autogeo.metric.statistics.detail", facts=len(facts), per100=f"{per100:.2f}",
                        vague=len(vague), tables=tables)
        return score, detail, {"numeric_facts": len(facts), "per_100_words": round(per100, 2),
                               "vague_sentences": vague[:5], "vague_count": len(vague), "tables": tables}

    def improve_statistics(self, score: float, facts: dict[str, Any]) -> None:
        if score >= 85:
            return
        g = self.gain("statistics", score)
        terms = sorted(VAGUE_TERMS[self.content_lang].items(), key=lambda kv: -len(kv[0]))
        made = 0
        for i, b in self.paragraphs():
            if made >= MAX_IMPROVEMENTS_PER_METRIC:
                break
            out, changed = [], False
            for s in split_sentences(self.text_of(i)):
                new = s
                if not numeric_facts(s):
                    for term, repl in terms:
                        pat = _phrase_re(term)
                        if pat.search(new):
                            new = pat.sub(lambda m, r=repl: r if not m.group(0)[0].isupper() else _capitalize(r, self.content_lang),
                                          new, count=1)
                    if new != s and not is_cited(new):
                        new = _append_cite(new)
                changed |= new != s
                out.append(new)
            if changed:
                self.rewrite("statistics", i, " ".join(out),
                             self.t("autogeo.improve.statistics.title"),
                             self.t("autogeo.improve.statistics.rationale"), g / max(1, facts["vague_count"]))
                made += 1
        if facts["per_100_words"] < 1.0 and self.n >= 80:
            idx = self.intro_index()
            topic = self.topic
            # the table is inserted into the page, so its text follows the content language
            if self.content_lang == "tr":
                rows = [["Metrik", "Değer", "Kaynak"], [f"{topic} — temel ölçüt", "[SAYI / %ORAN]", "[Kaynak, Yıl]"],
                        ["Karşılaştırma / sektör ortalaması", "[SAYI / %ORAN]", "[Kaynak, Yıl]"],
                        ["Zaman içindeki değişim", "[YIL]-[YIL]: %[ORAN]", "[Kaynak, Yıl]"]]
            else:
                rows = [["Metric", "Value", "Source"], [f"{topic} — key metric", "[NUMBER / X%]", "[Source, Year]"],
                        ["Benchmark / industry average", "[NUMBER / X%]", "[Source, Year]"],
                        ["Change over time", "[YEAR]-[YEAR]: [X]%", "[Source, Year]"]]
            tbl = ContentBlock("table", "", rows=rows)
            self.insert("statistics", idx, tbl.to_markdown(), tbl.to_html(),
                        self.t("autogeo.improve.statistics.table.title"),
                        self.t("autogeo.improve.statistics.table.rationale"), g * 0.6)

    # -- 2. quotations -------------------------------------------------
    def quotations(self) -> tuple[float, str, dict[str, Any]]:
        attributed, unattributed, unattr_idx = 0, 0, []
        for i, b in enumerate(self.blocks):
            if b.kind == "blockquote":
                if b.cite or EXPERT_TITLES.search(b.text) or QUOTE_VERBS.search(b.text[-120:]):
                    attributed += 1
                else:
                    unattributed += 1
                    unattr_idx.append(i)
            elif b.kind in ("paragraph", "list"):
                for m in _QUOTE_RE.finditer(b.text):
                    around = b.text[max(0, m.start() - 100): m.end() + 100]
                    if QUOTE_VERBS.search(around) or EXPERT_TITLES.search(around):
                        attributed += 1
                    else:
                        unattributed += 1
        target = max(1.0, self.n / 600)
        credit = attributed + 0.4 * unattributed
        score = clamp(100 * credit / target)
        detail = self.t("autogeo.metric.quotations.detail", attributed=attributed, unattributed=unattributed,
                        target=f"{target:.1f}")
        return score, detail, {"attributed": attributed, "unattributed": unattributed, "target": round(target, 1),
                               "unattributed_blocks": unattr_idx}

    def improve_quotations(self, score: float, facts: dict[str, Any]) -> None:
        if score >= 80:
            return
        g = self.gain("quotations", score)
        ph = PLACEHOLDER[self.content_lang]
        for i in facts["unattributed_blocks"][:MAX_IMPROVEMENTS_PER_METRIC]:
            b = self.blocks[i]
            self.rewrite("quotations", i, b.text, cite=ph["speaker"],
                         title=self.t("autogeo.improve.quotations.attribute.title"),
                         rationale=self.t("autogeo.improve.quotations.attribute.rationale"), gain=g * 0.5)
        if facts["attributed"] + facts["unattributed"] < facts["target"]:
            # after the first H2 section's first paragraph (or the intro)
            idx = self.intro_index()
            for j, b in enumerate(self.blocks):
                if b.kind == "heading" and b.level in (2, 3):
                    nxt = next((k for k in range(j + 1, len(self.blocks)) if self.blocks[k].kind != "heading"), None)
                    if nxt is not None and self.blocks[nxt].kind == "paragraph":
                        idx = nxt
                    break
            # placeholder quotation text is written into the page, so it follows the content language
            quote = (f"{ph['quote']} — {self.topic} konusunda somut bir deneyim, veri ya da öneri."
                     if self.content_lang == "tr" else f"{ph['quote']} — a concrete insight, figure or recommendation "
                     f"about {self.topic}.")
            nb = ContentBlock("blockquote", quote, cite=ph["speaker"])
            self.insert("quotations", idx, nb.to_markdown(), nb.to_html(),
                        self.t("autogeo.improve.quotations.insert.title"),
                        self.t("autogeo.improve.quotations.insert.rationale"), g)

    # -- 3. citations --------------------------------------------------
    def citations(self) -> tuple[float, str, dict[str, Any]]:
        own = _domain(self.url)
        ext_links = [lk for b in self.blocks for lk in b.links
                     if _domain(lk["url"]) and _domain(lk["url"]) != own and not _domain(lk["url"]).endswith("." + own)]
        tiers = Counter(authority_tier(lk["url"]) for lk in ext_links)
        claims, cited = 0, 0
        uncited: list[tuple[int, str]] = []
        for i, b in enumerate(self.blocks):
            if b.kind not in ("paragraph", "list", "blockquote"):
                continue
            block_has_link = any(_domain(lk["url"]) != own for lk in b.links)
            sents = b.items if b.kind == "list" else split_sentences(b.text)
            for s in sents:
                if not is_claim(s):
                    continue
                claims += 1
                if block_has_link or is_cited(s):
                    cited += 1
                else:
                    uncited.append((i, s))
        refs_section = any((b.kind == "heading" or (b.kind == "paragraph" and b.links)) and
                           tx.SOURCE_MARKERS.match(b.text.strip()) for b in self.blocks)
        # a reference list backs page claims indirectly: half credit for claims without an inline citation
        credit = cited + (0.5 * (claims - cited) if refs_section and ext_links else 0)
        coverage = 100.0 * credit / claims if claims else (100.0 if ext_links else 60.0)
        weighted = tiers[1] + 0.6 * tiers[2] + 0.25 * tiers[3] + (0.5 if refs_section else 0)
        target = max(2.0, self.n / 500)
        authority = clamp(100 * weighted / target)
        score = clamp(0.55 * coverage + 0.45 * authority)
        if claims == 0 and not ext_links:
            score = min(score, 45.0)
        detail = self.t("autogeo.metric.citations.detail", claims=claims, cited=cited, external=len(ext_links),
                        tier1=tiers[1], tier2=tiers[2], tier3=tiers[3])
        return score, detail, {"claims": claims, "cited_claims": cited, "external_links": len(ext_links),
                               "tier1": tiers[1], "tier2": tiers[2], "tier3": tiers[3],
                               "references_section": refs_section, "uncited": uncited[:10]}

    def improve_citations(self, score: float, facts: dict[str, Any]) -> None:
        if score >= 80:
            return
        g = self.gain("citations", score)
        blocks = list(dict.fromkeys(i for i, _ in facts["uncited"]))
        made = 0
        for i in blocks:
            if made >= MAX_IMPROVEMENTS_PER_METRIC or self.blocks[i].kind != "paragraph":
                continue
            out = [_append_cite(s) if is_claim(s) and not is_cited(s) else s
                   for s in split_sentences(self.text_of(i))]
            self.rewrite("citations", i, " ".join(out),
                         self.t("autogeo.improve.citations.title"),
                         self.t("autogeo.improve.citations.rationale"), g / max(1, len(blocks)))
            made += 1
        if facts["external_links"] == 0 and self.n >= 150:
            ph = PLACEHOLDER[self.content_lang]
            # the "Sources" section is inserted into the page, so it follows the content language
            heading = "Kaynaklar" if self.content_lang == "tr" else "Sources"
            items = [f"[{ph['cite']} — resmi istatistik/düzenleyici kurum]({ph['cite_url']})",
                     f"[{ph['cite']} — hakemli akademik çalışma (DOI)]({ph['cite_url']})",
                     f"[{ph['cite']} — sektör raporu]({ph['cite_url']})"] if self.content_lang == "tr" else [
                     f"[{ph['cite']} — official statistics / regulator]({ph['cite_url']})",
                     f"[{ph['cite']} — peer-reviewed study (DOI)]({ph['cite_url']})",
                     f"[{ph['cite']} — industry report]({ph['cite_url']})"]
            md = f"## {heading}\n\n" + "\n".join(f"{n}. {it}" for n, it in enumerate(items, 1))
            labels = [re.sub(r"^\[|\]\(.*$", "", it) for it in items]
            html_items = "\n".join(f'  <li><a href="{ph["cite_url"]}">{lb}</a></li>' for lb in labels)
            self.insert("citations", len(self.blocks) - 1, md, f"<h2>{heading}</h2>\n<ol>\n{html_items}\n</ol>",
                        self.t("autogeo.improve.citations.sources.title"),
                        self.t("autogeo.improve.citations.sources.rationale"), g * 0.5)

    # -- 4. answer capsules --------------------------------------------
    def sections(self) -> list[tuple[int, ContentBlock, list[int]]]:
        out = []
        for i, b in enumerate(self.blocks):
            if b.kind == "heading" and b.level in (2, 3):
                body = []
                for k in range(i + 1, len(self.blocks)):
                    if self.blocks[k].kind == "heading" and self.blocks[k].level <= b.level:
                        break
                    if self.blocks[k].kind == "heading":
                        break
                    body.append(k)
                out.append((i, b, body))
        return out

    def capsule_quality(self, heading: str, block: ContentBlock | None) -> tuple[float, str]:
        t = self.t
        if block is None:
            return 0.0, t("autogeo.capsule.no_text")
        if block.kind == "list":
            return 0.3, t("autogeo.capsule.list_instead_of_paragraph")
        if block.kind not in ("paragraph", "blockquote"):
            return 0.1, t("autogeo.capsule.other_block", kind=block.kind)
        w = block.word_count
        q = 1.0 if 40 <= w <= 60 else 0.6 if 30 <= w <= 80 else 0.3 if 20 <= w <= 120 else 0.1
        why = t("autogeo.capsule.words", count=w) + ("" if q == 1.0 else t("autogeo.capsule.target_suffix"))
        # DANGLING_START holds the content language's context-dependent sentence openers (Turkish: "bu ", "ayrıca"...)
        if block.text.lower().startswith(DANGLING_START[self.content_lang]):
            q *= 0.7
            why += t("autogeo.capsule.dangling_opening")
        if _QUESTION_RE.search(heading.lower()):
            keys = {tok for tok in tx.words(_subject(heading)) if tok not in STOPWORDS and len(tok) > 2}
            if keys and not keys & set(tx.words(block.text)):
                q *= 0.8
                why += t("autogeo.capsule.no_question_term")
        return q, why

    def answer_capsules(self) -> tuple[float, str, dict[str, Any]]:
        secs = self.sections()
        rows = []
        for i, h, body in secs:
            first = self.blocks[body[0]] if body else None
            q, why = self.capsule_quality(h.text, first)
            rows.append({"heading": h.text, "block_index": i, "quality": round(q, 2), "reason": why})
        if rows:
            score = 100 * sum(r["quality"] for r in rows) / len(rows)
            good = sum(1 for r in rows if r["quality"] >= 0.99)
            detail = self.t("autogeo.metric.answer_capsules.detail", count=len(rows), good=good)
        else:
            idx = self.intro_index()
            first = self.blocks[idx] if 0 <= idx < len(self.blocks) and self.blocks[idx].kind == "paragraph" else None
            q, why = self.capsule_quality(self.topic, first)
            score = 100 * q
            if self.n > 300:
                score = min(score, 50.0)
            detail = self.t("autogeo.metric.answer_capsules.detail_intro", why=why)
            rows.append({"heading": self.topic, "block_index": idx, "quality": round(q, 2), "reason": why,
                         "intro": True})
        return clamp(score), detail, {"sections": rows, "section_count": len(secs)}

    def build_capsule(self, heading: str, body_idx: list[int]) -> str:
        subject = _subject(heading)
        sents: list[str] = []
        for k in body_idx:
            b = self.blocks[k]
            if b.kind == "heading":
                break
            if b.kind == "list":
                lead = heading.strip().rstrip("?:") + ":"
                sents += [lead + " " + "; ".join(b.items)] if not sents else b.items
            elif b.kind == "paragraph":
                sents += split_sentences(b.text)
        out: list[str] = []
        for s in sents:
            s = s.strip()
            if not s:
                continue
            if not re.search(r"[.!?…]$", s):
                s += "."
            if not out and s.lower().startswith(DANGLING_START[self.content_lang]):
                first, rest = s.split(" ", 1) if " " in s else (s, "")
                # "bu" / "o" / "şu" are the Turkish demonstratives (this / it / that), kept for Turkish content
                s = (f"{_capitalize(subject, self.content_lang)} {rest}" if first.lower() in ("bu", "this", "it", "o", "şu", "that")
                     else f"{_capitalize(subject, self.content_lang)}: {s}")
            n_out = sum(len(x.split()) for x in out)
            if n_out + len(s.split()) <= 60:
                out.append(s)
                if n_out + len(s.split()) >= 40:
                    break
            elif n_out < 40:
                room = 58 - n_out
                out.append(" ".join(s.split()[:room]).rstrip(",;:") + "…")
                break
            else:
                break
        capsule = " ".join(out)
        if len(capsule.split()) < 40:
            fill = PLACEHOLDER[self.content_lang]["fill"]
            capsule = (capsule + " " if capsule else f"{subject}: ") + fill
        return _tidy(capsule)

    def improve_answer_capsules(self, score: float, facts: dict[str, Any]) -> None:
        if score >= 90:
            return
        g = self.gain("answer_capsules", score)
        made = 0
        weak = [r for r in facts["sections"] if r["quality"] < 0.99]
        for r in weak:
            if made >= MAX_IMPROVEMENTS_PER_METRIC:
                break
            i = r["block_index"]
            if r.get("intro"):
                body = list(range(max(i, 0), len(self.blocks)))
                anchor = self.blocks[i] if i >= 0 else None
                if anchor is not None and anchor.kind == "heading":
                    body = list(range(i + 1, len(self.blocks)))
            else:
                body = next(bd for j, _, bd in self.sections() if j == i)
            capsule = self.build_capsule(r["heading"], body)
            nb = ContentBlock("paragraph", capsule)
            first = self.blocks[body[0]] if body else None
            title = self.t("autogeo.improve.capsule.title", heading=r["heading"][:60])
            why = self.t("autogeo.improve.capsule.rationale", reason=r["reason"])
            if first is not None and first.kind == "paragraph" and first.word_count < 40 and not r.get("intro"):
                self.rewrite("answer_capsules", body[0], capsule, title, why, g / len(weak))
            elif r.get("intro") and first is not None and first.kind == "paragraph" and i == body[0]:
                self.rewrite("answer_capsules", i, capsule, title, why, g / len(weak))
            else:
                self.insert("answer_capsules", i, nb.to_markdown(), nb.to_html(), title, why, g / len(weak))
            made += 1

    # -- 5. authority & fluency ----------------------------------------
    def authority_fluency(self) -> tuple[float, str, dict[str, Any]]:
        hedges = HEDGES[self.content_lang]
        sents = self.sentences or [self.text]
        hedge_s = [s for s in sents if any(_has(s, h) for h in hedges)]
        # passive voice: English auxiliaries + participle, or the Turkish "-mektedir / -maktadır" formal passive
        passive = [s for s in sents if _EN_PASSIVE.search(s)] if self.content_lang == "en" else \
            [s for s in sents if re.search(r"\w+(?:ıl|il|ul|ül|ın|in|un|ün)(?:abil|ebil)?(?:mektedir|maktadır)\b", s)]
        long_s = [s for s in sents if len(s.split()) > 35]
        filler = sum(tx.count_phrases(self.text, tx.FILLER_PHRASES).values())
        hype = sum(tx.count_phrases(self.text, tx.HYPE_PHRASES).values())
        n = max(len(sents), 1)
        hedge_pen = min(35.0, len(hedge_s) / n * 150)
        passive_pen = min(20.0, max(0.0, len(passive) / n - (0.25 if self.content_lang == "tr" else 0.15)) * 100)
        filler_pen = min(20.0, filler * 100 / max(self.n, 1) * 40)
        hype_pen = min(15.0, hype * 5.0)
        long_pen = min(15.0, max(0.0, len(long_s) / n - 0.1) * 75)
        score = clamp(100 - hedge_pen - passive_pen - filler_pen - hype_pen - long_pen)
        detail = self.t("autogeo.metric.authority_fluency.detail", hedged=len(hedge_s), filler=filler, hype=hype,
                        passive=len(passive), long=len(long_s))
        return score, detail, {"hedged": len(hedge_s), "filler": filler, "hype": hype, "passive": len(passive),
                               "long_sentences": len(long_s), "examples": (hedge_s + long_s)[:5]}

    def _strengthen(self, s: str) -> str:
        new = s
        for h, repl in sorted(HEDGES[self.content_lang].items(), key=lambda kv: -len(kv[0])):
            new = _phrase_re(h).sub(repl, new)
        for h in _HYPE_REWRITE:  # before filler removal: "game-changer" is both, and must not leave a hole
            new = _phrase_re(h).sub(HYPE_REPLACEMENT[self.content_lang], new)
        for f in sorted(tx.FILLER_PHRASES, key=len, reverse=True):
            new = re.sub(rf"(?<!\w){re.escape(f)}(?!\w)\s*,?", "", new, flags=re.I)
        new = _tidy(new)
        if new != s.strip():
            new = _capitalize(new, self.content_lang)
        return new

    def improve_authority_fluency(self, score: float, facts: dict[str, Any]) -> None:
        if score >= 85:
            return
        g = self.gain("authority_fluency", score)
        made = 0
        for i, b in self.paragraphs():
            if made >= MAX_IMPROVEMENTS_PER_METRIC:
                break
            cur = self.text_of(i)
            new = " ".join(self._strengthen(s) for s in split_sentences(cur))
            long_s = [s for s in split_sentences(new) if len(s.split()) > 35]
            if new.strip() == cur.strip():
                continue
            note = self.t("autogeo.improve.authority_fluency.split_note") if long_s else ""
            self.rewrite("authority_fluency", i, new,
                         self.t("autogeo.improve.authority_fluency.title"),
                         self.t("autogeo.improve.authority_fluency.rationale") + note, g / MAX_IMPROVEMENTS_PER_METRIC)
            made += 1

    # -- 6. keyword stuffing -------------------------------------------
    def keyword_stuffing(self) -> tuple[float, str, dict[str, Any]]:
        content = [t for t in self.tokens if t not in STOPWORDS and len(t) > 2 and t not in self.brand]
        if self.n < 60 or not content:
            return 100.0, self.t("autogeo.metric.keyword_stuffing.detail_short"), {"top_term": None, "share": 0.0,
                                                                                    "risk": "none"}
        word, cnt = Counter(content).most_common(1)[0]
        share = cnt / self.n
        bigrams = Counter(f"{a} {b}" for a, b in zip(self.tokens, self.tokens[1:])
                          if a not in STOPWORDS and b not in STOPWORDS and len(a) > 2 and len(b) > 2
                          and not ({a, b} & self.brand))
        top_bi, bi_cnt = bigrams.most_common(1)[0] if bigrams else ("", 0)
        bi_share = bi_cnt * 2 / self.n
        s_uni = clamp(100 - (share - 0.04) / 0.06 * 100) if share > 0.04 else 100.0
        s_bi = clamp(100 - (bi_share - 0.04) / 0.06 * 100) if bi_share > 0.04 else 100.0
        score = min(s_uni, s_bi)
        if self.n < 150 and share < 0.08 and bi_share < 0.10:  # short texts repeat their topic naturally
            score = max(score, 55.0)
        risk = "none" if score >= 70 else "-10%" if score >= 40 else "-25%"
        # the repeated phrase is the real culprit when it carries the top word and is nearly as excessive
        term = top_bi if top_bi and (s_bi < s_uni or (word in top_bi.split() and s_bi <= s_uni + 15)) else word
        detail = self.t("autogeo.metric.keyword_stuffing.detail", word=word, pct=f"{share * 100:.1f}", phrase=top_bi,
                        count=bi_cnt, risk=self.t("autogeo.risk.none") if risk == "none" else risk)
        return score, detail, {"top_term": term, "top_word": word, "share": round(share, 4), "top_phrase": top_bi,
                               "phrase_count": bi_cnt, "risk": risk}

    def improve_keyword_stuffing(self, score: float, facts: dict[str, Any]) -> None:
        if score >= 70 or not facts.get("top_term"):
            return
        term = facts["top_term"]
        pat = _phrase_re(term)
        g = METRIC_INFO["keyword_stuffing"]["gain"] * (100 - score) / 100
        made = 0
        ranked = sorted(self.paragraphs(), key=lambda ib: -len(pat.findall(self.text_of(ib[0]))))
        for i, _b in ranked:
            cur = self.text_of(i)
            hits = len(pat.findall(cur))
            if made >= MAX_IMPROVEMENTS_PER_METRIC or hits < 3:
                break
            seen = 0

            def repl(m: re.Match[str]) -> str:
                nonlocal seen
                seen += 1
                return m.group(0) if seen == 1 else PLACEHOLDER[self.content_lang]["synonym"]

            new = pat.sub(repl, cur)
            syn = re.escape(PLACEHOLDER[self.content_lang]["synonym"])
            new = re.sub(rf"{syn}(?:\s+{syn})+", PLACEHOLDER[self.content_lang]["synonym"], new)
            self.rewrite("keyword_stuffing", i, new,
                         self.t("autogeo.improve.keyword_stuffing.title", term=term),
                         self.t("autogeo.improve.keyword_stuffing.rationale", term=term, count=hits),
                         g / MAX_IMPROVEMENTS_PER_METRIC)
            made += 1

    # -- page-level suggestions ----------------------------------------
    def page_capsule(self) -> dict[str, Any]:
        idx = self.intro_index()
        start = idx if idx >= 0 and self.blocks[idx].kind == "paragraph" else idx + 1
        capsule = self.build_capsule(self.topic, list(range(max(start, 0), len(self.blocks))))
        nb = ContentBlock("paragraph", capsule)
        return {"text": capsule, "word_count": len(capsule.split()), "markdown": nb.to_markdown(),
                "html": nb.to_html()}

    def comparison_table(self) -> dict[str, Any] | None:
        if any(b.kind == "table" for b in self.blocks) or self.n < 80:
            return None
        heads = [b.text for b in self.blocks if b.kind == "heading" and b.level in (2, 3)][:6]
        items = next((b.items for b in self.blocks if b.kind == "list" and len(b.items) >= 3), [])[:6]
        criteria = heads if len(heads) >= 2 else [i.split(":")[0][:60] for i in items]
        tr = self.content_lang == "tr"  # the table is inserted into the page: headers/cells follow the content language
        if self.page_type in ("product", "category"):
            header = ["Özellik", self.topic[:60], "Alternatif A", "Alternatif B"] if tr else \
                ["Feature", self.topic[:60], "Alternative A", "Alternative B"]
            criteria = criteria or (["Fiyat", "Garanti", "Teknik özellik", "Kullanıcı puanı"] if tr else
                                    ["Price", "Warranty", "Key spec", "User rating"])
        elif self.page_type in ("service", "home", "about"):
            header = ["Kriter", "Bizim hizmetimiz", "Sektör ortalaması", "Kaynak"] if tr else \
                ["Criterion", "Our service", "Industry average", "Source"]
            criteria = criteria or (["Teslim süresi", "Fiyat aralığı", "Destek", "Memnuniyet"] if tr else
                                    ["Turnaround", "Price range", "Support", "Satisfaction"])
        else:
            header = ["Kriter", "Seçenek A", "Seçenek B", "Kaynak"] if tr else \
                ["Criterion", "Option A", "Option B", "Source"]
            criteria = criteria or (["Maliyet", "Süre", "Etkinlik", "Risk"] if tr else
                                    ["Cost", "Time", "Effectiveness", "Risk"])
        cell = "[DEĞER]" if tr else "[VALUE]"
        rows = [header] + [[c] + [cell] * (len(header) - 2) + ["[Kaynak, Yıl]" if tr else "[Source, Year]"]
                           if header[-1] in ("Kaynak", "Source") else [c] + [cell] * (len(header) - 1)
                           for c in criteria[:6]]
        tbl = ContentBlock("table", "", rows=rows)
        return {"markdown": tbl.to_markdown(), "html": tbl.to_html(), "rows": rows}


def _page_type_str(pt: PageType | str | None) -> str:
    if isinstance(pt, PageType):
        return pt.value
    return (pt or "other").lower()


def analyze_blocks(blocks: list[ContentBlock | dict[str, Any]], url: str = "", page_type: PageType | str | None = None,
                   content_lang: str = "", title: str = "", serp_rank: int | None = None,
                   brand_terms: Iterable[str] = (), *, lang: str = DEFAULT_LANG) -> AutoGeoReport:
    """Score a page's content blocks on the six AutoGEO metrics and generate block-level improvements.

    ``content_lang``: language hint of the page itself ("tr" | "en"; detected from the text when empty).
    ``lang``: language of the report text (metric labels/details, improvement titles and rationales)."""
    bl = [b if isinstance(b, ContentBlock) else ContentBlock.from_dict(b) for b in blocks]
    pt = _page_type_str(page_type)
    page = _Page(bl, url, pt, content_lang, title, serp_rank, brand_terms, lang)
    t = page.t
    weights = WEIGHTS[_PROFILE.get(pt, "default")]
    metrics: dict[str, AutoGeoMetric] = {}
    for key in METRIC_KEYS:
        score, detail, facts = getattr(page, key)()
        m = AutoGeoMetric(key=key, label=t(f"autogeo.metric.{key}.label"), score=round(score, 1), weight=weights[key],
                          detail=detail, facts=facts)
        m.potential_gain_pct = (METRIC_INFO[key]["gain"] * (100 - score) / 100 if key == "keyword_stuffing"
                                else page.gain(key, score))
        metrics[key] = m
    # Order matters: statistics/citation rewrites claim paragraphs first; later rules skip claimed blocks.
    for key in ("answer_capsules", "statistics", "citations", "quotations", "authority_fluency", "keyword_stuffing"):
        getattr(page, f"improve_{key}")(metrics[key].score, metrics[key].facts)
    for m in metrics.values():  # internal bookkeeping not needed downstream
        m.facts.pop("unattributed_blocks", None)
        if "uncited" in m.facts:
            m.facts["uncited"] = [s for _, s in m.facts["uncited"]][:5]
    report = AutoGeoReport(url=url, page_type=pt, language=page.content_lang, word_count=page.n, metrics=metrics,
                           improvements=page.improvements, answer_capsule=page.page_capsule() if bl else None,
                           comparison_table=page.comparison_table())
    if metrics["keyword_stuffing"].score < 40:
        report.caps.append(t("autogeo.cap.keyword_stuffing"))
    if report.comparison_table and pt in ("product", "category", "service", "article", "faq"):
        idx = next((i for i, b in enumerate(bl) if b.kind == "heading" and b.level in (2, 3)), page.intro_index())
        page.insert("statistics", idx, report.comparison_table["markdown"], report.comparison_table["html"],
                    t("autogeo.improve.comparison_table.title"),
                    t("autogeo.improve.comparison_table.rationale"),
                    page.gain("statistics", metrics["statistics"].score) * 0.4, rule_id="autogeo.comparison_table")
    return report


def analyze_html(html: str | bytes, url: str = "", page_type: PageType | str | None = None, content_lang: str = "",
                 title: str = "", serp_rank: int | None = None, brand_terms: Iterable[str] = (), *,
                 lang: str = DEFAULT_LANG) -> AutoGeoReport:
    if isinstance(html, bytes):
        html = html.decode("utf-8", errors="replace")
    if not content_lang:
        m_lang = re.search(r"<html[^>]*\blang=[\"']?([\w-]+)", html, re.I)
        content_lang = m_lang.group(1) if m_lang else ""
    if not title:
        m_title = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
        title = re.sub(r"\s+", " ", m_title.group(1)).strip() if m_title else ""
    return analyze_blocks(blocks_from_html(html, url), url, page_type, content_lang, title, serp_rank, brand_terms,
                          lang=lang)


def analyze_markdown(md: str, url: str = "", page_type: PageType | str | None = None, content_lang: str = "",
                     title: str = "", serp_rank: int | None = None, brand_terms: Iterable[str] = (), *,
                     lang: str = DEFAULT_LANG) -> AutoGeoReport:
    return analyze_blocks(blocks_from_markdown(md), url, page_type, content_lang, title, serp_rank, brand_terms,
                          lang=lang)


def analyze_page(page: PageData, serp_rank: int | None = None, brand_terms: Iterable[str] = (), *,
                 lang: str = DEFAULT_LANG) -> AutoGeoReport:
    """Uses the parser's content blocks; falls back to headings + flattened text for pages parsed elsewhere."""
    blocks: list[ContentBlock | dict[str, Any]] = list(page.content_blocks)
    if not blocks:
        for h in page.headings.get("h1", [])[:1]:
            blocks.append(ContentBlock("heading", h, level=1))
        if page.text:
            blocks.append(ContentBlock("paragraph", page.text))
    return analyze_blocks(blocks, page.url, page.page_type, page.lang, page.title, serp_rank, brand_terms, lang=lang)


_SITE_TYPES = (PageType.ARTICLE, PageType.PRODUCT, PageType.SERVICE, PageType.FAQ, PageType.CATEGORY, PageType.HOME,
               PageType.ABOUT, PageType.OTHER)


def analyze_pages(pages: Iterable[PageData], max_pages: int = 25, min_words: int = 80,
                  brand_terms: Iterable[str] = (), *, lang: str = DEFAULT_LANG) -> AutoGeoSiteReport:
    """AutoGEO over the content pages of a crawl (content-rich, citable page types first)."""
    order = {t: i for i, t in enumerate(_SITE_TYPES)}
    cands = [p for p in pages if p.page_type in order and p.word_count >= min_words and p.error is None]
    cands.sort(key=lambda p: (order[p.page_type], p.depth, -p.word_count))
    brand = tuple(brand_terms)
    return AutoGeoSiteReport(pages=[analyze_page(p, brand_terms=brand, lang=lang) for p in cands[:max_pages]])


# ---------------------------------------------------------------- CLI

def render_text(r: AutoGeoReport, show_diffs: bool = True, *, lang: str = DEFAULT_LANG) -> str:
    t = get_translator(lang)
    out = [t("autogeo.text.header", score=r.score, grade=r.grade, url=r.url or t("autogeo.text.content"),
             page_type=r.page_type, language=r.language, count=r.word_count)]
    out += [f"  {m.label:<34} {round(m.score):>3}  {m.detail}" for m in r.metrics.values()]
    if r.caps:
        out.append(t("autogeo.text.cap") + "; ".join(r.caps))
    out.append("\n" + t("autogeo.text.improvements", count=len(r.improvements)))
    for imp in r.improvements:
        out.append(f"\n• [{imp.metric}] {imp.title} {t('autogeo.text.gain', gain=imp.expected_gain_pct)}"
                   f"\n  {imp.rationale}")
        if show_diffs:
            out.append(imp.diff_markdown)
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="geo-autogeo", description="AutoGEO content scoring + rewrite diffs")
    ap.add_argument("source", help="URL, .html/.htm or .md file ('-' = stdin HTML)")
    ap.add_argument("--type", default=None, help="page type: product | service | article | ...")
    ap.add_argument("--url", default="", help="canonical URL of a local file (own-domain link detection)")
    ap.add_argument("--rank", type=int, default=None, help="current SERP position (citation gain model)")
    ap.add_argument("--markdown", action="store_true", help="treat input as Markdown")
    ap.add_argument("--json", action="store_true", help="print the JSON report instead of text")
    ap.add_argument("--lang", default=DEFAULT_LANG, type=normalize_lang, metavar="{en,tr}",
                    help="language of the report text (metric labels, details, improvement titles); default: en")
    args = ap.parse_args(argv)

    src, url = args.source, args.url
    if src.startswith(("http://", "https://")):
        import httpx
        # SSRF guard: refuses private/internal addresses on the first request and on every redirect hop
        with httpx.Client(follow_redirects=True, timeout=20, headers={"User-Agent": "geo-autogeo/1.0"},
                          event_hooks=SYNC_GUARD_HOOKS) as http:
            resp = http.get(src)
        content, url = resp.text, url or str(resp.url)
    elif src == "-":
        content = sys.stdin.read()
    else:
        with open(src, encoding="utf-8") as fh:
            content = fh.read()
    md = args.markdown or src.lower().endswith((".md", ".markdown"))
    fn = analyze_markdown if md else analyze_html
    report = fn(content, url=url, page_type=args.type, serp_rank=args.rank, lang=args.lang)
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2) if args.json
          else render_text(report, lang=args.lang))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
