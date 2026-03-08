from django.conf import settings


def resolve_client_ip(request):
    remote_addr = request.META.get("REMOTE_ADDR", "") or "unknown"
    if not getattr(settings, "TRUST_X_FORWARDED_FOR", False):
        return remote_addr

    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if not forwarded_for:
        return remote_addr

    ips = [item.strip() for item in forwarded_for.split(",") if item.strip()]
    if not ips:
        return remote_addr

    try:
        trusted_proxy_count = max(1, int(getattr(settings, "TRUSTED_PROXY_COUNT", 1)))
    except (TypeError, ValueError):
        trusted_proxy_count = 1

    if len(ips) > trusted_proxy_count:
        return ips[-(trusted_proxy_count + 1)]
    return ips[0]
