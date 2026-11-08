"""Shared scoring primitives: a Pillar is a weighted set of Checks, each 0-100 with a human-readable reason."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..models import CrawlResult, PageData, PageType
from ..graph import KnowledgeGraph
from .signals import SiteSignals


def clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def grade(score: float) -> str:
    return "A" if score >= 85 else "B" if score >= 70 else "C" if score >= 55 else "D" if score >= 40 else "E"


def ratio_score(part: float, whole: float, empty: float = 100.0) -> float:
    """part/whole as 0-100; ``empty`` when there is nothing to measure."""
    return empty if whole <= 0 else clamp(100.0 * part / whole)


@dataclass
class Check:
    id: str
    label: str
    score: float
    weight: float
    detail: str  # concrete reason shown in the report ("gerekçe")
    urls: list[str] = field(default_factory=list)
    applicable: bool = True  # non-applicable checks are excluded from the weighted mean

    @property
    def passed(self) -> bool:
        return self.score >= 70

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "score": round(self.score), "weight": self.weight,
                "passed": self.passed, "applicable": self.applicable, "detail": self.detail,
                "urls": self.urls[:20], "url_count": len(self.urls)}


@dataclass
class Pillar:
    key: str
    label: str
    weight: float
    checks: list[Check] = field(default_factory=list)
    facts: dict[str, Any] = field(default_factory=dict)  # raw inputs reused by the action engine

    def add(self, check: Check) -> Check:
        self.checks.append(check)
        return check

    def check(self, check_id: str) -> Check | None:
        return next((c for c in self.checks if c.id == check_id), None)

    @property
    def score(self) -> int:
        active = [c for c in self.checks if c.applicable and c.weight > 0]
        total = sum(c.weight for c in active)
        return round(sum(c.score * c.weight for c in active) / total) if total else 0

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key, "label": self.label, "score": self.score, "weight": self.weight,
                "checks": [c.to_dict() for c in self.checks]}


@dataclass
class AuditContext:
    """Everything the analyzers read. Built once per audit."""

    crawl: CrawlResult
    graph: KnowledgeGraph
    gaps: dict[str, Any]
    signals: SiteSignals | None = None
    bot_simulation: Any = None  # BotSimulationReport (live AI crawler simulation), when it ran

    @property
    def pages(self) -> list[PageData]:
        return self.crawl.ok_pages

    @property
    def origin(self) -> str:
        return self.crawl.start_url.rstrip("/")

    def pages_of(self, *types: PageType) -> list[PageData]:
        return [p for p in self.pages if p.page_type in types]

    @property
    def key_pages(self) -> list[PageData]:
        """Pages that answer engines are most likely to cite."""
        return self.pages_of(PageType.HOME, PageType.PRODUCT, PageType.SERVICE, PageType.ARTICLE,
                             PageType.FAQ, PageType.CATEGORY) or self.pages

    @property
    def robots_txt(self) -> str:
        if self.signals and self.signals.robots_txt is not None:
            return self.signals.robots_txt
        return self.crawl.robots_txt

    @property
    def robots_status(self) -> int | None:
        if self.signals and self.signals.robots_txt is not None:
            return self.signals.robots_status
        return self.crawl.robots_status
