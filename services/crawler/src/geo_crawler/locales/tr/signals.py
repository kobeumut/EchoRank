"""Turkish messages — namespace "signals" (same keys and {placeholders} as en/signals.py)."""
MESSAGES: dict[str, str] = {
    "signals.llms.empty": "dosya boş",
    "signals.llms.html_response": "HTML döndürüyor (muhtemelen 404 sayfası veya SPA fallback)",
    "signals.llms.no_h1": "ilk satır '# Site Adı' başlığı değil",
    "signals.llms.no_summary": "'>' ile başlayan kısa site özeti yok",
    "signals.llms.no_sections": "'## Bölüm' başlıkları yok",
    "signals.llms.no_links": "'- [Başlık](url): açıklama' biçiminde bağlantı yok",
    "signals.llms.unreachable": "erişilemedi: {error}",
    "signals.llms.wrong_content_type": "text/plain yerine text/html döndürüyor",
}
