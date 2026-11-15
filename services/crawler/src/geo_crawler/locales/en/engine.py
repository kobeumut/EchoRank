"""English messages — namespace "engine" (report summary and score caps; tr/engine.py must define the same keys)."""
MESSAGES: dict[str, str] = {
    "engine.summary_one": "GEO score {geo}/100 ({grade}). AI access {ai_access}, LLM readability {readability}, E-E-A-T {eeat}, technical SEO {seo}. Weakest area: {weakest}. {count} recommended action ({high} high-impact).",
    "engine.summary_other": "GEO score {geo}/100 ({grade}). AI access {ai_access}, LLM readability {readability}, E-E-A-T {eeat}, technical SEO {seo}. Weakest area: {weakest}. {count} recommended actions ({high} high-impact).",
    "engine.summary.caps_prefix": " Score capped: ",
    "engine.cap.answer_bots_blocked": "all AI search/answer bots are blocked by robots.txt (cap 35)",
    "engine.cap.waf_blocks": "WAF/CDN is blocking AI bots (cap 45)",
    "engine.cap.csr": "key pages are rendered client-side (CSR) (cap 40)",
    "engine.cap.no_pages": "no pages could be fetched",
}
