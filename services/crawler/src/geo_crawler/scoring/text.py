"""Language heuristics (Turkish + English) for density, claims and spam signals."""
from __future__ import annotations

import re
from collections import Counter

from ..keywords import STOPWORDS

WORD_RE = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)?", re.U)
NUMBER_RE = re.compile(r"(?<![\w.,])(?:%\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)*(?:\s?(?:%|tl|₺|\$|€|usd|eur|kg|g|gr|mg|ml|lt|l|cm|mm|m|km|w|kw|v|mah|gb|tb|mb|bar|yıl|ay|gün|saat|dk|year|years|months|days|hours|min))?)(?![\w])", re.I)
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-ZÇĞİÖŞÜ0-9\"“(])")

FILLER_PHRASES = (
    # TR
    "günümüzde", "hepimizin bildiği gibi", "bilindiği üzere", "şunu belirtmek gerekir ki", "son derece",
    "bir hayli", "kesinlikle", "aslında", "tabii ki", "her şeyden önce", "sonuç olarak şunu söyleyebiliriz",
    "öncelikle belirtmek isteriz", "çok önemli bir konu", "hiç şüphesiz", "bu yazımızda", "merak edilen",
    # EN
    "in today's world", "it goes without saying", "needless to say", "at the end of the day", "as we all know",
    "in this article", "without a doubt", "it is important to note", "in conclusion", "basically", "literally",
    "very unique", "world-class", "cutting-edge", "game-changer", "best-in-class",
)
HYPE_PHRASES = (
    # TR
    "en iyi", "en ucuz", "1 numara", "bir numara", "rakipsiz", "mucize", "mucizevi", "garantili", "%100 garanti",
    "yüzde yüz", "kaçırmayın", "inanılmaz", "şok fiyat", "hemen al", "tartışmasız", "efsane", "kesin sonuç",
    "doktorların önerdiği", "bilim insanları şaşkın",
    # EN
    "best ever", "number one", "#1", "guaranteed", "100% guaranteed", "miracle", "unbelievable", "risk-free",
    "act now", "doctors hate", "secret trick", "instant results", "once in a lifetime",
)
CLAIM_MARKERS = (
    # TR
    "araştırma", "araştırmalara göre", "çalışma", "çalışmalar", "bilimsel", "kanıtlanmış", "klinik", "istatistik",
    "uzmanlara göre", "verilere göre", "rapor", "anket", "test edilmiş", "onaylı", "sertifikalı",
    # EN
    "study", "studies", "research", "proven", "clinically", "scientifically", "according to", "survey",
    "statistics", "experts say", "data shows", "report",
)
SOURCE_MARKERS = re.compile(r"\b(kaynak|kaynaklar|referans|referanslar|source|sources|references|bibliography|"
                            r"doi:|isbn)\b", re.I)
EXPERIENCE_MARKERS = (
    "test ettik", "denedik", "kullandık", "deneyimimiz", "tecrübemiz", "yıllık deneyim", "uygulamalı", "inceledik",
    "ölçtük", "bizzat", "kendi testlerimiz", "laboratuvarımızda",
    "we tested", "we tried", "hands-on", "in our experience", "our team tested", "we measured", "first-hand",
    "years of experience", "we reviewed",
)


def words(text: str) -> list[str]:
    return WORD_RE.findall(text.lower())


def count_phrases(text: str, phrases: tuple[str, ...]) -> Counter[str]:
    low = f" {text.lower()} "
    c: Counter[str] = Counter()
    for ph in phrases:
        if ph.startswith("#") or ph.startswith("%"):
            n = low.count(ph)
        else:
            n = len(re.findall(rf"(?<![\w]){re.escape(ph)}(?![\w])", low))
        if n:
            c[ph] = n
    return c


def numbers(text: str) -> list[str]:
    return NUMBER_RE.findall(text)


def sentences(text: str) -> list[str]:
    return [s.strip() for s in SENTENCE_RE.split(text) if len(s.split()) >= 4]


def lexical_diversity(tokens: list[str], window: int = 400) -> float:
    """Mean type/token ratio over fixed windows (length-independent)."""
    if not tokens:
        return 0.0
    if len(tokens) < window:
        return len(set(tokens)) / len(tokens) if len(tokens) >= 50 else 0.6
    ratios = [len(set(tokens[i:i + window])) / window for i in range(0, len(tokens) - window + 1, window)]
    return sum(ratios) / len(ratios)


def keyword_stuffing(tokens: list[str], exclude: set[str] | frozenset[str] = frozenset()) -> tuple[str, float] | None:
    """Most frequent content word and its share of all words, if suspicious (>4% on 200+ words).

    ``exclude``: brand tokens (domain / site name) — a brand naturally dominates its own pages."""
    content = [t for t in tokens if t not in STOPWORDS and len(t) > 2 and t not in exclude]
    if len(tokens) < 200 or not content:
        return None
    word, n = Counter(content).most_common(1)[0]
    share = n / len(tokens)
    return (word, share) if share > 0.04 else None


def claim_sentences(text: str, limit: int = 200) -> list[str]:
    """Sentences making verifiable claims: statistics/percentages or research/authority appeals."""
    out = []
    for s in sentences(text)[:limit]:
        low = s.lower()
        has_stat = bool(re.search(r"%\s?\d|\d\s?%|\byüzde\s?\d|\bpercent\b|\d+\s?(kat|times|x)\b", low))
        has_marker = any(re.search(rf"(?<![\w]){re.escape(m)}", low) for m in CLAIM_MARKERS)
        if has_stat or has_marker:
            out.append(s[:300])
    return out
