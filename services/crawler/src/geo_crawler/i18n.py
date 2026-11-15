"""Message catalogs for the human-readable text the scoring engine produces (check details, action cards, fixes).

English (``en``) is the default and the fallback; Turkish (``tr``) is the second supported language.

Catalogs live in ``geo_crawler/locales/<lang>/<namespace>.py``; each module exposes ``MESSAGES: dict[str, str]``.
Keys are globally unique dotted strings prefixed by the namespace (``"actions.robots.title"``). Values use
``str.format`` style ``{placeholders}``. Plural forms: ``key_one`` / ``key_other`` selected by ``count=``.

    from geo_crawler.i18n import get_translator
    t = get_translator("tr")
    t("actions.robots.title", count=3)

To add a language: create ``locales/<code>/`` with the same modules as ``locales/en/``, add the code to
``SUPPORTED_LANGS`` and run the tests (``tests/test_i18n.py`` checks key and placeholder parity).
"""
from __future__ import annotations

import importlib
import pkgutil
import string
from functools import lru_cache
from typing import Callable

DEFAULT_LANG = "en"
SUPPORTED_LANGS = ("en", "tr")

Translator = Callable[..., str]


def normalize_lang(value: str | None) -> str:
    """'tr-TR', 'TR', 'en_GB' → a supported code; anything else → the default (English)."""
    base = (value or "").strip().lower().replace("_", "-").split("-")[0]
    return base if base in SUPPORTED_LANGS else DEFAULT_LANG


@lru_cache(maxsize=None)
def catalog(lang: str) -> dict[str, str]:
    """All messages of one language (every ``locales/<lang>/*.py`` module merged)."""
    package = importlib.import_module(f"{__package__}.locales.{lang}")
    merged: dict[str, str] = {}
    for info in pkgutil.iter_modules(package.__path__):
        module = importlib.import_module(f"{package.__name__}.{info.name}")
        overlap = merged.keys() & module.MESSAGES.keys()
        if overlap:
            raise ValueError(f"duplicate message keys in locales/{lang}/{info.name}.py: {sorted(overlap)[:5]}")
        merged.update(module.MESSAGES)
    return merged


def _plural_suffix(lang: str, count: int) -> str:
    # English and Turkish both distinguish exactly "one" (n == 1) from "other".
    return "one" if count == 1 else "other"


def get_translator(lang: str | None = None) -> Translator:
    """Return ``t(key, **params)`` for ``lang`` with English fallback; unknown keys return the key itself."""
    code = normalize_lang(lang)
    primary, fallback = catalog(code), catalog(DEFAULT_LANG)

    def t(key: str, **params: object) -> str:
        count = params.get("count")
        if isinstance(count, (int, float)) and not isinstance(count, bool):
            plural = f"{key}_{_plural_suffix(code, int(count))}"
            template = primary.get(plural) or fallback.get(plural)
        else:
            template = None
        if template is None:
            template = primary.get(key, fallback.get(key, key))
        try:
            return template.format(**params) if params else template
        except (KeyError, IndexError):
            return template

    return t


def placeholders(template: str) -> set[str]:
    """Names of the ``{placeholders}`` used by a message (for parity tests)."""
    return {name for _, name, _, _ in string.Formatter().parse(template) if name}
