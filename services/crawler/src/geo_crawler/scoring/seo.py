"""Pillar 4 — classic technical SEO hygiene (feeds GeoAudit.seoScore and 15% of the GEO score)."""
from __future__ import annotations

from .base import AuditContext, Check, Pillar, clamp, ratio_score


def analyze_seo(ctx: AuditContext) -> Pillar:
    t = ctx.t
    pillar = Pillar("technical_seo", t("seo.pillar.label"), 0.15)
    pages = ctx.pages
    n = len(pages)
    g = ctx.gaps

    bad_titles = sorted(p.url for p in pages if not (10 <= len(p.title) <= 65))
    dup = [u for group in g.get("duplicate_titles", []) for u in group]
    pillar.add(Check("titles", t("seo.check.titles.label"),
                     0.7 * ratio_score(n - len(bad_titles), n, 0) + 0.3 * ratio_score(n - len(dup), n, 0), 15,
                     t("seo.check.titles.detail", bad=len(bad_titles), total=n, count=len(dup)),
                     urls=sorted(set(bad_titles) | set(dup))))

    no_desc = g.get("missing_meta_description", [])
    pillar.add(Check("meta_description", t("seo.check.meta_description.label"),
                     ratio_score(n - len(no_desc), n, 0), 10,
                     t("seo.check.meta_description.detail", missing=len(no_desc), total=n), urls=no_desc))

    h1_missing, h1_multi = g.get("missing_h1", []), g.get("multiple_h1", [])
    pillar.add(Check("headings", t("seo.check.headings.label"),
                     ratio_score(n - len(h1_missing) - 0.5 * len(h1_multi), n, 0), 10,
                     t("seo.check.headings.detail", missing=len(h1_missing), multi=len(h1_multi)),
                     urls=sorted(set(h1_missing) | set(h1_multi))))

    no_canon = sorted(p.url for p in pages if not p.canonical)
    no_lang = sorted(p.url for p in pages if not p.lang)
    pillar.add(Check("canonical_lang", t("seo.check.canonical_lang.label"),
                     0.6 * ratio_score(n - len(no_canon), n, 0) + 0.4 * ratio_score(n - len(no_lang), n, 0), 10,
                     t("seo.check.canonical_lang.detail", canonical=len(no_canon), lang=len(no_lang)), urls=no_canon))

    no_og = g.get("missing_open_graph", [])
    pillar.add(Check("open_graph", t("seo.check.open_graph.label"), ratio_score(n - len(no_og), n, 0), 5,
                     t("seo.check.open_graph.detail", missing=len(no_og), total=n), urls=no_og))

    broken = g.get("broken_pages", [])
    total = len(ctx.crawl.pages)
    pillar.add(Check("broken_pages", t("seo.check.broken_pages.label"),
                     clamp(100 - 100 * len(broken) / max(total, 1) * 3), 15,
                     t("seo.check.broken_pages.detail", broken=len(broken), total=total)
                     + (t("seo.check.broken_pages.example", url=broken[0]["url"], status=broken[0]["status"])
                        if broken else ""),
                     urls=[b["url"] for b in broken]))

    thin = g.get("thin_content_pages", [])
    pillar.add(Check("thin_content", t("seo.check.thin_content.label"), ratio_score(n - len(thin), n, 0), 15,
                     t("seo.check.thin_content.detail", thin=len(thin), total=n), urls=thin))

    orphans = g.get("orphan_pages", [])
    not_in_sm = g.get("sitemap_missing_pages", [])
    has_sm = bool(ctx.crawl.sitemap_urls)
    pillar.add(Check("internal_linking", t("seo.check.internal_linking.label"),
                     0.5 * ratio_score(n - len(orphans), n, 0)
                     + 0.5 * (ratio_score(n - len(not_in_sm), n, 0) if has_sm else 0), 15,
                     t("seo.check.internal_linking.detail", count=len(orphans),
                       sitemap=t("misc.word.present" if has_sm else "misc.word.missing_caps"))
                     + (t("seo.check.internal_linking.not_in_sitemap", count=len(not_in_sm)) if has_sm else ""),
                     urls=sorted(set(orphans) | set(not_in_sm))))

    imgs = sum((p.content_stats or {}).get("images", 0) for p in pages)
    no_alt = sum((p.content_stats or {}).get("images_without_alt", 0) for p in pages)
    pillar.add(Check("image_alt", t("seo.check.image_alt.label"), ratio_score(imgs - no_alt, imgs), 5,
                     t("seo.check.image_alt.detail", missing=no_alt, total=imgs)))
    pillar.facts = {"bad_titles": bad_titles, "missing_meta_description": no_desc, "broken": broken, "thin": thin,
                    "orphans": orphans, "has_sitemap": has_sm}
    return pillar
