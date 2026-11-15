"""Pillar 1 — AI crawler & bot accessibility (robots.txt, WAF/UA blocking, robots directives, render mode)."""
from __future__ import annotations

import re
from typing import Any

from ..i18n import DEFAULT_LANG, get_translator
from ..models import PageData
from ..urls import url_path
from .base import AuditContext, Check, Pillar, ratio_score
from .robots import AI_BOTS, evaluate, parse_robots_rules

_NOINDEX = re.compile(r"\b(noindex|none)\b", re.I)
_NOAI = re.compile(r"\b(noai|noimageai)\b", re.I)
_BOT_META = {b.token.lower() for b in AI_BOTS} | {"googlebot", "bingbot", "robots"}


def classify_render(p: PageData, *, lang: str = DEFAULT_LANG) -> tuple[str, float, str]:
    """(mode, 0-100 score, reason). Modes: static | ssr_hydrated | heavy_js | thin | csr_shell."""
    t = get_translator(lang)
    s = p.content_stats or {}
    words = p.word_count
    spa = s.get("spa_root") or {}
    hydration = s.get("hydration") or []
    script_heavy = s.get("script_tags", 0) >= 3 or s.get("inline_script_bytes", 0) > 20_000
    if words < 50 and (spa.get("empty") or script_heavy):
        if spa.get("empty"):
            return "csr_shell", 0.0, t("access.render.csr_shell_root", id=spa["id"], count=words)
        return "csr_shell", 0.0, t("access.render.csr_shell", count=words)
    if words < 50:
        return "thin", 40.0, t("access.render.thin", count=words)
    if s.get("text_ratio", 1) < 0.02 and words < 200:
        return "heavy_js", 70.0, t("access.render.heavy_js", ratio=f"{s.get('text_ratio', 0) * 100:.1f}")
    if hydration:
        return "ssr_hydrated", 100.0, t("access.render.ssr_hydrated", frameworks=", ".join(hydration))
    return "static", 100.0, t("access.render.static")


