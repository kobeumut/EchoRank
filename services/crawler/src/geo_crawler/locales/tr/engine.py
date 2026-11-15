"""Turkish messages — namespace "engine" (same keys and {placeholders} as en/engine.py)."""
MESSAGES: dict[str, str] = {
    "engine.summary_one": "GEO skoru {geo}/100 ({grade}). AI erişim {ai_access}, LLM okunabilirlik {readability}, E-E-A-T {eeat}, teknik SEO {seo}. En zayıf alan: {weakest}. {count} aksiyon önerisi ({high} yüksek etkili).",
    "engine.summary_other": "GEO skoru {geo}/100 ({grade}). AI erişim {ai_access}, LLM okunabilirlik {readability}, E-E-A-T {eeat}, teknik SEO {seo}. En zayıf alan: {weakest}. {count} aksiyon önerisi ({high} yüksek etkili).",
    "engine.summary.caps_prefix": " Skor sınırlandı: ",
    "engine.cap.answer_bots_blocked": "tüm AI arama/cevap botları robots.txt ile engelli (üst sınır 35)",
    "engine.cap.waf_blocks": "WAF/CDN AI botlarını engelliyor (üst sınır 45)",
    "engine.cap.csr": "önemli sayfalar istemci tarafında (CSR) render ediliyor (üst sınır 40)",
    "engine.cap.no_pages": "hiç sayfa alınamadı",
}
