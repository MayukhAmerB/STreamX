import logging

from config.client_ip import resolve_client_ip


audit_logger = logging.getLogger("security.audit")


def log_security_event(event, request=None, **data):
    payload = {"event": event, **data}
    if request is not None:
        user = getattr(request, "user", None)
        payload.update(
            {
                "ip": resolve_client_ip(request),
                "path": getattr(request, "path", ""),
                "method": getattr(request, "method", ""),
                "request_id": getattr(request, "request_id", None),
                "user_id": getattr(user, "id", None) if getattr(user, "is_authenticated", False) else None,
                "user_email": getattr(user, "email", None)
                if getattr(user, "is_authenticated", False)
                else None,
            }
        )
    audit_logger.info("SECURITY_AUDIT %s", payload)