def _bot_status(ctx: AuditContext, sample_paths: list[str]) -> list[dict[str, Any]]:
    t = ctx.t
    status = ctx.robots_status
    rules = parse_robots_rules(ctx.robots_txt or "")
    out = []
    for bot in AI_BOTS:
        if status is not None and status >= 500:
            out.append({"token": bot.token, "vendor": bot.vendor, "purpose": bot.purpose, "weight": bot.weight,
                        "required": bot.required, "status": "blocked", "group": None, "blocked_paths": ["/"],
                        "reason": t("access.bot.reason.http_error", status=status)})
            continue
        group, group_rules = rules.group_for(bot.token)
        blocked = [p for p in sample_paths if not evaluate(group_rules, p)]
        if "/" in blocked:
            st = "blocked"
        elif blocked:
            st = "partial"
        else:
            st = "allowed"
        if st == "blocked":
            reason = t("access.bot.reason.blocked", group=group)
        elif st == "partial":
            reason = t("access.bot.reason.partial", group=group, count=len(blocked))
        elif group == bot.token:
            reason = t("access.bot.reason.allowed_explicit")
        else:
            reason = t("access.bot.reason.allowed_default" if group else "access.bot.reason.allowed_no_rule")
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
    t = ctx.t
    pillar = Pillar("ai_access", t("access.pillar.label"), 0.25)
    key_pages = ctx.key_pages
    sample_paths = ["/"] + sorted({url_path(p.url) or "/" for p in key_pages})[:40]

    # 1) robots.txt per AI bot
    bots = _bot_status(ctx, sample_paths)
    total_w = sum(b["weight"] for b in bots)
    got = sum(b["weight"] * {"allowed": 1.0, "partial": 0.6, "blocked": 0.0}[b["status"]] for b in bots)
    blocked = [b["token"] for b in bots if b["status"] == "blocked"]
    partial = [b["token"] for b in bots if b["status"] == "partial"]
    if blocked or partial:
        detail = t("access.check.robots_ai_bots.detail_blocked", blocked=", ".join(blocked) or "-",
                   partial=", ".join(partial) or "-")
    elif ctx.robots_status is None or ctx.robots_status >= 400:
        st = f"HTTP {ctx.robots_status}" if ctx.robots_status else t("access.check.robots_ai_bots.unreachable")
        detail = t("access.check.robots_ai_bots.detail_missing", status=st)
    else:
        detail = t("access.check.robots_ai_bots.detail_allowed", count=len(bots))
    pillar.add(Check("robots_ai_bots", t("access.check.robots_ai_bots.label"), 100 * got / total_w, 40, detail))

    # 2) WAF / CDN user-agent blocking
    probe = (ctx.signals.ua_probe if ctx.signals else {}) or {}
    waf_blocked = [tok for tok, r in probe.items() if r.get("blocked")]
    general_block = bool(waf_blocked) and all(probe[tok].get("general") for tok in waf_blocked)
    if waf_blocked:
        waf_detail = t("access.check.waf_ua_block.detail_blocked",
                       bots=", ".join(f"{tok} (HTTP {probe[tok]['status']})" for tok in waf_blocked),
                       general=t("access.check.waf_ua_block.general_suffix") if general_block else "")
    else:
        waf_detail = t("access.check.waf_ua_block.detail_ok", count=len(probe))
    pillar.add(Check("waf_ua_block", t("access.check.waf_ua_block.label"),
                     ratio_score(len(probe) - len(waf_blocked), len(probe)), 15, waf_detail, applicable=bool(probe)))

    # 3) noindex / noai directives on key pages
    directive_pages = {p.url: d for p in key_pages if (d := _directives(p))}
    xr = ctx.signals.homepage_x_robots if ctx.signals else ""
    if directive_pages:
        dir_detail = t("access.check.robots_directives.detail_found", count=len(directive_pages),
                       example=next(iter(directive_pages.values()))[0])
    else:
        dir_detail = t("access.check.robots_directives.detail_none") + (f" (X-Robots-Tag: {xr})" if xr else "")
    pillar.add(Check("robots_directives", t("access.check.robots_directives.label"),
                     ratio_score(len(key_pages) - len(directive_pages), len(key_pages)), 10, dir_detail,
                     urls=sorted(directive_pages)))

    # 4) render mode (SSR/SSG vs client-side shell)
    renders = {p.url: classify_render(p, lang=ctx.lang) for p in key_pages}
    csr = sorted(u for u, r in renders.items() if r[0] == "csr_shell")
    weak = sorted(u for u, r in renders.items() if r[0] in ("thin", "heavy_js"))
    render_score = sum(r[1] for r in renders.values()) / len(renders) if renders else 0.0
    if csr:
        detail = t("access.check.render_mode.detail_csr", csr=len(csr), total=len(renders),
                   reason=renders[csr[0]][2])
    elif weak:
        detail = t("access.check.render_mode.detail_weak", weak=len(weak), total=len(renders),
                   reason=renders[weak[0]][2])
    elif renders:
        modes = sorted({r[0] for r in renders.values()})
        detail = t("access.check.render_mode.detail_ok", total=len(renders), modes=", ".join(modes))
    else:
        detail = t("access.check.render_mode.detail_none")
    pillar.add(Check("render_mode", t("access.check.render_mode.label"), render_score, 35, detail, urls=csr + weak))

    pillar.facts = {
        "bots": bots, "blocked_bots": blocked, "partial_bots": partial, "waf_blocked": waf_blocked,
        "general_block": general_block,
        "fetch_errors": [{"url": u, "error": e} for u, e in sorted(ctx.crawl.errors.items())][:10],
        "directive_pages": directive_pages,
        "render": {u: {"mode": r[0], "score": r[1], "reason": r[2]} for u, r in renders.items()},
        "csr_pages": csr, "robots_status": ctx.robots_status, "robots_txt": ctx.robots_txt or "",
    }
    return pillar
