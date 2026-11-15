"""Catalog parity and translator behaviour (en is the source of truth, tr must mirror it)."""
import pytest

from geo_crawler.i18n import DEFAULT_LANG, SUPPORTED_LANGS, catalog, get_translator, normalize_lang, placeholders


def test_normalize_lang_falls_back_to_english():
    assert [normalize_lang(v) for v in ("tr", "TR-tr", "en_GB", "de", "", None)] == ["tr", "tr", "en", "en", "en", "en"]
    assert DEFAULT_LANG == "en"


@pytest.mark.parametrize("lang", [code for code in SUPPORTED_LANGS if code != "en"])
def test_catalog_parity_with_english(lang):
    en, other = catalog("en"), catalog(lang)
    assert sorted(other) == sorted(en), "keys missing/extra in %s: %s" % (lang, sorted(set(en) ^ set(other))[:10])
    bad = [k for k in en if placeholders(en[k]) != placeholders(other[k])]
    assert bad == [], "placeholder mismatch: %s" % bad[:10]
    assert [k for k, v in other.items() if not v.strip()] == []


def test_translator_fallback_and_plurals(monkeypatch):
    import geo_crawler.i18n as i18n

    fake = {"en": {"a.n_one": "{count} page", "a.n_other": "{count} pages", "a.hello": "Hello {name}", "a.only_en": "only"}, "tr": {"a.hello": "Merhaba {name}"}}
    monkeypatch.setattr(i18n, "catalog", lambda lang: fake[lang])
    t = i18n.get_translator("tr")
    assert t("a.hello", name="Ada") == "Merhaba Ada"
    assert t("a.only_en") == "only"  # fallback to English
    assert t("a.n", count=1) == "1 page" and t("a.n", count=3) == "3 pages"
    assert t("missing.key") == "missing.key"
    assert get_translator("xx")("a.hello", name="Bob") == get_translator("en")("a.hello", name="Bob")
