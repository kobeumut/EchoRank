"""URL normalisation helpers."""
from __future__ import annotations

from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gclid", "fbclid", "yclid", "mc_cid", "mc_eid", "_ga",
}

SKIP_EXTENSIONS = (
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
    ".pdf", ".zip", ".rar", ".gz", ".tar", ".7z", ".mp3", ".mp4", ".avi", ".mov",
    ".webm", ".css", ".js", ".json", ".woff", ".woff2", ".ttf", ".eot", ".xml",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".exe", ".dmg",
)


def normalize_url(url: str, base: str | None = None) -> str | None:
    """Resolve, strip fragments/tracking params, lowercase host, drop default ports.

    Returns None for non-http(s) URLs (mailto:, tel:, javascript: ...).
    """
    if not url:
        return None
    url = url.strip()
    if base:
        url = urljoin(base, url)
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower()
    if not host:
        return None
    port = parts.port
    netloc = host
    if port and not ((parts.scheme == "http" and port == 80) or (parts.scheme == "https" and port == 443)):
        netloc = f"{host}:{port}"
    path = parts.path or "/"
    # collapse duplicate slashes
    while "//" in path:
        path = path.replace("//", "/")
    query = urlencode(
        sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k.lower() not in TRACKING_PARAMS)
    )
    return urlunsplit((parts.scheme, netloc, path, query, ""))


def registrable_host(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def is_internal(url: str, root: str) -> bool:
    return registrable_host(url) == registrable_host(root)


def is_crawlable_resource(url: str) -> bool:
    path = urlsplit(url).path.lower()
    return not path.endswith(SKIP_EXTENSIONS)


def url_path(url: str) -> str:
    return urlsplit(url).path or "/"
