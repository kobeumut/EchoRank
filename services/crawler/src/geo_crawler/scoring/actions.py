"""The "What should be done?" action engine — turns failed checks into prioritized action cards with copy-paste fixes.

Each rule inspects pillar facts and emits zero or more ``ActionCard``s. Impact is derived from the
estimated GEO-score gain of fixing the underlying check (never lower than the rule's base impact);
priority = impact × reach / effort.

All human-readable text (titles, descriptions, evidence, snippet instructions) comes from the ``actions`` message
catalog in the language of ``ctx.lang``; ``rule_id``, ``category``, ``impact`` and ``effort`` are language-neutral.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Callable
from urllib.parse import urlsplit

from ..models import PageType
from . import snippets as sn
from .base import AuditContext, Pillar

IMPACT_W = {"high": 3, "medium": 2, "low": 1}
EFFORT_W = {"low": 1, "medium": 2, "high": 3}


@dataclass
class Snippet:
    language: str  # robots | markdown | html | json-ld | nginx | tsx | text
    code: str
    filename: str | None = None
    instructions: str = ""


@dataclass
class ActionCard:
    rule_id: str
    title: str
    description: str
    category: str  # crawler | schema | content | authority | technical (ActionItem.category)
    impact: str
    effort: str
    check_id: str
    evidence: list[str] = field(default_factory=list)
    target_url: str | None = None
    affected_urls: list[str] = field(default_factory=list)
    snippet: Snippet | None = None
    expected_gain: float = 0.0  # estimated overall GEO points
    priority: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["affected_urls"] = self.affected_urls[:50]
        d["affected_count"] = len(self.affected_urls)
        return d

    def to_action_item(self) -> dict[str, Any]:
        """Row shaped for the Prisma ``ActionItem`` model (extra data lives in ``details``)."""
        return {
            "title": self.title, "description": self.description, "category": self.category,
            "impact": self.impact, "effort": self.effort, "ruleId": self.rule_id, "priority": round(self.priority, 2),
            "targetUrl": self.target_url,
            "details": {"check_id": self.check_id, "evidence": self.evidence, "expected_gain": self.expected_gain,
                        "affected_urls": self.affected_urls[:50], "affected_count": len(self.affected_urls),
                        "snippet": asdict(self.snippet) if self.snippet else None},
        }


class Rules:
    def __init__(self, ctx: AuditContext, pillars: dict[str, Pillar]):
        self.ctx = ctx
        self.t = ctx.t
        self.p = pillars
        self.cards: list[ActionCard] = []

    def gain(self, pillar_key: str, check_id: str, fix_fraction: float = 1.0) -> float:
        pillar = self.p[pillar_key]
        c = pillar.check(check_id)
        if not c or not c.applicable:
            return 0.0
        total = sum(x.weight for x in pillar.checks if x.applicable and x.weight > 0) or 1
        return round(pillar.weight * c.weight / total * (100 - c.score) * fix_fraction, 2)

    def emit(self, pillar_key: str, check_id: str, *, base_impact: str, effort: str, fix_fraction: float = 1.0,
             blocker: bool = False, **kw: Any) -> ActionCard:
        """``blocker``: the defect caps the overall GEO score — always ranked first, whatever the effort."""
        g = self.gain(pillar_key, check_id, fix_fraction)
        impact = "high" if g >= 4 else "medium" if g >= 1.5 else "low"
        if IMPACT_W[base_impact] > IMPACT_W[impact]:
            impact = base_impact
        urls = kw.get("affected_urls") or []
        reach = 1 + min(len(urls), 50) / 50
        priority = (IMPACT_W[impact] * 10 + 2 * g) * reach / EFFORT_W[effort] ** 0.7
        if blocker:
            impact, priority = "high", priority + 100
        card = ActionCard(check_id=check_id, impact=impact, effort=effort, expected_gain=g,
                          priority=round(priority, 2), **kw)
        if not card.target_url and urls:
            card.target_url = urls[0]
        c = self.p[pillar_key].check(check_id)
        if c and c.detail not in card.evidence:
            card.evidence.insert(0, c.detail)
        self.cards.append(card)
        return card

    def failing(self, pillar_key: str, check_id: str, threshold: float = 90) -> bool:
        c = self.p[pillar_key].check(check_id)
        return bool(c and c.applicable and c.score < threshold)


Rule = Callable[[Rules], None]
RULES: list[Rule] = []


def rule(fn: Rule) -> Rule:
    RULES.append(fn)
    return fn


# ---------------- crawler / access ----------------

@rule
def site_unreachable(r: Rules) -> None:
    if r.ctx.pages:
        return
    f = r.p["ai_access"].facts
    errors = f.get("fetch_errors") or []
    t = r.t
    r.emit("ai_access", "render_mode", base_impact="high", effort="medium", category="crawler", blocker=True,
           rule_id="crawler.site_unreachable", title=t("actions.rule.site_unreachable.title"),
           description=t("actions.rule.site_unreachable.description"),
           target_url=r.ctx.origin + "/", evidence=[f"{e['url']}: {e['error']}" for e in errors[:5]],
           snippet=Snippet("text", sn.waf_fix(lang=r.ctx.lang), None, t("actions.rule.site_unreachable.instructions")))

@rule
def ai_bots_blocked(r: Rules) -> None:
    f = r.p["ai_access"].facts
    bad = [b for b in f["bots"] if b["status"] != "allowed"]
    if not bad:
        return
    t = r.t
    if f.get("robots_status") and f["robots_status"] >= 500:
        desc = t("actions.rule.ai_bots.desc_http_error", status=f["robots_status"])
    else:
        search = [b["token"] for b in bad if b["purpose"] in ("search", "user")]
        parts = [t("actions.rule.ai_bots.desc_base")]
        if search:
            parts.append(t("actions.rule.ai_bots.desc_search", bots=", ".join(search)))
        parts.append(t("actions.rule.ai_bots.desc_training"))
        desc = " ".join(parts)
    answer_bots = [b for b in f["bots"] if b["purpose"] in ("search", "user")]
    r.emit("ai_access", "robots_ai_bots", base_impact="high", effort="low", category="crawler",
           blocker=bool(answer_bots) and all(b["status"] == "blocked" for b in answer_bots),
           rule_id="crawler.robots_ai_bots",
           title=t("actions.rule.ai_bots.title", count=len(bad)), description=desc,
           evidence=[f"{b['token']} ({b['vendor']}): {b['reason']}" for b in bad],
           affected_urls=sorted({p for b in bad for p in b["blocked_paths"]}),
           target_url=r.ctx.origin + "/robots.txt",
           snippet=Snippet("robots", sn.robots_txt_fix(r.ctx, [b["token"] for b in bad]), "robots.txt",
                           t("actions.rule.ai_bots.instructions")))


_SIM_ACCESS_FIXES = ("cloudflare_waf_skip", "nginx_allow", "apache_allow", "aws_waf_allow")


def _sim_blocks(r: Rules) -> list[Any]:
    """Live-simulation results where an AI bot was refused / challenged (empty without a simulation)."""
    sim = r.ctx.bot_simulation
    if sim is None:
        return []
    return [res for p in sim.pages for res in p.results
            if res.outcome in ("blocked", "challenge", "rate_limited", "error")]


@rule
def waf_blocks_ai(r: Rules) -> None:
    f = r.p["ai_access"].facts
    sim_blocked = _sim_blocks(r)
    if not f["waf_blocked"] and not sim_blocked:
        return
    t = r.t
    snippet = Snippet("text", sn.waf_fix(lang=r.ctx.lang), None, t("actions.rule.waf.instructions"))
    evidence: list[str] = []
    if sim_blocked:
        sim = r.ctx.bot_simulation
        evidence = list(dict.fromkeys(f"{res.token} → {res.url}: {res.reason}" for res in sim_blocked))[:8]
        fixes = sorted((x for x in sim.fixes if x["id"] in _SIM_ACCESS_FIXES or x["id"].endswith("_console")),
                       key=lambda x: not x["recommended"])
        if fixes:
            snippet = Snippet("text", "\n\n".join(f"### {x['title']}\n{x['code']}" for x in fixes), None,
                              " ".join([t("actions.rule.waf.instructions_simulated"), *sim.caveats[:1]]))
    blocked = set(f["waf_blocked"]) | {res.token for res in sim_blocked}
    r.emit("ai_access", "waf_ua_block", base_impact="high", effort="medium", category="crawler",
           blocker=len(blocked) >= 3,
           rule_id="crawler.waf_ua_block", title=t("actions.rule.waf.title"),
           description=t("actions.rule.waf.description"),
           target_url=r.ctx.origin + "/", evidence=evidence,
           affected_urls=sorted({res.url for res in sim_blocked}), snippet=snippet)


@rule
def bot_content_parity(r: Rules) -> None:
    sim = r.ctx.bot_simulation
    finding = next((x for x in sim.findings if x.code == "content_parity"), None) if sim else None
    if not finding:
        return
    r.emit("ai_access", "bot_simulation", base_impact="medium", effort="medium", category="crawler",
           rule_id="crawler.bot_content_parity", title=r.t("actions.rule.content_parity.title"),
           description=r.t("actions.rule.content_parity.description"),
           affected_urls=finding.urls, evidence=[finding.detail])


@rule
def ai_token_bloat(r: Rules) -> None:
    sim = r.ctx.bot_simulation
    found = [x for x in sim.findings if x.code in ("token_bloat", "large_html")] if sim else []
    if not found:
        return
    fix = next((x for x in sim.fixes if x["id"] == "token_diet"), None)
    urls = sorted({u for x in found for u in x.urls})
    view = next((p.ai_view for p in sim.pages if p.url in urls and p.ai_view), None)
    tokens = view["tokens"] if view else {}
    t = r.t
    r.emit("ai_access", "bot_simulation", base_impact="low", effort="medium", category="technical",
           rule_id="technical.ai_token_bloat", title=t("actions.rule.token_bloat.title", count=len(urls)),
           description=(t("actions.rule.token_bloat.description") + (
               t("actions.rule.token_bloat.example", html_tokens=tokens.get("html_tokens"),
                 text_tokens=tokens.get("text_tokens")) if tokens else "")),
           affected_urls=urls, evidence=[x.detail for x in found],
           snippet=Snippet("text", fix["code"], None, fix["instructions"]) if fix else None)


@rule
def restrictive_directives(r: Rules) -> None:
    f = r.p["ai_access"].facts
    if not f["directive_pages"]:
        return
    examples = [d for ds in f["directive_pages"].values() for d in ds]
    r.emit("ai_access", "robots_directives", base_impact="high", effort="low", category="crawler",
           rule_id="crawler.noindex_noai", title=r.t("actions.rule.directives.title"),
           description=r.t("actions.rule.directives.description"),
           affected_urls=sorted(f["directive_pages"]), evidence=examples[:5],
           snippet=Snippet("html", sn.directive_fix(examples, lang=r.ctx.lang)))


@rule
def client_side_rendering(r: Rules) -> None:
    f = r.p["ai_access"].facts
    weak = [u for u, v in f["render"].items() if v["mode"] in ("csr_shell", "thin", "heavy_js")]
    if not weak:
        return
    csr = f["csr_pages"]
    render = r.p["ai_access"].check("render_mode")
    r.emit("ai_access", "render_mode", base_impact="high" if csr else "medium", effort="high", category="technical",
           blocker=bool(render and render.score < 30),
           rule_id="technical.server_side_rendering",
           title=r.t("actions.rule.ssr.title", count=len(weak)),
           description=r.t("actions.rule.ssr.description"),
           affected_urls=weak, evidence=[f"{u}: {f['render'][u]['reason']}" for u in weak[:5]],
           snippet=Snippet("tsx", sn.ssr_fix(weak[0], lang=r.ctx.lang), "app/[slug]/page.tsx"))


# ---------------- readability / schema ----------------

@rule
def missing_llms_txt(r: Rules) -> None:
    if not r.failing("llm_readability", "llms_txt", 85):
        return
    lt = r.p["llm_readability"].facts.get("llms_txt") or {}
    exists = lt.get("status") == 200
    t = r.t
    r.emit("llm_readability", "llms_txt", base_impact="medium", effort="low", category="technical",
           rule_id="technical.llms_txt",
           title=t("actions.rule.llms_txt.title_fix" if exists else "actions.rule.llms_txt.title_create"),
           description=t("actions.rule.llms_txt.description"),
           target_url=r.ctx.origin + "/llms.txt", evidence=lt.get("issues") or [],
           snippet=Snippet("markdown", sn.llms_txt(r.ctx), "llms.txt", t("actions.rule.llms_txt.instructions")))


@rule
def faq_schema_missing(r: Rules) -> None:
    f = r.p["llm_readability"].facts
    t = r.t
    for url in f["faq_schema_missing"][:3]:
        pairs = f["qa_by_page"].get(url, [])
        r.emit("llm_readability", "schema_coverage", base_impact="medium", effort="low", category="schema",
               fix_fraction=0.2, rule_id="schema.faq_page",
               title=t("actions.rule.faq_schema.title"),
               description=t("actions.rule.faq_schema.description", count=len(pairs)),
               target_url=url, affected_urls=[url],
               evidence=[t("actions.rule.faq_schema.evidence_question", question=q["question"]) for q in pairs[:3]],
               snippet=Snippet("json-ld", sn.faq_jsonld(pairs), None, t("actions.rule.faq_schema.instructions")))


@rule
def no_direct_answers(r: Rules) -> None:
    if not r.failing("llm_readability", "direct_answers", 70):
        return
    f = r.p["llm_readability"].facts
    targets = [p for p in r.ctx.key_pages if p.url in set(f["pages_without_qa"])
               and p.page_type in (PageType.PRODUCT, PageType.SERVICE, PageType.ARTICLE, PageType.CATEGORY)] \
        or [p for p in r.ctx.key_pages if p.url in set(f["pages_without_qa"])]
    if not targets:
        return
    r.emit("llm_readability", "direct_answers", base_impact="high", effort="medium", category="content",
           rule_id="content.direct_answers", title=r.t("actions.rule.direct_answers.title"),
           description=r.t("actions.rule.direct_answers.description"),
           affected_urls=[p.url for p in targets],
           snippet=Snippet("html", sn.qa_block_template(targets[0], lang=r.ctx.lang)))


@rule
def organization_schema(r: Rules) -> None:
    rf = r.p["llm_readability"].facts
    ef = r.p["eeat"].facts
    if rf["has_organization_schema"] and len(ef["same_as"]) >= 2 and ef["has_logo"]:
        return
    t = r.t
    missing = []
    if not rf["has_organization_schema"]:
        missing.append(t("actions.rule.organization.missing_schema"))
    if len(ef["same_as"]) < 2:
        missing.append(t("actions.rule.organization.missing_same_as", count=len(ef["same_as"])))
    if not ef["has_logo"]:
        missing.append(t("actions.rule.organization.missing_logo"))
    r.emit("eeat", "authoritativeness", base_impact="high" if not rf["has_organization_schema"] else "medium",
           effort="low", category="schema", rule_id="schema.organization", fix_fraction=0.5,
           title=t("actions.rule.organization.title_add" if not rf["has_organization_schema"]
                   else "actions.rule.organization.title_complete"),
           description=t("actions.rule.organization.description"),
           target_url=r.ctx.origin + "/", evidence=missing,
           snippet=Snippet("json-ld", sn.organization_jsonld(r.ctx, ef["same_as"], ef["contact"]), None,
                           t("actions.rule.organization.instructions")))


def _pages_missing_family(r: Rules, page_type: PageType, family: str) -> list:
    fams = r.p["llm_readability"].facts["families_by_page"]
    return [p for p in r.ctx.pages_of(page_type) if family not in fams.get(p.url, [])]


@rule
def product_schema(r: Rules) -> None:
    missing = _pages_missing_family(r, PageType.PRODUCT, "Product")
    incomplete = [v for v in r.p["llm_readability"].facts["validations"]
                  if v["family"] == "Product" and (v["missing_required"] or v["errors"] or len(v["missing_recommended"]) > 3)]
    t = r.t
    if missing:
        r.emit("llm_readability", "schema_coverage", base_impact="high", effort="low", category="schema",
               fix_fraction=0.4, rule_id="schema.product",
               title=t("actions.rule.product_schema.title", count=len(missing)),
               description=t("actions.rule.product_schema.description"),
               affected_urls=[p.url for p in missing],
               snippet=Snippet("json-ld", sn.product_jsonld(r.ctx, missing[0]), None,
                               t("actions.rule.product_schema.instructions")))
    if incomplete:
        v = incomplete[0]
        page = next((p for p in r.ctx.pages if p.url == v["url"]), None)
        r.emit("llm_readability", "schema_validity", base_impact="medium", effort="low", category="schema",
               fix_fraction=0.5, rule_id="schema.product_incomplete",
               title=t("actions.rule.product_incomplete.title", count=len(incomplete)),
               description=t("actions.rule.product_incomplete.description"),
               affected_urls=[x["url"] for x in incomplete],
               evidence=[t("actions.rule.product_incomplete.evidence_missing", url=x["url"],
                           fields=", ".join(x["missing_required"] + x["missing_recommended"][:4]))
                         + (t("actions.rule.product_incomplete.evidence_errors", errors="; ".join(x["errors"]))
                            if x["errors"] else "") for x in incomplete[:5]],
               snippet=Snippet("json-ld", sn.product_jsonld(r.ctx, page), None) if page else None)


@rule
def article_schema_author(r: Rules) -> None:
    ef = r.p["eeat"].facts
    no_schema = _pages_missing_family(r, PageType.ARTICLE, "Article")
    targets = sorted(set(ef["articles_without_author"]) | {p.url for p in no_schema})
    if not targets:
        return
    page = next(p for p in r.ctx.pages if p.url == targets[0])
    t = r.t
    r.emit("eeat", "experience_expertise", base_impact="high", effort="medium", category="authority",
           rule_id="authority.article_author",
           title=t("actions.rule.article_author.title", count=len(targets)),
           description=t("actions.rule.article_author.description"),
           affected_urls=targets,
           evidence=[t("actions.rule.article_author.evidence_no_author", url=u)
                     for u in ef["articles_without_author"][:3]]
           + [t("actions.rule.article_author.evidence_no_schema", url=p.url) for p in no_schema[:3]],
           snippet=Snippet("json-ld", sn.article_jsonld(r.ctx, page)))


@rule
def breadcrumbs(r: Rules) -> None:
    missing = r.p["llm_readability"].facts["breadcrumb_missing"]
    if not missing:
        return
    page = next(p for p in r.ctx.pages if p.url == missing[0])
    r.emit("llm_readability", "schema_coverage", base_impact="medium", effort="low", category="schema",
           fix_fraction=0.2, rule_id="schema.breadcrumb",
           title=r.t("actions.rule.breadcrumb.title", count=len(missing)),
           description=r.t("actions.rule.breadcrumb.description"),
           affected_urls=missing, snippet=Snippet("json-ld", sn.breadcrumb_jsonld(r.ctx, page)))


@rule
def low_density(r: Rules) -> None:
    f = r.p["llm_readability"].facts
    low = f["low_density_pages"]
    if not low or not r.failing("llm_readability", "information_density", 75):
        return
    page = next(p for p in r.ctx.pages if p.url == low[0])
    d = f["density"][low[0]]
    t = r.t
    r.emit("llm_readability", "information_density", base_impact="medium", effort="medium", category="content",
           rule_id="content.information_density", title=t("actions.rule.low_density.title", count=len(low)),
           description=t("actions.rule.low_density.description"),
           affected_urls=low,
           evidence=[t("actions.rule.low_density.evidence", url=low[0], words=d["words"], tables=d["tables"],
                       lists=d["lists"], numbers=d["numbers_per_100w"], paragraph=d["avg_paragraph_words"])],
           snippet=Snippet("html", sn.density_template(page, lang=r.ctx.lang)))


# ---------------- E-E-A-T / trust ----------------

@rule
def policy_pages(r: Rules) -> None:
    f = r.p["eeat"].facts
    if not f["missing_policies"]:
        return
    t = r.t
    titles = [sn.policy_info(t, k)[0] for k in f["missing_policies"]]
    r.emit("eeat", "trust", base_impact="high" if f["is_ecommerce"] else "medium", effort="medium",
           category="authority", rule_id="authority.policy_pages", fix_fraction=0.3,
           title=t("actions.rule.policy_pages.title", pages=", ".join(titles)),
           description=t("actions.rule.policy_pages.description"),
           target_url=r.ctx.origin + "/",
           evidence=[t("actions.rule.policy_pages.evidence_missing", title=title) for title in titles],
           snippet=Snippet("html", sn.policy_pages_fix(r.ctx, f["missing_policies"])))


@rule
def contact_info(r: Rules) -> None:
    f = r.p["eeat"].facts
    c = f["contact"]
    t = r.t
    missing = [t(f"actions.rule.contact.kind_{k}") for k in ("phones", "emails", "addresses") if not c[k]]
    if not missing and f["contact_pages"]:
        return
    r.emit("eeat", "trust", base_impact="medium", effort="low", category="authority", rule_id="authority.contact_info",
           fix_fraction=0.25, title=t("actions.rule.contact.title"),
           description=t("actions.rule.contact.description"),
           target_url=(f["contact_pages"] or [r.ctx.origin + "/"])[0],
           evidence=[t("actions.rule.contact.evidence_missing", items=", ".join(missing))]
           + ([] if f["contact_pages"] else [t("actions.rule.contact.evidence_no_page")]),
           snippet=Snippet("html", sn.contact_fix(r.ctx, c)))


@rule
def https_hsts(r: Rules) -> None:
    f = r.p["eeat"].facts
    if f["https"] and f["hsts"] and f.get("http_redirects_to_https") is not False:
        return
    t = r.t
    issues = ([] if f["https"] else [t("actions.rule.https.issue_not_https")]) + \
             ([] if f["hsts"] else [t("actions.rule.https.issue_no_hsts")]) + \
             ([t("actions.rule.https.issue_no_redirect")] if f.get("http_redirects_to_https") is False else [])
    r.emit("eeat", "trust", base_impact="high" if not f["https"] else "low", effort="low", category="technical",
           rule_id="technical.https_hsts", fix_fraction=0.25,
           title=t("actions.rule.https.title_enforce" if not f["https"] else "actions.rule.https.title_hsts"),
           description=t("actions.rule.https.description"),
           target_url=r.ctx.origin + "/", evidence=issues,
           snippet=Snippet("nginx", sn.hsts_fix(r.ctx.origin, lang=r.ctx.lang)))


@rule
def unsourced_claims(r: Rules) -> None:
    f = r.p["eeat"].facts
    pages = f["unsourced_claim_pages"]
    if not pages:
        return
    examples = [c for u in pages for c in f["claim_examples"].get(u, [])]
    r.emit("eeat", "factual_consistency", base_impact="medium", effort="medium", category="content",
           rule_id="content.cite_sources", fix_fraction=0.5,
           title=r.t("actions.rule.unsourced.title", count=len(pages)),
           description=r.t("actions.rule.unsourced.description"),
           affected_urls=pages,
           evidence=[r.t("actions.rule.unsourced.evidence_claim", claim=e[:140]) for e in examples[:3]],
           snippet=Snippet("html", sn.citation_fix(examples, lang=r.ctx.lang)))


@rule
def spam_signals(r: Rules) -> None:
    f = r.p["eeat"].facts
    spam = f["spam_pages"]
    if not spam:
        return
    r.emit("eeat", "factual_consistency", base_impact="medium", effort="low", category="content",
           rule_id="content.spam_signals", fix_fraction=0.3,
           title=r.t("actions.rule.spam.title", count=len(spam)),
           description=r.t("actions.rule.spam.description"),
           affected_urls=sorted(spam), evidence=[f"{u}: {'; '.join(v)}" for u, v in list(spam.items())[:5]],
           snippet=Snippet("text", r.t("actions.rule.spam.example")))


@rule
def data_conflicts(r: Rules) -> None:
    f = r.p["eeat"].facts
    if not f["price_conflicts"] and len(f["organization_names"]) <= 2:
        return
    ev = [f"'{c['product']}': " + ", ".join(f"{u} → {p}" for u, p in c["prices"].items()) for c in f["price_conflicts"][:3]]
    if len(f["organization_names"]) > 2:
        ev.append(r.t("actions.rule.conflicts.evidence_org_names", names=", ".join(f["organization_names"])))
    r.emit("eeat", "factual_consistency", base_impact="high", effort="medium", category="content",
           rule_id="content.data_consistency", fix_fraction=0.3,
           title=r.t("actions.rule.conflicts.title"),
           description=r.t("actions.rule.conflicts.description"),
           affected_urls=sorted({u for c in f["price_conflicts"] for u in c["prices"]}), evidence=ev)


# ---------------- technical SEO ----------------

@rule
def meta_descriptions(r: Rules) -> None:
    urls = r.p["technical_seo"].facts["missing_meta_description"]
    if not urls:
        return
    pages = [p for p in r.ctx.pages if p.url in set(urls)]
    r.emit("technical_seo", "meta_description", base_impact="low", effort="low", category="technical",
           rule_id="technical.meta_description", title=r.t("actions.rule.meta_description.title", count=len(urls)),
           description=r.t("actions.rule.meta_description.description"),
           affected_urls=urls, snippet=Snippet("html", sn.meta_description_fix(pages)))


@rule
def broken_pages(r: Rules) -> None:
    broken = r.p["technical_seo"].facts["broken"]
    if not broken:
        return
    t = r.t
    r.emit("technical_seo", "broken_pages", base_impact="medium", effort="low", category="technical",
           rule_id="technical.broken_pages", title=t("actions.rule.broken_pages.title", count=len(broken)),
           description=t("actions.rule.broken_pages.description"),
           affected_urls=[b["url"] for b in broken],
           evidence=[f"{b['url']} → {b['status'] or b['error']}" for b in broken[:5]],
           snippet=Snippet("nginx", "\n".join(t("actions.rule.broken_pages.redirect_line", path=urlsplit(b["url"]).path)
                                              for b in broken[:5]), None,
                           t("actions.rule.broken_pages.instructions")))


@rule
def thin_content(r: Rules) -> None:
    thin = r.p["technical_seo"].facts["thin"]
    if len(thin) < 2 and not r.failing("technical_seo", "thin_content", 80):
        return
    if not thin:
        return
    r.emit("technical_seo", "thin_content", base_impact="medium", effort="high", category="content",
           rule_id="content.thin_content", title=r.t("actions.rule.thin_content.title", count=len(thin)),
           description=r.t("actions.rule.thin_content.description"),
           affected_urls=thin)


ACCESS_RULES = (site_unreachable, ai_bots_blocked, waf_blocks_ai)


def generate_actions(ctx: AuditContext, pillars: dict[str, Pillar]) -> list[ActionCard]:
    r = Rules(ctx, pillars)
    # nothing was fetched: content/schema advice would be guesswork — only access blockers are reported
    for fn in (RULES if ctx.pages else ACCESS_RULES):
        fn(r)
    return sorted(r.cards, key=lambda c: (-c.priority, c.rule_id))
