"""Path-scoped CORS for the labs site.

The labs origin is deliberately NOT in ``CORS_ALLOWED_ORIGINS`` (that would
let it read every API response). This receiver enables CORS for a labs origin
only on the exam API, the CSRF bootstrap and the token refresh.
"""

from __future__ import annotations

from config.labs_origin import is_labs_origin, labs_path_allowed
from corsheaders.signals import check_request_enabled
from django.dispatch import receiver


@receiver(check_request_enabled, dispatch_uid="apps.ctf.labs_cors")
def allow_labs_origin_on_exam_paths(sender, request, **kwargs):
    origin = request.headers.get("Origin")
    return bool(origin and is_labs_origin(origin) and labs_path_allowed(request.path_info))
