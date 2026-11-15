// Namespace "botsim" — Turkish. Must define exactly the keys of ../en/botsim.ts with the same {placeholders}.
import type { botsim as en } from "../en/botsim";

export const botsim: Record<keyof typeof en, string> = {
  // ------------------------------------------------------------ bot notes
  "botsim.note.robotsOnly": "{token} yalnızca robots.txt jetonudur; {vendor} içeriği {crawler} ile alır.",

  // ------------------------------------------------------------ protection names + evidence
  "botsim.protection.cf1015": "Cloudflare 1015 hız sınırı",
  "botsim.protection.cfBlock": "Cloudflare WAF engeli",
  "botsim.protection.imperva": "Imperva (Incapsula) engeli",
  "botsim.protection.akamai": "Akamai engeli",
  "botsim.protection.awsBlock": "AWS WAF / CloudFront engeli",
  "botsim.protection.sucuri": "Sucuri WAF engeli",
  "botsim.protection.genericBlock": "Genel bot engeli",
  "botsim.protection.http429": "HTTP 429 hız sınırı",
  "botsim.protection.serverWaf": "Sunucu/WAF",
  "botsim.protection.httpBlock": "{vendor} HTTP {status} engeli",
  "botsim.evidence.body": "gövde: '{match}'",

  // ------------------------------------------------------------ render integrity (reason of the render verdict)
  "botsim.render.csrShellRoot_one": "#{id} kökü boş, sunucu HTML'inde yalnızca {count} kelime var; içerik JavaScript ile yükleniyor",
  "botsim.render.csrShellRoot_other": "#{id} kökü boş, sunucu HTML'inde yalnızca {count} kelime var; içerik JavaScript ile yükleniyor",
  "botsim.render.csrShell_one": "sunucu HTML'inde yalnızca {count} kelime var; içerik JavaScript ile yükleniyor",
  "botsim.render.csrShell_other": "sunucu HTML'inde yalnızca {count} kelime var; içerik JavaScript ile yükleniyor",
  "botsim.render.thin_one": "sunucu HTML'inde yalnızca {count} kelime var",
  "botsim.render.thin_other": "sunucu HTML'inde yalnızca {count} kelime var",
  "botsim.render.heavyJs": "metin/HTML oranı %{pct}; içerik ağır JS içinde kaybolabilir",
  "botsim.render.hydrated": "SSR/SSG ({frameworks}) — içerik ilk HTML'de mevcut",
  "botsim.render.static": "içerik ilk HTML yanıtında mevcut",

  // ------------------------------------------------------------ page bloat
  "botsim.bloat.nextRsc": "Next.js RSC yükü",
  "botsim.bloat.domNodes": "DOM {nodes} düğüm (>{limit})",
  "botsim.bloat.domDepth": "DOM derinliği {depth} (>{limit})",
  "botsim.bloat.jsonState": "gömülü JSON durum verisi {kb} KB (%{pct}, en büyüğü {kind})",
  "botsim.bloat.inlineCss": "satır içi CSS {kb} KB",
  "botsim.bloat.inlineSvg": "satır içi SVG {kb} KB",
  "botsim.bloat.dataUri": "base64 data URI {kb} KB",
  "botsim.bloat.inlineJs": "satır içi JavaScript {kb} KB",

  // ------------------------------------------------------------ fetch errors, outcome labels, per-bot reason
  "botsim.error.timeout": "zaman aşımı",
  "botsim.error.redirectLoop": "yönlendirme döngüsü",
  "botsim.error.requestFailed": "İstek başarısız: {message}",
  "botsim.outcome.ok": "erişilebilir",
  "botsim.outcome.degraded": "eksik içerik",
  "botsim.outcome.challenge": "challenge/CAPTCHA",
  "botsim.outcome.blocked": "engellendi",
  "botsim.outcome.rate_limited": "hız sınırı",
  "botsim.outcome.not_found": "bulunamadı",
  "botsim.outcome.server_error": "sunucu hatası",
  "botsim.outcome.error": "bağlantı hatası",
  "botsim.reason.errorSilent": "{error} (tarayıcı isteği başarılı → AI UA bağlantısı düşürülüyor)",
  "botsim.reason.degraded_one": "tarayıcıya göre içeriğin %{pct}'i döndü ({count} kelime)",
  "botsim.reason.degraded_other": "tarayıcıya göre içeriğin %{pct}'i döndü ({count} kelime)",
  "botsim.reason.ok_one": "HTTP {status}, {count} kelime",
  "botsim.reason.ok_other": "HTTP {status}, {count} kelime",

  // ------------------------------------------------------------ findings
  "botsim.finding.wafChallenge.title_one": "{count} AI botu challenge/CAPTCHA sayfasına takılıyor",
  "botsim.finding.wafChallenge.title_other": "{count} AI botu challenge/CAPTCHA sayfasına takılıyor",
  "botsim.finding.wafChallenge.detail": "{names}: AI tarayıcıları JavaScript çalıştıramaz ve CAPTCHA çözemez; içerik yerine doğrulama sayfası alıyorlar.",
  "botsim.finding.wafBlock.title_one": "{count} AI botu sunucu/WAF tarafından reddediliyor",
  "botsim.finding.wafBlock.title_other": "{count} AI botu sunucu/WAF tarafından reddediliyor",
  "botsim.finding.wafBlock.silent": "robots.txt {bots} için izin verdiği hâlde (sessiz engel).",
  "botsim.finding.rateLimited.title_one": "{count} AI botu hız sınırına (429) takılıyor",
  "botsim.finding.rateLimited.title_other": "{count} AI botu hız sınırına (429) takılıyor",
  "botsim.finding.rateLimited.detail": "Düşük hacimli tek isteklerde bile 429 dönüyor; AI botları için rate-limit muafiyeti tanımlayın.",
  "botsim.finding.generalBlock.title": "Bot koruması tüm otomatik istekleri durduruyor",
  "botsim.finding.generalBlock.wall": "{name} tüm otomatik istemcilere (tarayıcı simülasyonu dahil) gösteriliyor. Gerçek tarayıcılar JavaScript çalıştırıp geçebilir, AI botları geçemez.",
  "botsim.finding.generalBlock.noWall": "Tarayıcı isteği de engellendi: genel bot duvarı, IP/ülke engeli veya site kapalı. AI botları da içeriğe ulaşamıyor.",
  "botsim.finding.contentParity.title_one": "{count} AI botu tarayıcıdan daha az içerik alıyor",
  "botsim.finding.contentParity.title_other": "{count} AI botu tarayıcıdan daha az içerik alıyor",
  "botsim.finding.robotsDisallow.title_one": "{count} AI botu robots.txt ile engelli",
  "botsim.finding.robotsDisallow.title_other": "{count} AI botu robots.txt ile engelli",
  "botsim.finding.robotsDisallow.detail": "Bu botlar robots.txt'ye uyar ve canlı erişim açık olsa bile sayfayı almaz.",
  "botsim.finding.slowResponse.title": "AI botlarına ilk bayt 3 saniyeden geç geliyor",
  "botsim.finding.slowResponse.detail": "En yavaş: {ms} ms. Kullanıcı tetiklemeli AI getiricileri kısa zaman aşımıyla çalışır.",
  "botsim.finding.csrShell.title_one": "{count} sayfa AI botlarına boş JS kabuğu döndürüyor",
  "botsim.finding.csrShell.title_other": "{count} sayfa AI botlarına boş JS kabuğu döndürüyor",
  "botsim.finding.csrShell.detail": "{reason}. AI tarayıcıları JavaScript çalıştırmaz; SSR/SSG veya prerender gerekli.",
  "botsim.finding.thinHtml.title_one": "{count} sayfanın sunucu HTML'i zayıf",
  "botsim.finding.thinHtml.title_other": "{count} sayfanın sunucu HTML'i zayıf",
  "botsim.finding.tokenBloat.title_one": "{count} sayfada şişkin DOM / gömülü veri",
  "botsim.finding.tokenBloat.title_other": "{count} sayfada şişkin DOM / gömülü veri",
  "botsim.finding.lowSignal.title": "HTML token yükünün çok küçük kısmı okunabilir içerik",
  "botsim.finding.lowSignal.detail": "{htmlTokens} HTML token'ının yalnızca {textTokens}'i metin (%{pct}).",
  "botsim.finding.noCompression.title": "HTML yanıtı sıkıştırılmadan gönderiliyor",
  "botsim.finding.noCompression.detail": "gzip/brotli açın; büyük sayfalar AI getiricilerinde zaman aşımına uğrayabilir.",
  "botsim.finding.largeHtml.title": "HTML yanıtı 1 MB'tan büyük",
  "botsim.finding.largeHtml.detail": "Büyük yanıtlar AI getiricilerinde kesilebilir veya bütçeyi tüketir.",

  // ------------------------------------------------------------ caveats
  "botsim.caveat.serverIp":
    "Simülasyon AI sağlayıcılarının IP aralıklarından değil, bu sunucudan yapıldı. WAF botları IP ile doğruluyorsa (örn. Cloudflare verified bots) gerçek botların sonucu farklı olabilir; WAF olay kayıtlarında (Security Events) doğrulayın.",
  "botsim.caveat.robotsOnly":
    "Google-Extended ve Applebot-Extended yalnızca robots.txt jetonudur; canlı istek Googlebot/Applebot kimliğiyle yapıldı.",

  // ------------------------------------------------------------ fix recipes: titles + instructions
  "botsim.fix.cf.title": "Cloudflare WAF: AI botları için Skip kuralı",
  "botsim.fix.cf.instructions": "Kuralı mevcut engelleme kurallarının üstüne yerleştirin; Security Events'te 'Skip' olarak görünmelidir.",
  "botsim.fix.nginx.title": "nginx: AI botlarını UA engeli ve rate limit'ten muaf tutun",
  "botsim.fix.nginx.instructions":
    "Mevcut 'deny'/'return 403' ve limit_req kurallarınızı bu değişkenlerle koşullandırıp `nginx -t && nginx -s reload` çalıştırın.",
  "botsim.fix.apache.title": "Apache / LiteSpeed (.htaccess) ve ModSecurity istisnası",
  "botsim.fix.apache.instructions": "Değişiklikten sonra `apachectl configtest && apachectl graceful` çalıştırın.",
  "botsim.fix.aws.title": "AWS WAF: AI botları için Allow kuralı + Bot Control istisnası",
  "botsim.fix.aws.instructions":
    "Allow kuralını Web ACL'de en düşük önceliğe (0) ekleyin; Bot Control'de CategoryAI kuralını Count'a çekin.",
  "botsim.fix.akamai.title": "Akamai Bot Manager: AI botlarına izin verin",
  "botsim.fix.akamai.instructions":
    "Security Configurations → Bot Manager → Known Bots → 'AI Crawlers' / 'Web Search Engine Bots' kategorilerinin aksiyonunu Allow (veya Monitor) yapın. Özel kural gerekiyorsa User-Agent regex: ({alt}).",
  "botsim.fix.imperva.title": "Imperva: AI botlarını 'Good bots' olarak işaretleyin",
  "botsim.fix.imperva.instructions":
    "Website → Security → Bot Protection → Good Bots listesine ilgili AI botlarını ekleyin; Client Classification'da 'Search bots/AI' için Block/CAPTCHA aksiyonunu kaldırın.",
  "botsim.fix.vercel.title": "Vercel Firewall: AI botlarını bypass edin",
  "botsim.fix.vercel.instructions":
    "Project → Firewall → Bot Management → 'AI Bots' kuralını Log/Off yapın; Custom Rule: User Agent matches ({alt}) → Bypass. Attack Challenge Mode açıksa kapatın.",
  "botsim.fix.sucuri.title": "Sucuri WAF: AI botlarını allowlist'e ekleyin",
  "botsim.fix.sucuri.instructions": "Firewall → Access Control → Allowlist User Agents bölümüne şu UA parçalarını ekleyin: {list}.",
  "botsim.fix.datadome.title": "DataDome: AI botları için izin kuralı",
  "botsim.fix.datadome.instructions":
    "Dashboard → Custom Rules → 'User-Agent contains' ({list}) → Allow; veya Bot Management'te 'AI Agents' kategorisini Allow yapın.",
  "botsim.fix.perimeterx.title": "HUMAN (PerimeterX): AI botlarını allowlist'e ekleyin",
  "botsim.fix.perimeterx.instructions": "Policies → Allowlist → User-Agent: {list}.",
  "botsim.fix.console.instructions": "Yönetim panelinden uygulayın ve simülasyonu tekrar çalıştırın.",
  "botsim.fix.ssr.title": "İçeriği sunucu tarafında render edin (SSR/SSG/prerender)",
  "botsim.fix.ssr.instructions":
    "Next.js/Nuxt/SvelteKit'te SSR veya statik üretim; saf React SPA için prerender (örn. Rendertron, prerender.io) ya da framework'e geçiş.",
  "botsim.fix.diet.title": "AI token yükünü azaltın (DOM ve gömülü JSON)",
  "botsim.fix.diet.instructions": "Hedef: metin token'ı / HTML token'ı oranı ≥ %10, HTML < 500 KB.",

  // ------------------------------------------------------------ fix recipes: comments inside the generated snippets
  // (the comment markers `#` / `//` are added by the code, not stored here)
  "botsim.fix.cf.where": "Cloudflare → Security → WAF → Custom rules → Create rule (listenin EN ÜSTÜNE taşıyın)",
  "botsim.fix.cf.logOn": "+ \"Log matching requests\" açık",
  "botsim.fix.cf.strict": "Yalnızca doğrulanmış botlar (UA taklidine kapalı, önerilen sıkı sürüm):",
  "botsim.fix.cf.also1": "Ayrıca: Security → Bots → \"Block AI bots\" = Off, \"AI Labyrinth\" = Off;",
  "botsim.fix.cf.also2":
    "AI Crawl Control → ilgili crawler'lar = Allow. (Ücretsiz plandaki Bot Fight Mode Skip ile atlanamaz → kapatın.)",
  "botsim.fix.nginx.http": "http { } bloğu (örn. /etc/nginx/conf.d/ai-bots.conf)",
  "botsim.fix.nginx.limitKey": "rate limit anahtarı: AI botları için boş anahtar = limit uygulanmaz",
  "botsim.fix.nginx.server": "server { } bloğu — mevcut UA engelinizi AI botları dışında bırakın:",
  "botsim.fix.nginx.existing": "← mevcut kuralınız",
  "botsim.fix.apache.mark": ".htaccess veya <VirtualHost> — AI botlarını işaretle",
  "botsim.fix.apache.step1": "1) AI botlarını engelleyen RewriteRule'ları kaldırın veya istisna ekleyin:",
  "botsim.fix.apache.step2": "2) Apache 2.4 erişim kuralı (Require not env bad_bot vb. kullanıyorsanız):",
  "botsim.fix.apache.step3": "3) ModSecurity / OWASP CRS tarayıcı tespitinden muaf tutun:",
  "botsim.fix.ssr.intro": "AI botları JavaScript çalıştırmaz; {url} ilk HTML'de içerik döndürmeli.",
  "botsim.fix.ssr.next": "Next.js (App Router) — sayfayı Server Component olarak render edin:",
  "botsim.fix.ssr.isr": "ISR: saatte bir statik yeniden üretim",
  "botsim.fix.ssr.fetch": "sunucuda veri çek (useEffect + fetch DEĞİL)",
  "botsim.fix.ssr.spa": "Vite/CRA SPA: SSR'a (Next.js, Remix, Astro) geçin veya botlara prerender edilmiş HTML sunun.",
  "botsim.fix.diet.stateHeading": "Gömülü durum verisi (__NEXT_DATA__ / RSC / __NUXT__):",
  "botsim.fix.diet.state1": "getServerSideProps / loader / Server Component'ten yalnızca sayfanın kullandığı alanları döndürün",
  "botsim.fix.diet.state2": "Büyük listeleri sayfalayın; ürün açıklamalarını hem HTML'de hem JSON'da iki kez göndermeyin",
  "botsim.fix.diet.domHeading": "DOM:",
  "botsim.fix.diet.dom1": "Gizli mega menü / mobil menü kopyalarını ilk HTML'den çıkarıp etkileşimde yükleyin",
  "botsim.fix.diet.dom2": "Satır içi SVG ikonlarını <use href=\"/sprite.svg#icon\"> ile tekrar kullanın; base64 görselleri dosyaya taşıyın",
  "botsim.fix.diet.transferHeading": "Aktarım:",
  "botsim.fix.diet.transfer1": "gzip/brotli açık olmalı (nginx: gzip on; gzip_types text/html application/json;)",
};
