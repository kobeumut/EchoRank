"""Lightweight, dependency-free keyword/concept extraction (TR + EN)."""
from __future__ import annotations

import math
import re
from collections import Counter

# English + Turkish stop-words. The Turkish half is deliberate language data: without it keyword/concept extraction
# would be dominated by function words on Turkish pages (ve = and, için = for, bir = a/one, ...).
STOPWORDS = set(
    """
    a an and are as at be been but by can do does for from has have how i if in into is it its
    me more most my no not of on or our out so than that the their them then there these they this
    to up us was we were what when where which who why will with you your all any also about
    after again before between both each few other some such only own same too very just over
    under here get got new one two may might must should would could per via etc
    ve veya ile ama fakat ancak de da ki mi mı mu mü bir bu şu o ne için gibi kadar daha çok en
    her hem ise ya yani olan olarak olan olup oldu olur sonra önce bile şey diye ayrıca tüm
    bizim sizin onların biz siz onlar ben sen bunu şunu onu buna şuna ona bunun şunun onun
    nasıl neden niçin hangi nerede zaman değil var yok ile göre karşı rağmen dolayı üzere
    tl try usd eur adet sepete ekle home anasayfa ana sayfa menu menü
    """.split()
)

# letters of the Latin alphabet plus the Turkish ones (ç ğ ı ö ş ü) and the circumflex vowels used in Turkish loanwords
_TOKEN = re.compile(r"[0-9a-zçğıöşüâîû]+", re.I)


def tokenize(text: str) -> list[str]:
    # Turkish-aware lowercasing for dotted/dotless I
    text = text.replace("İ", "i").replace("I", "ı").lower()
    return [t for t in _TOKEN.findall(text) if len(t) > 2 and t not in STOPWORDS and not t.isdigit()]


def ngrams(tokens: list[str], n: int) -> list[str]:
    return [" ".join(tokens[i : i + n]) for i in range(len(tokens) - n + 1)]


def extract_keywords(
    title: str,
    headings: list[str],
    body: str,
    top_n: int = 8,
    doc_freq: Counter[str] | None = None,
    n_docs: int = 1,
) -> list[tuple[str, float]]:
    """Weighted term frequency (title x3, headings x2, body x1) with optional IDF."""
    scores: Counter[str] = Counter()
    for text, weight in ((title, 3.0), (" ".join(headings), 2.0), (body[:20000], 1.0)):
        toks = tokenize(text)
        for t in toks:
            scores[t] += weight
        for bg in ngrams(toks, 2):
            scores[bg] += weight * 1.5
    if doc_freq is not None and n_docs > 1:
        for term in list(scores):
            df = doc_freq.get(term, 0)
            # boilerplate present on most pages ("add to basket") carries no topical signal
            if n_docs >= 5 and df / n_docs > 0.5:
                del scores[term]
                continue
            scores[term] *= math.log((1 + n_docs) / (1 + df)) + 1
    # bigrams that occur only once are noise
    ranked = [(t, s) for t, s in scores.most_common(top_n * 4) if " " not in t or s >= 3.0]
    out: list[tuple[str, float]] = []
    for term, score in ranked:
        # skip unigrams already covered by a selected bigram
        if any(term in sel.split() for sel, _ in out if " " in sel):
            continue
        out.append((term, round(score, 3)))
        if len(out) >= top_n:
            break
    return out


def document_terms(title: str, headings: list[str], body: str) -> set[str]:
    toks = tokenize(" ".join([title, " ".join(headings), body[:20000]]))
    return set(toks) | set(ngrams(toks, 2))
