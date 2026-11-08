"""Pillar 1 — AI crawler & bot accessibility (robots.txt, WAF/UA blocking, robots directives, render mode)."""
from __future__ import annotations

import re
from typing import Any

from ..models import PageData
from ..urls import url_path
from .base import AuditContext, Check, Pillar, ratio_score
from .robots import AI_BOTS, evaluate, parse_robots_rules

_NOINDEX = re.compile(r"\b(noindex|none)\b", re.I)
_NOAI = re.compile(r"\b(noai|noimageai)\b", re.I)
_BOT_META = {b.token.lower() for b in AI_BOTS} | {"googlebot", "bingbot", "robots"}


def classify_render(p: PageData) -> tuple[str, float, str]:
    """(mode, 0-100 score, reason). Modes: static | ssr_hydrated | heavy_js | thin | csr_shell."""
    s = p.content_stats or {}
    words = p.word_count
    spa = s.get("spa_root") or {}
    hydration = s.get("hydration") or []
    script_heavy = s.get("script_tags", 0) >= 3 or s.get("inline_script_bytes", 0) > 20_000
    if words < 50 and (spa.get("empty") or script_heavy):
        root = f"#{spa['id']} kökü boş, " if spa.get("empty") else ""
        return "csr_shell", 0.0, f"{root}sunucu HTML'inde yalnızca {words} kelime var; içerik JavaScript ile yükleniyor"
    if words < 50:
        return "thin", 40.0, f"sunucu HTML'inde yalnızca {words} kelime var"
    if s.get("text_ratio", 1) < 0.02 and words < 200:
        return "heavy_js", 70.0, f"metin/HTML oranı %{s.get('text_ratio', 0) * 100:.1f}; içerik ağır JS içinde kaybolabilir"
    if hydration:
        return "ssr_hydrated", 100.0, f"SSR/SSG ({', '.join(hydration)}) — içerik ilk HTML'de mevcut"
    return "static", 100.0, "içerik ilk HTML yanıtında mevcut"


def _bot_status(ctx: AuditContext, sample_paths: list[str]) -> list[dict[str, Any]]:
    status = ctx.robots_status
    rules = parse_robots_rules(ctx.robots_txt or "")
    out = []
    for bot in AI_BOTS:
        if status is not None and status >= 500:
            out.append({"token": bot.token, "vendor": bot.vendor, "purpose": bot.purpose, "weight": bot.weight,
                        "required": bot.required, "status": "blocked", "group": None, "blocked_paths": ["/"],
                        "reason": f"robots.txt HTTP {status} döndürüyor — botlar siteyi tamamen yasaklı sayar"})
            continue
        group, group_rules = rules.group_for(bot.token)
        blocked = [p for p in sample_paths if not evaluate(group_rules, p)]
        if "/" in blocked:
            st = "blocked"
        elif blocked:
            st = "partial"
        else:
            st = "allowed"
        reason = {
            "blocked": f"robots.txt '{group}' grubu siteyi engelliyor",
            "partial": f"robots.txt '{group}' grubu {len(blocked)} önemli sayfayı engelliyor",
            "allowed": "açıkça izinli" if group == bot.token else ("varsayılan (*) kurallarla izinli" if group else "kural yok, izinli"),
        }[st]
        out.append({"token": bot.token, "vendor": bot.vendor, "purpose": bot.purpose, "weight": bot.weight,
                    "required": bot.required, "status": st, "group": group, "blocked_paths": blocked[:10],
                    "reason": reason})
    return out


def _directives(p: PageData) -> list[str]:
    found = []
    for name, content in p.meta.items():
        if name in _BOT_META:
            if _NOINDEX.search(content):
                found.append(f'<meta name="{name}" content="{content}">')
            elif _NOAI.search(content):
                found.append(f'<meta name="{name}" content="{content}">')
    xrt = p.headers.get("x-robots-tag", "")
    if xrt and (_NOINDEX.search(xrt) or _NOAI.search(xrt)):
        found.append(f"X-Robots-Tag: {xrt}")
    return found


