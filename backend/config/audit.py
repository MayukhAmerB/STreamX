import logging


audit_logger = logging.getLogger("security.audit")


def _client_ip(request):
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
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
