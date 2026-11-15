"""Catalog parity and translator behaviour (en is the source of truth, tr must mirror it)."""
import re

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


# ---------------------------------------------------------------- message quality guards

def test_messages_are_valid_format_strings_without_literal_braces():
    """Messages without params are returned verbatim by ``t()`` and messages with params go through ``str.format``,
    so literal braces would either leak as ``{{`` or raise: code snippets must be assembled in Python, with
    ``{placeholders}`` as the only braces in a catalog."""
    for lang in SUPPORTED_LANGS:
        for key, message in catalog(lang).items():
            names = placeholders(message)  # raises ValueError on a stray brace
            rendered = message.format(**{name: "x" for name in names})
            assert "{" not in rendered and "}" not in rendered, f"{lang}:{key}"


def _code_literals():
    """Message ids referenced by the package source (AST scan): exact id literals and f-string id heads."""
    import ast
    from pathlib import Path

    import geo_crawler

    shape = re.compile(r"^(access|actions|autogeo|bot_simulator|eeat|engine|misc|readability|schema_rules|seo|signals|"
                       r"snippets)\.[a-z0-9_.]*$")
    exact: set[str] = set()
    heads: set[str] = set()
    for path in Path(geo_crawler.__file__).parent.rglob("*.py"):
        if "locales" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        skip: set[int] = set()  # constants that are not message ids: rule ids and the parts of f-strings
        for node in ast.walk(tree):
            if isinstance(node, ast.keyword) and node.arg == "rule_id" and isinstance(node.value, ast.Constant):
                skip.add(id(node.value))
            elif isinstance(node, ast.JoinedStr):
                skip.update(id(v) for v in node.values)
                if node.values and isinstance(node.values[0], ast.Constant) and shape.match(str(node.values[0].value)):
                    heads.add(str(node.values[0].value))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip \
                    and shape.match(node.value):
                exact.add(node.value)
    return exact, heads


def _plural_base(key: str) -> str:
    return key.rsplit("_", 1)[0] if key.endswith(("_one", "_other")) else key


def test_message_ids_used_in_code_exist_and_catalog_has_no_dead_keys():
    exact, heads = _code_literals()
    en = set(catalog("en"))
    bases = {_plural_base(k) for k in en}
    # a literal is valid if it is a message id, a plural base, or a prefix shared by ids (f"{prefix}.label" style)
    missing = sorted(lit for lit in exact if lit not in en and lit not in bases
                     and not any(k.startswith(lit.rstrip(".") + ".") for k in en))
    assert missing == [], f"message ids used in code but missing from the catalogs: {missing}"
    prefixes = {lit.rstrip(".") + "." for lit in exact if lit not in en and lit not in bases} | heads
    dead = sorted(k for k in en if k not in exact and _plural_base(k) not in exact
                  and not any(k.startswith(p) for p in prefixes))
    assert dead == [], f"catalog keys never referenced by the code: {dead}"
