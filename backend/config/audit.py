import logging

from django.conf import settings


audit_logger = logging.getLogger("security.audit")


def _client_ip(request):
    if getattr(settings, "TRUST_X_FORWARDED_FOR", False):
        forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR", "")
        if forwarded_for:
            ips = [item.strip() for item in forwarded_for.split(",") if item.strip()]
            if ips:
                # When trusted proxies are configured, pick the closest untrusted client.
                try:
                    trusted_proxy_count = max(1, int(getattr(settings, "TRUSTED_PROXY_COUNT", 1)))
                except (TypeError, ValueError):
                    trusted_proxy_count = 1
                if len(ips) > trusted_proxy_count:
                    return ips[-(trusted_proxy_count + 1)]
                return ips[0]
    return request.META.get("REMOTE_ADDR", "") or "unknown"


def log_security_event(event, request=None, **data):
    payload = {"event": event, **data}
    if request is not None:
        user = getattr(request, "user", None)
        payload.update(
            {
                "ip": _client_ip(request),
                "path": getattr(request, "path", ""),
                "method": getattr(request, "method", ""),
                "user_id": getattr(user, "id", None) if getattr(user, "is_authenticated", False) else None,
                "user_email": getattr(user, "email", None)
                if getattr(user, "is_authenticated", False)
                else None,
            }
        )
    audit_logger.info("SECURITY_AUDIT %s", payload)
