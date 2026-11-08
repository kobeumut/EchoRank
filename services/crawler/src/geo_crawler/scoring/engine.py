"""Audit orchestration: pillars -> overall GEO score (0-100) -> grade, summary, action cards, DB rows."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from ..crawler import CrawlConfig
from ..pipeline import IndexResult, index_site
from .access import analyze_access
from .actions import ActionCard, generate_actions
from .autogeo import AutoGeoSiteReport, analyze_pages
from .base import AuditContext, Pillar
from .eeat import analyze_eeat
from .readability import analyze_readability
from .seo import analyze_seo
from .signals import SiteSignals, collect_site_signals

SCORING_VERSION = "1.0"


def grade(score: int) -> str:
    return "A" if score >= 85 else "B" if score >= 70 else "C" if score >= 55 else "D" if score >= 40 else "E"


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
    generated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

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
        if self.autogeo is not None:
            flat["autogeo"] = {"score": self.autogeo.score, "metrics": self.autogeo.metric_means(),
                               "pageCount": len(self.autogeo.pages)}
        flat["pillars"] = {k: p.to_dict() for k, p in self.pillars.items()}
        return flat

    @property
    def summary(self) -> str:
        weakest = sorted(self.pillars.values(), key=lambda p: p.score)[0]
        high = [a for a in self.actions if a.impact == "high"]
        s = (f"GEO skoru {self.geo_score}/100 ({grade(self.geo_score)}). AI erişim "
             f"{self.pillars['ai_access'].score}, LLM okunabilirlik {self.pillars['llm_readability'].score}, "
             f"E-E-A-T {self.eeat_score}, teknik SEO {self.seo_score}. En zayıf alan: {weakest.label}. "
             f"{len(self.actions)} aksiyon önerisi ({len(high)} yüksek etkili).")
        if self.caps:
            s += " Skor sınırlandı: " + "; ".join(self.caps)
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


def score_index(index: IndexResult, signals: SiteSignals | None = None) -> AuditReport:
    ctx = AuditContext(crawl=index.crawl, graph=index.graph, gaps=index.gaps, signals=signals)
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
        caps.append("tüm AI arama/cevap botları robots.txt ile engelli (üst sınır 35)")
    elif access.facts["waf_blocked"] and len(access.facts["waf_blocked"]) >= 3:
        geo = min(geo, 45)
        caps.append("WAF/CDN AI botlarını engelliyor (üst sınır 45)")
    render = access.check("render_mode")
    if render and render.score < 30 and ctx.pages:
        geo = min(geo, 40)
        caps.append("önemli sayfalar istemci tarafında (CSR) render ediliyor (üst sınır 40)")
    if not ctx.pages:
        geo = 0
        caps.append("hiç sayfa alınamadı")

    actions = generate_actions(ctx, pillars)
    autogeo = analyze_pages(ctx.pages) if ctx.pages else None
    return AuditReport(site=index.crawl.start_url, geo_score=geo, seo_score=pillars["technical_seo"].score,
                       eeat_score=pillars["eeat"].score, pillars=pillars, actions=actions, caps=caps, signals=signals,
                       autogeo=autogeo)


async def audit_site(url: str, config: CrawlConfig | None = None, probe_user_agents: bool = True,
                     client=None, **crawler_kwargs) -> tuple[IndexResult, AuditReport]:
    """Crawl + graph + site signals + scoring in one call."""
    index = await index_site(url, config, client=client, **crawler_kwargs)
    signals = await collect_site_signals(index.crawl.start_url, client=client, probe_user_agents=probe_user_agents,
                                         timeout=(config or CrawlConfig()).timeout)
    return index, score_index(index, signals)
