"""GEO / SEO / E-E-A-T scoring and "Ne Yapılmalı?" action engine.

    index = await index_site(url)                       # crawl + knowledge graph (stage 1)
    signals = await collect_site_signals(url)           # llms.txt, HTTPS/HSTS, AI user-agent probes
    report = score_index(index, signals)                # 0-100 scores + action cards
    report.to_db_records()                              # GeoAudit + ActionItem rows
"""
from .actions import ActionCard, Snippet, generate_actions
from .base import AuditContext, Check, Pillar
from .engine import SCORING_VERSION, AuditReport, audit_site, grade, score_index
from .robots import AI_BOTS, parse_robots_rules
from .signals import SiteSignals, collect_site_signals, validate_llms_txt

__all__ = [
    "ActionCard", "Snippet", "generate_actions", "AuditContext", "Check", "Pillar", "SCORING_VERSION",
    "AuditReport", "audit_site", "grade", "score_index", "AI_BOTS", "parse_robots_rules", "SiteSignals",
    "collect_site_signals", "validate_llms_txt",
]
