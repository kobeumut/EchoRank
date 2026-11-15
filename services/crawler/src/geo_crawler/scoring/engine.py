"""Audit orchestration: pillars -> overall GEO score (0-100) -> grade, summary, action cards, DB rows."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from ..crawler import CrawlConfig
from ..i18n import DEFAULT_LANG, get_translator, normalize_lang
from ..pipeline import IndexResult, index_site
from .access import analyze_access
from .actions import ActionCard, generate_actions
from .autogeo import AutoGeoSiteReport, analyze_pages
from .base import AuditContext, Pillar, grade
from .bot_simulator import BotSimulationReport, simulate_bots
from .eeat import analyze_eeat
from .readability import analyze_readability
from .seo import analyze_seo
from .signals import SiteSignals, collect_site_signals

log = logging.getLogger(__name__)

SCORING_VERSION = "1.0"
BOTSIM_MAX_PAGES = 3  # homepage + the most citable key pages


@dataclass
class AuditReport:
    site: str
    geo_score: int
    seo_score: int
    eeat_score: int
    pillars: dict[str, Pillar]
    actions: list[ActionCard]
    caps: list[str] = field(default_factory=list)
    signals: SiteSignals | None = None
    autogeo: AutoGeoSiteReport | None = None  # content-level citation readiness (does not change geo_score)
    bot_simulation: BotSimulationReport | None = None  # live AI crawler simulation (WAF / render / tokens)
    generated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    lang: str = DEFAULT_LANG  # language of the generated text (summary, check details, action cards)

    @property
    def metrics(self) -> dict[str, Any]:
        """Flat sub-scores for ``GeoAudit.metrics`` (plus the full breakdown under ``pillars``)."""
        flat: dict[str, Any] = {
            "scoringVersion": SCORING_VERSION, "grade": grade(self.geo_score),
            "aiAccess": self.pillars["ai_access"].score, "llmReadability": self.pillars["llm_readability"].score,
            "eeat": self.eeat_score, "technicalSeo": self.seo_score,
        }
        for pillar in self.pillars.values():
            for c in pillar.checks:
                if c.applicable:
                    flat[_camel(c.id)] = round(c.score)
        flat["caps"] = self.caps
        if self.bot_simulation is not None:
            flat["botSimulation"] = self.bot_simulation.summary()
        if self.autogeo is not None:
            flat["autogeo"] = {"score": self.autogeo.score, "metrics": self.autogeo.metric_means(),
                               "pageCount": len(self.autogeo.pages)}
        flat["pillars"] = {k: p.to_dict() for k, p in self.pillars.items()}
        return flat

    @property
    def summary(self) -> str:
        weakest = sorted(self.pillars.values(), key=lambda p: p.score)[0]
        high = [a for a in self.actions if a.impact == "high"]
        t = get_translator(self.lang)
        s = t("engine.summary", geo=self.geo_score, grade=grade(self.geo_score),
              ai_access=self.pillars["ai_access"].score, readability=self.pillars["llm_readability"].score,
              eeat=self.eeat_score, seo=self.seo_score, weakest=weakest.label, count=len(self.actions),
              high=len(high))
        if self.caps:
            s += t("engine.summary.caps_prefix") + "; ".join(self.caps)
        return s

    def to_dict(self) -> dict[str, Any]:
        return {
            "scoring_version": SCORING_VERSION, "site": self.site, "generated_at": self.generated_at,
            "scores": {"geo": self.geo_score, "seo": self.seo_score, "eeat": self.eeat_score,
                       "ai_access": self.pillars["ai_access"].score,
                       "llm_readability": self.pillars["llm_readability"].score, "grade": grade(self.geo_score)},
            "summary": self.summary, "caps": self.caps,
            "pillars": {k: p.to_dict() for k, p in self.pillars.items()},
            "actions": [a.to_dict() for a in self.actions],
            "facts": {k: p.facts for k, p in self.pillars.items()},
            "signals": self.signals.to_dict() if self.signals else None,
            "autogeo": self.autogeo.to_dict() if self.autogeo else None,
            "bot_simulation": self.bot_simulation.to_dict() if self.bot_simulation else None,
        }

    def to_db_records(self) -> dict[str, Any]:
        """Payload for ``POST /api/sites/:id/audit/:auditId/result`` (GeoAudit + ActionItem rows)."""
        return {
            "audit": {"status": "completed", "geoScore": self.geo_score, "seoScore": self.seo_score,
                      "eeatScore": self.eeat_score, "metrics": self.metrics, "summary": self.summary},
            "actionItems": [a.to_action_item() for a in self.actions],
            # page-level AutoGEO reports; the web app turns them into ActionItems (src/lib/services/autogeo.ts)
            **({"autogeo": self.autogeo.to_dict()} if self.autogeo else {}),
        }


def _camel(s: str) -> str:
    head, *rest = s.split("_")
    return head + "".join(w.title() for w in rest)


def score_index(index: IndexResult, signals: SiteSignals | None = None,
                bot_simulation: BotSimulationReport | None = None, *, lang: str = DEFAULT_LANG) -> AuditReport:
    """Score a crawl; ``lang`` selects the language of every human-readable text in the report."""
    lang = normalize_lang(lang)
    ctx = AuditContext(crawl=index.crawl, graph=index.graph, gaps=index.gaps, signals=signals,
                       bot_simulation=bot_simulation, lang=lang)
    t = ctx.t
    pillars = {p.key: p for p in (analyze_access(ctx), analyze_readability(ctx), analyze_eeat(ctx), analyze_seo(ctx))}
    raw = sum(p.score * p.weight for p in pillars.values()) / sum(p.weight for p in pillars.values())
    geo = round(raw)

    # Hard gates: content that AI crawlers cannot fetch cannot be cited, whatever its quality.
    caps: list[str] = []
    access = pillars["ai_access"]
    bots = access.facts["bots"]
    answer_bots = [b for b in bots if b["purpose"] in ("search", "user")]
    if answer_bots and all(b["status"] == "blocked" for b in answer_bots):
        geo = min(geo, 35)
        caps.append(t("engine.cap.answer_bots_blocked"))
    elif access.facts["waf_blocked"] and len(access.facts["waf_blocked"]) >= 3:
        geo = min(geo, 45)
        caps.append(t("engine.cap.waf_blocks"))
    render = access.check("render_mode")
    if render and render.score < 30 and ctx.pages:
        geo = min(geo, 40)
        caps.append(t("engine.cap.csr"))
    if not ctx.pages:
        geo = 0
        caps.append(t("engine.cap.no_pages"))

    actions = generate_actions(ctx, pillars)
    autogeo = analyze_pages(ctx.pages, lang=lang) if ctx.pages else None
    return AuditReport(site=index.crawl.start_url, geo_score=geo, seo_score=pillars["technical_seo"].score,
                       eeat_score=pillars["eeat"].score, pillars=pillars, actions=actions, caps=caps, signals=signals,
                       autogeo=autogeo, bot_simulation=bot_simulation, lang=lang)


async def audit_site(url: str, config: CrawlConfig | None = None, probe_user_agents: bool = True,
                     client=None, *, lang: str = DEFAULT_LANG, **crawler_kwargs) -> tuple[IndexResult, AuditReport]:
    """Crawl + graph + site signals + scoring in one call (human-readable output in ``lang``)."""
    cfg = config or CrawlConfig()
    index = await index_site(url, config, client=client, **crawler_kwargs)
    signals = await collect_site_signals(index.crawl.start_url, client=client, probe_user_agents=probe_user_agents,
                                         timeout=cfg.timeout, lang=lang)
    sim = await run_bot_simulation(index, cfg, client, lang=lang) if probe_user_agents and index.crawl.ok_pages \
        else None
    return index, score_index(index, signals, sim, lang=lang)


async def run_bot_simulation(index: IndexResult, cfg: CrawlConfig, client=None, *,
                             lang: str = DEFAULT_LANG) -> BotSimulationReport | None:
    """Live AI-bot fetches of the homepage + key pages; never fails the audit."""
    ctx = AuditContext(crawl=index.crawl, graph=index.graph, gaps=index.gaps)
    urls = [index.crawl.start_url] + [p.url for p in sorted(ctx.key_pages, key=lambda p: (p.depth, p.url))]
    rps = cfg.requests_per_second
    try:
        return await simulate_bots(list(dict.fromkeys(urls))[:BOTSIM_MAX_PAGES], client=client,
                                   robots_txt=index.crawl.robots_txt, robots_status=index.crawl.robots_status,
                                   timeout=cfg.timeout, delay=1 / rps if rps > 0 else 0, lang=lang)
    except Exception as exc:  # noqa: BLE001 — diagnostics must not break scoring
        log.warning("bot simulation failed: %s", exc)
        return None
