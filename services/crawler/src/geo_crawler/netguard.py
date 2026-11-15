"""SSRF guard for the crawler's own HTTP clients.

A crawled site can redirect to, or link to, internal addresses (cloud metadata service, localhost admin
panels, private LAN hosts). Set ``ALLOW_PRIVATE_NETWORK_TARGETS=true`` to crawl local/private hosts during
development (same switch as the web app).

The guard is an httpx *transport* (``PinnedAsyncTransport`` / ``PinnedTransport``, built by ``guarded_async_client``
and ``guarded_client``). httpx sends the first request and every redirect hop through the transport, which resolves
the host name once, refuses it unless every address is public, and then connects to the checked IP itself (the
original ``Host`` header and the TLS server name / certificate check are kept). The HTTP client never resolves the
name a second time, so a DNS-rebinding answer cannot switch the connection to an internal address after the check.

``GUARD_HOOKS`` / ``check_request`` remain as a cheap pre-check for clients that cannot use the transport, but they
do not pin the connection.
"""
from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from collections import OrderedDict
from typing import Any, Awaitable, Callable
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


# ---------------------------------------------------------------------------------------------------------------
# DNS-pinned transports
# ---------------------------------------------------------------------------------------------------------------

AsyncResolver = Callable[[str, int], Awaitable[list[str]]]
SyncResolver = Callable[[str, int], list[str]]


async def _default_async_resolve(host: str, port: int) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


def _default_sync_resolve(host: str, port: int) -> list[str]:
    return [info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


def _pick_public(host: str, addresses: list[str], request: httpx.Request) -> str:
    """The address to connect to; every resolved address must be public (fail closed on mixed answers)."""
    unique = list(dict.fromkeys(a.split("%", 1)[0] for a in addresses))
    if not unique or any(is_blocked_address(a) for a in unique):
        raise BlockedTargetError(f"Refusing to connect to a private or internal address: {host}", request=request)
    return unique[0]


def _pinned_request(request: httpx.Request, ip: str) -> httpx.Request:
    """Copy of ``request`` aimed at ``ip``; the Host header (set from the original URL) and TLS name stay the same."""
    extensions = dict(request.extensions)
    if request.url.scheme == "https" and "sni_hostname" not in extensions:
        extensions["sni_hostname"] = request.url.host  # certificate is verified for the name, not the IP
    return httpx.Request(request.method, request.url.copy_with(host=ip), headers=request.headers,
                         stream=request.stream, extensions=extensions)


def _host_verdict(request: httpx.Request) -> tuple[str, int, bool | None]:
    host = request.url.host
    port = request.url.port or (443 if request.url.scheme == "https" else 80)
    return host, port, _literal_host_blocked(host)


# Inner transports are kept per host name: an HTTPS connection verified for one name must never be reused for
# another name that happens to share the IP (connection pools are keyed by the IP origin after pinning).
_MAX_POOLS = 64


class PinnedAsyncTransport(httpx.AsyncBaseTransport):
    """Async transport that validates the resolved address and connects to exactly that address."""

    def __init__(self, *, resolver: AsyncResolver | None = None,
                 transport_factory: Callable[[], httpx.AsyncBaseTransport] | None = None, **transport_kwargs: Any):
        self._resolve = resolver or _default_async_resolve
        self._factory = transport_factory or (lambda: httpx.AsyncHTTPTransport(**transport_kwargs))
        self._pools: OrderedDict[str, httpx.AsyncBaseTransport] = OrderedDict()

    async def _pool(self, key: str) -> httpx.AsyncBaseTransport:
        pool = self._pools.pop(key, None) or self._factory()
        self._pools[key] = pool
        while len(self._pools) > _MAX_POOLS:
            _, old = self._pools.popitem(last=False)
            await old.aclose()
        return pool

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if private_targets_allowed():
            return await (await self._pool("*")).handle_async_request(request)
        host, port, verdict = _host_verdict(request)
        if verdict:
            raise BlockedTargetError(f"Refusing to connect to a private or internal address: {host}", request=request)
        if verdict is False:  # public IP literal: nothing to resolve
            return await (await self._pool(host)).handle_async_request(request)
        try:
            addresses = await self._resolve(host, port)
        except socket.gaierror as exc:
            raise httpx.ConnectError(f"Could not resolve {host}: {exc}", request=request) from exc
        ip = _pick_public(host, addresses, request)
        return await (await self._pool(host)).handle_async_request(_pinned_request(request, ip))

    async def aclose(self) -> None:
        pools, self._pools = list(self._pools.values()), OrderedDict()
        for pool in pools:
            await pool.aclose()


class PinnedTransport(httpx.BaseTransport):
    """Synchronous twin of :class:`PinnedAsyncTransport` (used by the ``geo-autogeo`` CLI)."""

    def __init__(self, *, resolver: SyncResolver | None = None,
                 transport_factory: Callable[[], httpx.BaseTransport] | None = None, **transport_kwargs: Any):
        self._resolve = resolver or _default_sync_resolve
        self._factory = transport_factory or (lambda: httpx.HTTPTransport(**transport_kwargs))
        self._pools: OrderedDict[str, httpx.BaseTransport] = OrderedDict()

    def _pool(self, key: str) -> httpx.BaseTransport:
        pool = self._pools.pop(key, None) or self._factory()
        self._pools[key] = pool
        while len(self._pools) > _MAX_POOLS:
            _, old = self._pools.popitem(last=False)
            old.close()
        return pool

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if private_targets_allowed():
            return self._pool("*").handle_request(request)
        host, port, verdict = _host_verdict(request)
        if verdict:
            raise BlockedTargetError(f"Refusing to connect to a private or internal address: {host}", request=request)
        if verdict is False:
            return self._pool(host).handle_request(request)
        try:
            addresses = self._resolve(host, port)
        except socket.gaierror as exc:
            raise httpx.ConnectError(f"Could not resolve {host}: {exc}", request=request) from exc
        ip = _pick_public(host, addresses, request)
        return self._pool(host).handle_request(_pinned_request(request, ip))

    def close(self) -> None:
        pools, self._pools = list(self._pools.values()), OrderedDict()
        for pool in pools:
            pool.close()


_TRANSPORT_ARGS = ("verify", "cert", "http1", "http2", "limits", "retries")


def _transport_kwargs(client_kwargs: dict[str, Any]) -> dict[str, Any]:
    """Moves transport-only options out of ``client_kwargs`` (``trust_env`` is shared by both)."""
    out = {k: client_kwargs.pop(k) for k in _TRANSPORT_ARGS if k in client_kwargs}
    if "trust_env" in client_kwargs:
        out["trust_env"] = client_kwargs["trust_env"]
    return out


def guarded_async_client(**kwargs: Any) -> httpx.AsyncClient:
    """``httpx.AsyncClient`` whose every request and redirect hop goes through :class:`PinnedAsyncTransport`.

    Transport options (``limits``, ``verify``, ``http2`` …) are forwarded to the per-host connection pools.
    """
    transport_kwargs = _transport_kwargs(kwargs)
    return httpx.AsyncClient(transport=PinnedAsyncTransport(**transport_kwargs), **kwargs)


def guarded_client(**kwargs: Any) -> httpx.Client:
    """Synchronous variant of :func:`guarded_async_client`."""
    transport_kwargs = _transport_kwargs(kwargs)
    return httpx.Client(transport=PinnedTransport(**transport_kwargs), **kwargs)
