"""Pillar 4 — classic technical SEO hygiene (feeds GeoAudit.seoScore and 15% of the GEO score)."""
from __future__ import annotations

from .base import AuditContext, Check, Pillar, clamp, ratio_score


def analyze_seo(ctx: AuditContext) -> Pillar:
    pillar = Pillar("technical_seo", "Teknik SEO", 0.15)
    pages = ctx.pages
    n = len(pages)
    g = ctx.gaps

    bad_titles = sorted(p.url for p in pages if not (10 <= len(p.title) <= 65))
    dup = [u for group in g.get("duplicate_titles", []) for u in group]
    pillar.add(Check("titles", "Title etiketleri", 0.7 * ratio_score(n - len(bad_titles), n, 0) + 0.3 * ratio_score(n - len(dup), n, 0),
                     15, f"{len(bad_titles)}/{n} sayfada title yok veya uzunluğu uygun değil (10-65); "
                         f"{len(dup)} sayfa yinelenen title kullanıyor", urls=sorted(set(bad_titles) | set(dup))))

    no_desc = g.get("missing_meta_description", [])
    pillar.add(Check("meta_description", "Meta description", ratio_score(n - len(no_desc), n, 0), 10,
                     f"{len(no_desc)}/{n} sayfada meta description eksik", urls=no_desc))

    h1_missing, h1_multi = g.get("missing_h1", []), g.get("multiple_h1", [])
    pillar.add(Check("headings", "H1 / başlık hiyerarşisi", ratio_score(n - len(h1_missing) - 0.5 * len(h1_multi), n, 0), 10,
                     f"{len(h1_missing)} sayfada H1 yok, {len(h1_multi)} sayfada birden fazla H1",
                     urls=sorted(set(h1_missing) | set(h1_multi))))

    no_canon = sorted(p.url for p in pages if not p.canonical)
    no_lang = sorted(p.url for p in pages if not p.lang)
    pillar.add(Check("canonical_lang", "Canonical & lang", 0.6 * ratio_score(n - len(no_canon), n, 0)
                     + 0.4 * ratio_score(n - len(no_lang), n, 0), 10,
                     f"{len(no_canon)} sayfada canonical, {len(no_lang)} sayfada <html lang> eksik", urls=no_canon))

    no_og = g.get("missing_open_graph", [])
    pillar.add(Check("open_graph", "Open Graph", ratio_score(n - len(no_og), n, 0), 5,
                     f"{len(no_og)}/{n} sayfada og:title eksik", urls=no_og))

    broken = g.get("broken_pages", [])
    total = len(ctx.crawl.pages)
    pillar.add(Check("broken_pages", "Kırık sayfalar", clamp(100 - 100 * len(broken) / max(total, 1) * 3), 15,
                     f"{len(broken)}/{total} URL hata döndürüyor" + (f" (örn. {broken[0]['url']} → {broken[0]['status']})" if broken else ""),
                     urls=[b["url"] for b in broken]))

    thin = g.get("thin_content_pages", [])
    pillar.add(Check("thin_content", "İnce içerik", ratio_score(n - len(thin), n, 0), 15,
                     f"{len(thin)}/{n} sayfa 150 kelimenin altında", urls=thin))

    orphans = g.get("orphan_pages", [])
    not_in_sm = g.get("sitemap_missing_pages", [])
    has_sm = bool(ctx.crawl.sitemap_urls)
    pillar.add(Check("internal_linking", "İç linkleme & sitemap",
                     0.5 * ratio_score(n - len(orphans), n, 0) + 0.5 * (ratio_score(n - len(not_in_sm), n, 0) if has_sm else 0), 15,
                     f"{len(orphans)} yetim sayfa (iç link yok); sitemap {'var' if has_sm else 'YOK'}"
                     + (f", {len(not_in_sm)} sayfa sitemap'te değil" if has_sm else ""),
                     urls=sorted(set(orphans) | set(not_in_sm))))

    imgs = sum((p.content_stats or {}).get("images", 0) for p in pages)
    no_alt = sum((p.content_stats or {}).get("images_without_alt", 0) for p in pages)
    pillar.add(Check("image_alt", "Görsel alt metinleri", ratio_score(imgs - no_alt, imgs), 5,
                     f"{no_alt}/{imgs} görselde alt metni yok"))
    pillar.facts = {"bad_titles": bad_titles, "missing_meta_description": no_desc, "broken": broken, "thin": thin,
                    "orphans": orphans, "has_sitemap": has_sm}
    return pillar
