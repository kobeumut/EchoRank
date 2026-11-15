"""English messages — namespace "autogeo" (source of truth; tr/autogeo.py must define the same keys).

Report text only (metric labels/details, improvement titles/rationales, CLI text). The bracketed placeholders that are
written *into* suggested rewrites follow the language of the analysed page and live in ``scoring/autogeo.py``.
"""
MESSAGES: dict[str, str] = {
    # ---- metric labels
    "autogeo.metric.statistics.label": "Statistics and numeric data",
    "autogeo.metric.quotations.label": "Expert quotations",
    "autogeo.metric.citations.label": "Authoritative source citations",
    "autogeo.metric.answer_capsules.label": "Answer capsules (40-60 words)",
    "autogeo.metric.authority_fluency.label": "Authoritative tone and fluency",
    "autogeo.metric.keyword_stuffing.label": "Keyword stuffing",
    # ---- metric details
    "autogeo.metric.statistics.detail": "Numeric figures: {facts} ({per100}/100 words, target ≥1.5); vague quantity phrases: {vague}; tables: {tables}.",
    "autogeo.metric.quotations.detail": "Attributed expert quotations: {attributed}; unattributed quotations: {unattributed} (target ≥{target}, about 1 per 600 words).",
    "autogeo.metric.citations.detail": "Cited claims: {cited} of {claims} verifiable; external sources: {external} (academic/official {tier1}, industry {tier2}, other {tier3}).",
    "autogeo.metric.answer_capsules.detail": "H2/H3 sections opening with a 40-60 word direct answer: {good} of {count}.",
    "autogeo.metric.answer_capsules.detail_intro": "There are no H2/H3 subheadings; intro paragraph: {why}.",
    "autogeo.metric.authority_fluency.detail": "Hedging/evasive sentences: {hedged}; filler phrases: {filler}; hype phrases: {hype}; passive sentences: {passive}; long sentences (>35 words): {long}.",
    "autogeo.metric.keyword_stuffing.detail_short": "Not enough text to measure (≥60 words).",
    "autogeo.metric.keyword_stuffing.detail": "The most frequent term '{word}' makes up {pct}% of the text (threshold 4%); the most frequent phrase is '{phrase}' (×{count}). Visibility loss risk: {risk}.",
    "autogeo.risk.none": "none",
    "autogeo.cap.keyword_stuffing": "excessive keyword repetition (cap 60)",
    # ---- answer-capsule diagnostics (stored per section in the metric facts)
    "autogeo.capsule.no_text": "there is no text under the heading",
    "autogeo.capsule.list_instead_of_paragraph": "there is a list instead of a paragraph right under the heading",
    "autogeo.capsule.other_block": "there is a {kind} under the heading",
    "autogeo.capsule.words_one": "{count} word",
    "autogeo.capsule.words_other": "{count} words",
    "autogeo.capsule.target_suffix": " (target 40-60)",
    "autogeo.capsule.dangling_opening": ", the opening depends on missing context",
    "autogeo.capsule.no_question_term": ", does not repeat the term from the question heading",
    # ---- improvements: titles and rationales
    "autogeo.improve.statistics.title": "Replace vague quantities with concrete figures",
    "autogeo.improve.statistics.rationale": "GEO (KDD 2024): Statistics Addition raises visibility by ~37%. Fill the bracketed fields with verified figures and sources.",
    "autogeo.improve.statistics.table.title": "Add a 'Key figures' table",
    "autogeo.improve.statistics.table.rationale": "The page has fewer than 1 concrete figure per 100 words; LLMs quote numeric, verifiable passages more often.",
    "autogeo.improve.quotations.attribute.title": "Add a speaker and job title to the quotation",
    "autogeo.improve.quotations.attribute.rationale": "An unattributed quotation cannot be verified by LLMs; a name, title and organization turn it into an authority signal.",
    "autogeo.improve.quotations.insert.title": "Add a direct quotation from a credentialed expert",
    "autogeo.improve.quotations.insert.rationale": "GEO (KDD 2024): Quotation Addition is the strategy with the highest gain (~41%). Use a permitted, verifiable quotation from a real person.",
    "autogeo.improve.citations.title": "Cite authoritative sources for claims",
    "autogeo.improve.citations.rationale": "GEO (KDD 2024): Cite Sources gives a ~30-40% gain, and +115.1% for pages ranked 5th or lower in the SERP. Prefer linking .gov/.edu sources, a DOI or an industry report.",
    "autogeo.improve.citations.sources.title": "Add a 'Sources' section at the end of the page",
    "autogeo.improve.citations.sources.rationale": "The page has no external source links at all.",
    "autogeo.improve.capsule.title": "Answer capsule for '{heading}'",
    "autogeo.improve.capsule.rationale": "{reason}. AutoGEO (ICLR 2026): a self-contained 40-60 word direct answer right under the heading increases the likelihood that LLM summarizers quote the passage.",
    "autogeo.improve.authority_fluency.title": "Remove hedges and filler phrases",
    "autogeo.improve.authority_fluency.rationale": "GEO (KDD 2024): Authoritative/Fluency optimization gives a ~25% gain. Use clear, objective and measurable wording.",
    "autogeo.improve.authority_fluency.split_note": " Split long sentences in two.",
    "autogeo.improve.keyword_stuffing.title": "Reduce the repetition of '{term}'",
    "autogeo.improve.keyword_stuffing.rationale": "'{term}' appears {count} times in this paragraph. LLM semantic filters treat excessive repetition as spam (GEO: Keyword Stuffing carries a -10%..-25% risk). Keep the first use and replace the others with a synonym or a pronoun.",
    "autogeo.improve.comparison_table.title": "Add a comparison table",
    "autogeo.improve.comparison_table.rationale": "Tables are the structures LLMs parse and quote most easily; fill them with concrete values.",
    # ---- text report (CLI)
    "autogeo.text.header_one": "AutoGEO {score}/100 ({grade}) — {url} [{page_type}, {language}, {count} word]",
    "autogeo.text.header_other": "AutoGEO {score}/100 ({grade}) — {url} [{page_type}, {language}, {count} words]",
    "autogeo.text.content": "content",
    "autogeo.text.cap": "  Cap: ",
    "autogeo.text.improvements_one": "{count} improvement:",
    "autogeo.text.improvements_other": "{count} improvements:",
    "autogeo.text.gain": "(+~{gain}%)",
}
