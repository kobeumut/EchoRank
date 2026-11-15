"""Sample pages (weak vs. optimized) for the AutoGEO tests: blog, product and service content.

The pages are Turkish web content on purpose: they exercise the Turkish lexicons, placeholders and heuristics
(vague quantities, hedges, attribution verbs, ...). ``EN_BLOG`` covers the English paths.
"""

WEAK_BLOG = """<html lang="tr"><head><title>Espresso Rehberi | Kahve Dükkanı</title></head><body>
<nav><a href="/">Anasayfa</a> <a href="/blog">Blog</a></nav>
<article>
<h1>Espresso Rehberi</h1>
<p>Günümüzde birçok insan güne espresso ile başlıyor. Bu yazımızda espresso hakkında merak edilenleri anlatacağız.</p>
<h2>Espresso nedir?</h2>
<p>Bu aslında oldukça yoğun bir kahve türüdür ve sanırım çoğu kişi onu sever.</p>
<h2>Espresso nasıl hazırlanır?</h2>
<ul><li>Kahveyi öğütün</li><li>Portafiltreye doldurun</li><li>Demleyin</li></ul>
<h2>Espresso makinesi seçimi</h2>
<p>Espresso makinesi seçerken espresso makinesi fiyatları, espresso makinesi markaları ve espresso makinesi
özellikleri önemlidir. Espresso makinesi alırken espresso makinesi yorumlarını okuyun çünkü espresso makinesi
en iyi yatırımdır. Espresso makinesi espresso makinesi espresso makinesi kullanıcıları belki de çok daha mutlu
olur. Araştırmalara göre espresso makinesi kullananlar kahveden önemli ölçüde daha fazla keyif alır.</p>
<blockquote>Kahve bir yaşam biçimidir ve iyi espresso sabır ister.</blockquote>
</article>
<footer><p>Telif hakkı Kahve Dükkanı tüm hakları saklıdır</p></footer>
</body></html>"""

STRONG_BLOG = """<html lang="tr"><head><title>Espresso Rehberi</title></head><body><main>
<h1>Espresso Rehberi</h1>
<p>Espresso, 9 bar basınç altında 25-30 saniyede 18 gram ince öğütülmüş kahveden geçirilen 30-40 ml yoğun bir
kahve özütüdür. İtalyan Ulusal Espresso Enstitüsü'ne göre ideal su sıcaklığı 88-92 °C aralığındadır ve bir shot
yaklaşık 63 mg kafein içerir; bu değer filtre kahvenin 240 ml'lik fincanının üçte biri kadardır.</p>
<h2>Espresso nedir?</h2>
<p>Espresso, sıcak suyun 9 bar basınçla ince öğütülmüş kahveden 25-30 saniyede geçirilmesiyle elde edilen 30 ml'lik
yoğun bir içecektir. Üzerindeki krema tabakası kahvedeki yağların emülsiyonudur. Uluslararası Kahve Örgütü
verilerine göre dünyada günlük 2,25 milyar fincan kahve tüketilmektedir ve espresso bunların %15'ini oluşturur.</p>
<blockquote><p>İyi bir espressoyu belirleyen üç değişken öğütme, doz ve demleme süresidir; bunlardan biri 2 saniye
saparsa tat profili belirgin biçimde değişir.</p><footer>— <cite>Dr. Ayşe Kaya, Gıda Mühendisi, Ankara Üniversitesi</cite></footer></blockquote>
<h2>Espresso nasıl hazırlanır?</h2>
<p>Espresso hazırlamak için 18 gram kahve 200-300 mikron inceliğinde öğütülür, portafiltreye 15 kg kuvvetle
sıkıştırılır ve 92 °C suyla 25-30 saniye demlenir. Sonuçta 36 gram (1:2 oran) espresso elde edilir; bu oran
Specialty Coffee Association tarafından önerilen başlangıç reçetesidir ve ev makinelerinde de tekrarlanabilir.</p>
<table><tr><th>Parametre</th><th>Değer</th><th>Kaynak</th></tr><tr><td>Basınç</td><td>9 bar</td><td>SCA</td></tr>
<tr><td>Süre</td><td>25-30 sn</td><td>SCA</td></tr></table>
<p>Kaynaklar: <a href="https://www.ico.org/stats">ICO istatistikleri</a>,
<a href="https://doi.org/10.1016/j.foodchem.2020.1">Food Chemistry (2020)</a>,
<a href="https://www.tarimorman.gov.tr/kahve">Tarım ve Orman Bakanlığı</a>.</p>
</main></body></html>"""

PRODUCT = """<html lang="tr"><head><title>Barista Pro X</title></head><body><main>
<h1>Barista Pro X Espresso Makinesi</h1>
<p>Barista Pro X, 15 bar pompa basıncı, 1.450 W ısıtıcı ve 2 litrelik su haznesiyle ev kullanımı için tasarlanmış
yarı otomatik bir espresso makinesidir. 58 mm portafiltre ve PID sıcaklık kontrolü ile 92 °C'de ±1 °C sapma sağlar.</p>
<h2>Teknik özellikler</h2>
<ul><li>Basınç: 15 bar</li><li>Güç: 1.450 W</li><li>Hazne: 2 L</li><li>Ağırlık: 7,8 kg</li></ul>
<h2>Kimler için uygun?</h2>
<p>Bu makine birçok kahve meraklısı için idealdir.</p>
</main></body></html>"""

SERVICE_MD = """# Kurumsal SEO Danışmanlığı

Kurumsal SEO danışmanlığı, 500+ sayfalık siteler için teknik denetim, içerik stratejisi ve bağlantı profili
yönetimini kapsayan 6 aylık bir hizmettir. Müşterilerimizin organik trafiği ilk 6 ayda ortalama %42 artmıştır
([Google Search Central](https://developers.google.com/search/docs) yönergeleriyle uyumlu).

## Hizmet kapsamı nedir?

Hizmet; teknik SEO denetimi, anahtar kelime araştırması, içerik takvimi ve aylık raporlamadan oluşur. Her ay
40 saatlik uzman çalışması ayrılır, 2 haftada bir toplantı yapılır ve tüm bulgular önceliklendirilmiş bir aksiyon
listesiyle teslim edilir. Ölçümler Google Search Console ve GA4 verileriyle yapılır.

> SEO bir maliyet kalemi değil, bileşik getiri sağlayan bir yatırımdır.
> — Mehmet Demir, SEO Direktörü, Ajans X

## Süreç

1. Keşif görüşmesi
2. Teknik denetim
3. Strateji ve uygulama

| Paket | Süre | Fiyat |
| --- | --- | --- |
| Başlangıç | 3 ay | 45.000 TL |
| Kurumsal | 6 ay | 120.000 TL |
"""

EN_BLOG = """<html lang="en"><head><title>Remote Work Guide</title></head><body><article>
<h1>Remote work productivity</h1>
<p>In today's world, many companies have adopted remote work. I think it is basically a game-changer and most
employees probably prefer it. Studies show that productivity was significantly improved by remote setups.</p>
<h2>What is remote work?</h2>
<p>It is a way of working outside the office.</p>
</article></body></html>"""