def analyze_access(ctx: AuditContext) -> Pillar:
    pillar = Pillar("ai_access", "AI Crawler ve Bot Erişilebilirliği", 0.25)
    key_pages = ctx.key_pages
    sample_paths = ["/"] + sorted({url_path(p.url) or "/" for p in key_pages})[:40]

    # 1) robots.txt per AI bot
    bots = _bot_status(ctx, sample_paths)
    total_w = sum(b["weight"] for b in bots)
    got = sum(b["weight"] * {"allowed": 1.0, "partial": 0.6, "blocked": 0.0}[b["status"]] for b in bots)
    blocked = [b["token"] for b in bots if b["status"] == "blocked"]
    partial = [b["token"] for b in bots if b["status"] == "partial"]
    if blocked or partial:
        detail = (f"Engellenen botlar: {', '.join(blocked) or '-'}; kısmi engel: {', '.join(partial) or '-'}")
    elif ctx.robots_status is None or ctx.robots_status >= 400:
        st = f"HTTP {ctx.robots_status}" if ctx.robots_status else "erişilemedi"
        detail = f"robots.txt yok ({st}) — RFC 9309'a göre tüm botlar izinli sayılır (yine de açık kural önerilir)"
    else:
        detail = f"{len(bots)} AI botunun tamamı robots.txt tarafından izinli"
    pillar.add(Check("robots_ai_bots", "robots.txt AI bot izinleri", 100 * got / total_w, 40, detail))

    # 2) WAF / CDN user-agent blocking
    probe = (ctx.signals.ua_probe if ctx.signals else {}) or {}
    waf_blocked = [t for t, r in probe.items() if r.get("blocked")]
    general_block = bool(waf_blocked) and all(probe[t].get("general") for t in waf_blocked)
    pillar.add(Check(
        "waf_ua_block", "WAF/CDN AI bot engeli", ratio_score(len(probe) - len(waf_blocked), len(probe)), 15,
        (f"Sunucu {', '.join(f'{t} (HTTP {probe[t]['status']})' for t in waf_blocked)} isteklerini reddediyor"
         + (" (tarayıcı isteklerini de reddediyor: genel bot duvarı/IP engeli)" if general_block else "")
         + "; robots.txt izin verse bile içerik alınamaz") if waf_blocked
        else f"{len(probe)} AI user-agent ile ana sayfa başarıyla alındı",
        applicable=bool(probe)))

    # 3) noindex / noai directives on key pages
    directive_pages = {p.url: d for p in key_pages if (d := _directives(p))}
    xr = ctx.signals.homepage_x_robots if ctx.signals else ""
    pillar.add(Check(
        "robots_directives", "noindex / noai yönergeleri", ratio_score(len(key_pages) - len(directive_pages), len(key_pages)),
        10,
        (f"{len(directive_pages)} önemli sayfada AI erişimini kısıtlayan yönerge var "
         f"(örn. {next(iter(directive_pages.values()))[0]})") if directive_pages
        else "Önemli sayfalarda noindex/noai yönergesi yok" + (f" (X-Robots-Tag: {xr})" if xr else ""),
        urls=sorted(directive_pages)))

    # 4) render mode (SSR/SSG vs client-side shell)
    renders = {p.url: classify_render(p) for p in key_pages}
    csr = sorted(u for u, r in renders.items() if r[0] == "csr_shell")
    weak = sorted(u for u, r in renders.items() if r[0] in ("thin", "heavy_js"))
    render_score = sum(r[1] for r in renders.values()) / len(renders) if renders else 0.0
    if csr:
        detail = (f"{len(csr)}/{len(renders)} önemli sayfa boş JS kabuğu döndürüyor (AI botları JS çalıştırmaz): "
                  f"{renders[csr[0]][2]}")
    elif weak:
        detail = f"{len(weak)}/{len(renders)} sayfada sunucu HTML'i zayıf: {renders[weak[0]][2]}"
    elif renders:
        modes = sorted({r[0] for r in renders.values()})
        detail = f"Tüm {len(renders)} önemli sayfa içeriği sunucu tarafında üretiyor ({', '.join(modes)})"
    else:
        detail = "Hiç sayfa alınamadı — render analizi yapılamadı"
    pillar.add(Check("render_mode", "Sayfa render analizi (SSR/SSG vs CSR)", render_score, 35, detail, urls=csr + weak))

    pillar.facts = {
        "bots": bots, "blocked_bots": blocked, "partial_bots": partial, "waf_blocked": waf_blocked,
        "general_block": general_block,
        "fetch_errors": [{"url": u, "error": e} for u, e in sorted(ctx.crawl.errors.items())][:10],
        "directive_pages": directive_pages,
        "render": {u: {"mode": r[0], "score": r[1], "reason": r[2]} for u, r in renders.items()},
        "csr_pages": csr, "robots_status": ctx.robots_status, "robots_txt": ctx.robots_txt or "",
    }
    return pillar
