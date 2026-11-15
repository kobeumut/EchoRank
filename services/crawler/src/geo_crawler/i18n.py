"""Message catalogs for the human-readable text the scoring engine produces (check details, action cards, fixes).

Single source of truth is the JSON catalog directory in ``locales/<lang>/<namespace>.json``.
English (``en``) is the default and the fallback; Turkish (``tr``) is the second supported language.
Keys are globally unique dotted strings prefixed by the namespace (``"actions.robots.title"``). Values use
``str.format`` style ``{placeholders}``. Plural forms: ``key_one`` / ``key_other`` selected by ``count=``.

    from geo_crawler.i18n import get_translator
    t = get_translator("tr")
    t("actions.robots.title", count=3)

To add a language: create ``locales/<code>/`` with the JSON namespace files matching ``locales/en/`` and run
the tests (``tests/test_i18n.py`` checks key and placeholder parity against the single source).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import string
from functools import lru_cache
from typing import Callable

DEFAULT_LANG = "en"


def get_locales_dir() -> Path:
    """Locate the shared locales directory (environment variable > repo root > package fallback)."""
    env_dir = os.environ.get("LOCALES_DIR")
    if env_dir:
        p = Path(env_dir)
        if p.is_dir():
            return p
    current = Path(__file__).resolve().parent
    for parent in [current, *current.parents]:
        cand = parent / "locales"
        if cand.is_dir() and (cand / "en").is_dir():
            return cand
    return current / "locales"


def get_supported_languages() -> tuple[str, ...]:
    locales_dir = get_locales_dir()
    if locales_dir.is_dir():
        langs = [
            d.name
            for d in locales_dir.iterdir()
            if d.is_dir() and not d.name.startswith(".") and any(d.glob("*.json"))
        ]
        if "en" in langs:
            return ("en", *sorted(l for l in langs if l != "en"))
    return ("en", "tr")


SUPPORTED_LANGS = get_supported_languages()

Translator = Callable[..., str]


def normalize_lang(value: str | None) -> str:
    """'tr-TR', 'TR', 'en_GB' → a supported code; anything else → the default (English)."""
    base = (value or "").strip().lower().replace("_", "-").split("-")[0]
    supported = get_supported_languages()
    return base if base in supported else DEFAULT_LANG


@lru_cache(maxsize=None)
def catalog(lang: str) -> dict[str, str]:
    """All messages of one language (every ``locales/<lang>/*.json`` module merged)."""
    code = normalize_lang(lang)
    locales_dir = get_locales_dir()
    target_dir = locales_dir / code
    if not target_dir.is_dir():
        target_dir = locales_dir / DEFAULT_LANG
    merged: dict[str, str] = {}
    if target_dir.is_dir():
        for json_file in sorted(target_dir.glob("*.json")):
            with open(json_file, encoding="utf-8") as f:
                data: dict[str, str] = json.load(f)
                overlap = merged.keys() & data.keys()
                if overlap:
                    raise ValueError(f"duplicate message keys in {json_file.name}: {sorted(overlap)[:5]}")
                merged.update(data)
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
