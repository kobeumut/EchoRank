"""RFC 9309 robots.txt evaluation for AI crawlers.

``urllib.robotparser`` is first-match and has no wildcard support, which gives wrong answers for
real-world files (``Disallow: /*?`` / ``Allow: /blog/$``). This evaluator follows RFC 9309 / Google:

* the group whose user-agent token matches the crawler (case-insensitive product token) wins; ``*`` is the fallback;
  several groups for the same token are merged,
* inside the group the longest matching rule wins, ``Allow`` wins ties,
* ``*`` matches any sequence, ``$`` anchors the end.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from urllib.parse import urlsplit


@dataclass(frozen=True)
class AiBot:
    token: str
    vendor: str
    purpose: str  # search | user | training
    weight: float
    required: bool = False  # explicitly named in the product requirements


# Answer-engine retrieval/search & user-triggered fetchers matter most for being *cited*;
# training crawlers decide whether content ends up in model knowledge.
AI_BOTS: tuple[AiBot, ...] = (
    AiBot("GPTBot", "OpenAI", "training", 1.0, True),
    AiBot("OAI-SearchBot", "OpenAI", "search", 1.5),
    AiBot("ChatGPT-User", "OpenAI", "user", 1.5, True),
    AiBot("ClaudeBot", "Anthropic", "training", 1.0, True),
    AiBot("Claude-SearchBot", "Anthropic", "search", 1.2),
    AiBot("Claude-User", "Anthropic", "user", 1.2),
    AiBot("PerplexityBot", "Perplexity", "search", 1.5, True),
    AiBot("Perplexity-User", "Perplexity", "user", 1.0),
    AiBot("Google-Extended", "Google", "training", 1.0, True),
    AiBot("Applebot-Extended", "Apple", "training", 0.8, True),
    AiBot("Bingbot", "Microsoft", "search", 1.2),  # feeds Copilot & ChatGPT search index
    AiBot("CCBot", "Common Crawl", "training", 0.5),
)

# Full user-agent strings used when probing whether a WAF/CDN blocks AI crawlers.
PROBE_USER_AGENTS: dict[str, str] = {
    "GPTBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "ChatGPT-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    "ClaudeBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "PerplexityBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
}


@dataclass
class RobotsGroup:
    agents: list[str] = field(default_factory=list)
    rules: list[tuple[bool, str]] = field(default_factory=list)  # (allow, path pattern)


@dataclass
class RobotsRules:
    groups: list[RobotsGroup] = field(default_factory=list)
    sitemaps: list[str] = field(default_factory=list)

    def group_for(self, token: str) -> tuple[str | None, list[tuple[bool, str]]]:
        """Merged rules of the most specific group for ``token`` (None, [] if no group applies)."""
        t = token.lower()
        exact = [g for g in self.groups if any(a == t for a in g.agents)]
        if exact:
            return token, [r for g in exact for r in g.rules]
        star = [g for g in self.groups if "*" in g.agents]
        if star:
            return "*", [r for g in star for r in g.rules]
        return None, []

    def is_allowed(self, token: str, path: str) -> bool:
        _, rules = self.group_for(token)
        return evaluate(rules, path)

    def mentions(self, token: str) -> bool:
        return any(token.lower() in g.agents for g in self.groups)


def parse_robots_rules(text: str) -> RobotsRules:
    out = RobotsRules()
    current: RobotsGroup | None = None
    last_was_agent = False
    for raw in (text or "").splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        key, value = (s.strip() for s in line.split(":", 1))
        key = key.lower()
        if key == "user-agent":
            if current is None or not last_was_agent:
                current = RobotsGroup()
                out.groups.append(current)
            current.agents.append(value.lower().split("/")[0].strip())
            last_was_agent = True
            continue
        last_was_agent = False
        if key == "sitemap" and value:
            out.sitemaps.append(value)
        elif key in ("allow", "disallow") and current is not None:
            if key == "disallow" and not value:
                continue  # empty Disallow = allow all
            current.rules.append((key == "allow", value))
    return out


@lru_cache(maxsize=1024)
def _compile(pattern: str) -> re.Pattern[str]:
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    rx = "".join(".*" if ch == "*" else re.escape(ch) for ch in body)
    return re.compile(rx + ("$" if anchored else ""))


def evaluate(rules: list[tuple[bool, str]], path: str) -> bool:
    if not path.startswith("/"):
        parts = urlsplit(path)
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    if path == "/robots.txt":
        return True
    best_len, best_allow = -1, True
    for allow, pattern in rules:
        if not pattern.startswith("/") and not pattern.startswith("*"):
            pattern = "/" + pattern
        if _compile(pattern).match(path):
            length = len(pattern)
            if length > best_len or (length == best_len and allow):
                best_len, best_allow = length, allow
    return best_allow
