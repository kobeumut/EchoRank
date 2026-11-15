"""Turkish messages — namespace "snippets" (same keys and {placeholders} as en/snippets.py)."""
MESSAGES: dict[str, str] = {
    "snippets.site_summary_default": "{name} resmi web sitesi.",
    # ---- policy pages (title shown to the user, URL path used in the footer / WebPage schema)
    "snippets.policy.privacy.title": "Gizlilik ve KVKK Aydınlatma Metni",
    "snippets.policy.privacy.path": "/gizlilik-politikasi",
    "snippets.policy.terms.title": "Kullanım Koşulları / Mesafeli Satış Sözleşmesi",
    "snippets.policy.terms.path": "/kullanim-kosullari",
    "snippets.policy.returns.title": "İade ve Cayma Hakkı Politikası",
    "snippets.policy.returns.path": "/iade-politikasi",
    "snippets.policy.shipping.title": "Kargo ve Teslimat Bilgileri",
    "snippets.policy.shipping.path": "/kargo-teslimat",
    "snippets.policy.footer_comment": "<!-- 1) Footer'a (tüm sayfalarda) bağlantı ekleyin -->",
    "snippets.policy.pages_comment": "<!-- 2) Her politika sayfasına güncelleme tarihi içeren WebPage şeması -->",
    # ---- robots.txt
    "snippets.robots.header": "# --- AI arama ve cevap motorları (GEO) ---",
    "snippets.robots.private_comment": "# Özel alanlar yine kapalı kalabilir:",
    "snippets.robots.cart_path": "/sepet/",
    # ---- WAF / CDN
    "snippets.waf.cloudflare_rule": "# Cloudflare → Security → WAF → Custom rules → \"Skip\" (Bot Fight Mode / Super Bot Fight Mode'dan önce)",
    "snippets.waf.cloudflare_bots": "# Cloudflare → Security → Bots → \"Block AI bots\" ve \"AI Labyrinth\" ayarlarını kapatın.",
    "snippets.waf.nginx_intro": "# nginx'te UA tabanlı engel varsa istisna ekleyin:",
    "snippets.waf.nginx_wrap": "# ... mevcut \"deny\"/\"return 403\" kuralınızı {code} içine alın.",
    # ---- robots directives
    "snippets.directive.remove": "<!-- KALDIRIN: {example} -->",
    "snippets.directive.replace_with": "<!-- Yerine: -->",
    "snippets.directive.header_comment": "# Sunucu başlığı (nginx) — noai / noindex içeren X-Robots-Tag'i kaldırın:",
    "snippets.directive.delete_line": "# add_header X-Robots-Tag \"noindex, noai\";   ← silin",
    # ---- server-side rendering
    "snippets.ssr.intro": "// AI botları JavaScript çalıştırmaz; {url} ilk HTML'de içerik döndürmeli.",
    "snippets.ssr.next_comment": "// Next.js (App Router) — sayfayı Server Component olarak render edin:",
    "snippets.ssr.file_comment": "// app/urun/[slug]/page.tsx",
    "snippets.ssr.revalidate_comment": "// ISR: saatte bir statik yeniden üretim",
    "snippets.ssr.fetch_comment": "// sunucuda veri çek (useEffect + fetch DEĞİL)",
    "snippets.ssr.spa_comment": "// React SPA (Vite/CRA) için geçiş mümkün değilse: prerender (ör. prerender.io / rendertron)",
    "snippets.ssr.nginx_comment": "// nginx: bot UA'larını prerender servisine yönlendirin",
    # ---- llms.txt section titles
    "snippets.llms.group.products": "Ürünler",
    "snippets.llms.group.services": "Hizmetler",
    "snippets.llms.group.categories": "Kategoriler",
    "snippets.llms.group.guides": "Rehberler ve Blog",
    "snippets.llms.group.faq": "Sıkça Sorulan Sorular",
    "snippets.llms.group.company": "Kurumsal",
    # ---- placeholder values inside generated JSON-LD / HTML examples
    "snippets.default.phone": "+90 212 000 00 00",
    "snippets.default.phone_jsonld": "+90-TODO",
    "snippets.default.country": "TR",
    "snippets.default.currency": "TRY",
    "snippets.default.locality": "İstanbul",
    "snippets.default.author_path": "/yazar/",
    "snippets.breadcrumb.home": "Anasayfa",
    # ---- FAQ block template
    "snippets.qa.default_topic": "Bu ürün",
    "snippets.qa.template": (
        '<section id="sss">\n'
        '  <h2>{topic} hakkında sık sorulan sorular</h2>\n'
        '  <h3>{topic} nedir / ne işe yarar?</h3>\n'
        '  <p><!-- 1-2 cümlede doğrudan cevap, 40-60 kelime. İlk cümle soruyu tekrar etmeden cevaplasın. --></p>\n'
        '  <h3>{topic} fiyatı ne kadar, neler dahil?</h3>\n'
        '  <p><!-- Net rakam + birim: "12.499 TL, 2 yıl garanti ve ücretsiz kargo dahil." --></p>\n'
        '  <h3>{topic} kimler için uygun değil?</h3>\n'
        '  <p><!-- Dürüst sınırlamalar güven sinyalidir. --></p>\n'
        '</section>\n'
        '<!-- Ardından aynı soruları FAQPage JSON-LD olarak ekleyin. -->'),
    # ---- information density template
    "snippets.density.default_topic": "Ürün",
    "snippets.density.template": (
        '<!-- Uzun paragrafları AI\'ın alıntılayabileceği yapılara bölün -->\n'
        '<p><strong>Özet:</strong> {topic}, <!-- tek cümlelik net tanım + en önemli 1 rakam --></p>\n'
        '\n'
        '<h2>Teknik özellikler</h2>\n'
        '<table>\n'
        '  <tr><th>Özellik</th><th>Değer</th></tr>\n'
        '  <tr><td>Güç</td><td>1.450 W</td></tr>\n'
        '  <tr><td>Kapasite</td><td>1,8 L</td></tr>\n'
        '  <tr><td>Garanti</td><td>2 yıl</td></tr>\n'
        '</table>\n'
        '\n'
        '<h2>Öne çıkanlar</h2>\n'
        '<ul>\n'
        '  <li><!-- Ölçülebilir fayda: "25 saniyede espresso" --></li>\n'
        '  <li><!-- Karşılaştırma: "X modeline göre %30 daha sessiz (52 dB)" --></li>\n'
        '</ul>\n'
        '<!-- Kaçının: "günümüzde", "son derece", "hepimizin bildiği gibi" gibi dolgu ifadeler. -->'),
    # ---- contact details template
    "snippets.contact.comment": "<!-- İletişim sayfası + footer: makinece okunabilir ve doğrulanabilir iletişim -->",
    "snippets.contact.sample_address": "Örnek Mah. Örnek Cad. No:1, 34000 İstanbul, Türkiye",
    "snippets.contact.phone_label": "Tel",
    "snippets.contact.email_label": "E-posta",
    "snippets.contact.registry_label": "MERSİS / Vergi No",
    # ---- citation template
    "snippets.citation.default_claim": "Araştırmalara göre kullanıcıların %70'i ...",
    "snippets.citation.template": (
        '<!-- Kaynaksız iddia: "{claim}" -->\n'
        '<p>\n'
        '  {claim}\n'
        '  <sup><a href="#kaynak-1" id="ref-1">[1]</a></sup>\n'
        '</p>\n'
        '\n'
        '<section id="kaynaklar">\n'
        '  <h2>Kaynaklar</h2>\n'
        '  <ol>\n'
        '    <li id="kaynak-1">\n'
        '      <cite><a href="https://doi.org/{todo}" rel="noopener">Yazar, A. (2025). Çalışma başlığı. Dergi Adı.</a></cite>\n'
        '      <a href="#ref-1">↩</a>\n'
        '    </li>\n'
        '  </ol>\n'
        '</section>\n'
        '<!-- Article şemasına da ekleyin: "citation": ["https://doi.org/..."] -->'),
    # ---- HSTS
    "snippets.hsts.comment": "# nginx — HTTP'yi kalıcı olarak HTTPS'e yönlendir + HSTS",
}
