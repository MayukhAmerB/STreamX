import ipaddress

from django.conf import settings


# Addresses our own proxies can have on the Docker bridge / host. Deliberately
# explicit: ``ipaddress.is_private`` also covers reserved ranges such as
# 240.0.0.0/4, which Cloudflare's Pseudo IPv4 hands out as *client* addresses,
# and documentation/benchmark ranges no proxy of ours ever uses.
_INTERNAL_HOP_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)


def is_internal_address(value):
    """True for loopback / RFC 1918 / link-local / ULA addresses (our own hosts and containers)."""
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if address.version == 6 and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return any(address in network for network in _INTERNAL_HOP_NETWORKS)


_is_internal_hop = is_internal_address


def _trusted_proxy_count():
    try:
        return max(1, int(getattr(settings, "TRUSTED_PROXY_COUNT", 1)))
    except (TypeError, ValueError):
        return 1


def resolve_client_ip(request):
    """Return the client address recorded by our own edge proxy.

    Production chain: Cloudflare -> host nginx -> internal nginx gateway ->
    gunicorn. Host nginx restores the visitor from CF-Connecting-IP (real_ip,
    only for Cloudflare ranges) and appends that address to X-Forwarded-For;
    the gateway then appends its own peer (host nginx, seen on the Docker
    bridge). So a request through the gateway arrives as

        X-Forwarded-For: <anything the client sent>, <client>, <bridge peer>

    and REMOTE_ADDR is the gateway. When the gateway is down, host nginx falls
    back to the backend directly (``server 127.0.0.1:8000 backup``) and the
    chain is one entry shorter: ``<anything the client sent>, <client>``.

    Only entries appended by our proxies can be trusted; everything to their
    left is client controlled. Rather than always taking ips[-2] (which on the
    backup path would be a client-supplied value whenever Cloudflare is
    bypassed), we strip at most TRUSTED_PROXY_COUNT trailing *internal* hops
    (loopback/private/link-local, i.e. our gateway's peer) and take the
    rightmost remaining entry. With TRUSTED_PROXY_COUNT=1 that is ips[-2] via
    the gateway and ips[-1] on the backup path. A spoofed leading value can
    never be reached, because the entry appended by host nginx is always
    public for internet clients and is never stripped.
    """
    remote_addr = request.META.get("REMOTE_ADDR", "") or "unknown"
    if not getattr(settings, "TRUST_X_FORWARDED_FOR", False):
        return remote_addr

    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR", "")
    ips = [item.strip() for item in forwarded_for.split(",") if item.strip()]
    if not ips:
        return remote_addr

    stripped = 0
    while stripped < _trusted_proxy_count() and len(ips) > 1 and _is_internal_hop(ips[-1]):
        ips.pop()
        stripped += 1
    return ips[-1]
