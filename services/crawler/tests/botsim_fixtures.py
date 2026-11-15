"""Live-response fixtures for the AI bot simulator: SSR page, CSR shell and real-world WAF interstitials.

The SSR / CSR sample pages are Turkish web content on purpose (Turkish tokenizer, <noscript> and render paths);
the WAF interstitials are verbatim English vendor pages.
"""

ORIGIN = "https://botsim.example.com"

SSR_PAGE = """<!doctype html><html lang="tr"><head><title>Barista Pro X Espresso Makinesi</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Barista Pro X"}</script>
</head><body><header><nav><a href="/">Ana sayfa</a></nav></header><main><article>
<h1>Barista Pro X Espresso Makinesi</h1>
""" + "\n".join(
    f"<p>Barista Pro X, {i * 3 + 9} bar basınç ve çift kazan sistemiyle ev ve ofis kullanımında tutarlı espresso "
    f"çekimi sağlar. Paslanmaz çelik gövdesi, PID sıcaklık kontrolü ve buhar çubuğu ile süt köpürtme işlemi "
    f"profesyonel seviyededir. Bölüm {i}: bakım, kireç çözme ve öğütme ayarları adım adım açıklanmıştır.</p>"
    for i in range(12)
) + """
</article></main><footer>© 2026 Kahve Dükkanı</footer></body></html>"""

CSR_SHELL = """<!doctype html><html lang="tr"><head><title>Kahve Dükkanı</title>
<script type="module" src="/assets/index-4f2a.js"></script><script src="/assets/vendor-91c.js"></script>
<script src="/assets/chunk-1.js"></script></head>
<body><noscript>Bu uygulamayı kullanmak için JavaScript'i etkinleştirin.</noscript><div id="root"></div></body></html>"""

CF_MANAGED_CHALLENGE = """<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="refresh" content="390"></head><body><div class="main-wrapper" role="main">
<div class="main-content"><noscript><div id="challenge-error-title">Enable JavaScript and cookies to continue</div>
</noscript></div></div><script>(function(){window._cf_chl_opt={cvId: '3',cZone: "botsim.example.com",
cType: 'managed',cRay: '8f1c2d3e4f5a6b7c',cH: 'abc'};var a=document.createElement('script');
a.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=8f1c2d3e4f5a6b7c';}());</script></body></html>"""

CF_BLOCK_1020 = """<!DOCTYPE html><html class="no-js" lang="en-US"><head><title>Attention Required! | Cloudflare</title>
</head><body><div id="cf-wrapper"><div id="cf-error-details" class="cf-error-details-wrapper">
<h1 data-translate="block_headline">Sorry, you have been blocked</h1>
<h2 class="cf-subheadline">You are unable to access botsim.example.com</h2>
<p>Cloudflare Ray ID: <strong>8f1c2d3e4f5a6b7c</strong></p></div></div></body></html>"""

IMPERVA_BLOCK = """<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"></head>
<body style="margin:0px;height:100%"><iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=24&xinfo=1-2-3"
frameborder=0>Request unsuccessful. Incapsula incident ID: 1234000560012345678-123456789</iframe></body></html>"""

AKAMAI_BLOCK = """<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>
You don't have permission to access "http&#58;&#47;&#47;botsim&#46;example&#46;com&#47;" on this server.<P>
Reference&#32;&#35;18&#46;6f2f1302&#46;1700000000&#46;1a2b3c4d<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18
</BODY></HTML>""".replace("&#46;", ".")

DATADOME_CAPTCHA = """<html><head><title>botsim.example.com</title></head><body>
<script>var dd={'rt':'c','cid':'AHrlqAAAAAMA','hsh':'ABC','t':'fe','s':12345,'host':'geo.captcha-delivery.com'}</script>
<script src="https://ct.captcha-delivery.com/c.js"></script></body></html>"""

TURNSTILE_INTERSTITIAL = """<html><head><title>Güvenlik kontrolü</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head>
<body><form><div class="cf-turnstile" data-sitekey="0x4AAAAA"></div></form></body></html>"""

CONTACT_PAGE_WITH_RECAPTCHA = SSR_PAGE.replace(
    "</article>", '<form><div class="g-recaptcha" data-sitekey="x"></div>'
                  '<script src="https://www.google.com/recaptcha/api.js"></script></form></article>')


def bloated_page(state_kb: int = 150, nodes: int = 1800) -> str:
    state = '{"props":{"pageProps":{"items":[' + ",".join(
        '{"id":%d,"name":"Ürün %d","description":"%s"}' % (i, i, "x" * 80) for i in range(state_kb * 1024 // 110)
    ) + "]}}}"
    divs = "".join(f"<div class='c'><span>{i}</span></div>" for i in range(nodes // 2))
    return SSR_PAGE.replace("</main>", f"</main>{divs}").replace(
        "</body>", f'<script id="__NEXT_DATA__" type="application/json">{state}</script></body>')
