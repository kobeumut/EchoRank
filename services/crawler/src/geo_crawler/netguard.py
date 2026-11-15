"""SSRF guard for the crawler's own HTTP clients.

A crawled site can redirect to, or link to, internal addresses (cloud metadata service, localhost admin
panels, private LAN hosts). The guard is installed as an httpx *request event hook*, so it runs for the first
request and for every redirect hop. Set ``ALLOW_PRIVATE_NETWORK_TARGETS=true`` to crawl local/private hosts
during development (same switch as the web app).

Residual risk: the name is resolved here and again by the HTTP client (DNS rebinding). Deploy the crawler in a
network that cannot reach internal services if the targets are fully untrusted.
"""
from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from urllib.parse import urlsplit

import httpx

_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_INTERNAL_SUFFIXES = (".localhost", ".local", ".internal", ".localdomain", ".home.arpa")


class BlockedTargetError(httpx.RequestError):
    """Raised instead of connecting to a private / internal address."""


def private_targets_allowed() -> bool:
    return os.environ.get("ALLOW_PRIVATE_NETWORK_TARGETS", "").strip().lower() == "true"


def is_blocked_address(value: str) -> bool:
    """True for loopback, private, link-local, CGNAT, multicast, reserved, unspecified and IPv4-mapped equivalents."""
    try:
        ip = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return True  # not an IP: fail closed
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified
        or (isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT)
    )


def _literal_host_blocked(host: str) -> bool | None:
    """Decision that needs no DNS: True/False for IP literals and internal-looking names, None to resolve."""
    host = host.strip("[]").rstrip(".").lower()
    if host == "localhost" or host.endswith(_INTERNAL_SUFFIXES):
        return True
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return None
    return is_blocked_address(host)


def check_url_sync(url: str) -> None:
    """Raise ``BlockedTargetError`` if ``url`` points at (or resolves to) a non-public address."""
    if private_targets_allowed():
        return
    host = urlsplit(url).hostname or ""
    verdict = _literal_host_blocked(host)
    if verdict is None:
        try:
            infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except socket.gaierror:
            return  # unresolvable: the request itself will fail
        verdict = any(is_blocked_address(info[4][0]) for info in infos)
    if verdict:
        raise BlockedTargetError(f"Refusing to connect to a private or internal address: {host}")


async def check_request(request: httpx.Request) -> None:
    """httpx async request hook (runs for redirects too)."""
    if private_targets_allowed():
        return
    host = request.url.host
    verdict = _literal_host_blocked(host)
    if verdict is None:
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except socket.gaierror:
            return
        verdict = any(is_blocked_address(info[4][0]) for info in infos)
    if verdict:
        raise BlockedTargetError(f"Refusing to connect to a private or internal address: {host}", request=request)


def check_request_sync(request: httpx.Request) -> None:
    check_url_sync(str(request.url))


GUARD_HOOKS = {"request": [check_request]}
SYNC_GUARD_HOOKS = {"request": [check_request_sync]}
