"""URLconf of ``config.settings.e2e`` only: the production routes plus the
``/api/__e2e__/`` control API. ``config/urls.py`` is not modified.

``config.urls`` serves ``MEDIA_ROOT`` publicly whenever ``DEBUG`` is on. The
E2E stack runs with DEBUG (dev server) but must behave like production behind
nginx, where /media/ is an allowlist and protected files leave Django only as
X-Accel-Redirect, so that static() route is dropped here; the stack's gateway
(e2e/stubs/gateway.mjs) applies the nginx media rules instead.
"""

from django.conf import settings
from django.urls import include, path

from config import urls as production_urls

_media_prefix = str(getattr(settings, "MEDIA_URL", "/media/")).lstrip("/")


def _is_debug_media_route(pattern) -> bool:
    return str(getattr(pattern, "pattern", "")).startswith(f"^{_media_prefix}") and getattr(
        getattr(pattern, "callback", None), "__name__", ""
    ) == "serve"


urlpatterns = [
    path("api/__e2e__/", include("apps.e2e_support.urls")),
    *[pattern for pattern in production_urls.urlpatterns if not _is_debug_media_route(pattern)],
]
