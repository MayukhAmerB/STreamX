"""Deploy checks for certificates (``manage.py check --deploy``; production only).

Severity follows apps/core/checks.py: ``entrypoint.sh`` runs ``check --deploy
--fail-level WARNING``, so a WARNING would refuse to start production. These
are advisories that must never block a start, so they are INFO:

engagement.I001  FRONTEND_PUBLIC_ORIGIN is not set: certificates fall back to
                 https://alsyedinitiative.com (set it explicitly).
engagement.I002  FRONTEND_PUBLIC_ORIGIN is not https (config.settings.prod
                 already refuses this unless ALLOW_INSECURE_HTTP_ORIGINS).
engagement.I003  segno is not installed: certificates print the address but no QR code.
"""

from __future__ import annotations

from urllib.parse import urlparse

from django.conf import settings
from django.core.checks import Info, Tags, register

from .certificates import PRODUCTION_ORIGIN, is_production, qr_available

ENGAGEMENT_TAG = "engagement"


@register(ENGAGEMENT_TAG, Tags.security, deploy=True)
def check_certificate_origin(app_configs=None, **kwargs):
    if not is_production():
        return []
    messages = []
    origin = str(getattr(settings, "FRONTEND_PUBLIC_ORIGIN", "") or "").strip()
    if not origin:
        messages.append(
            Info(
                "FRONTEND_PUBLIC_ORIGIN is not set; certificate links and QR codes use "
                f"{PRODUCTION_ORIGIN} as a fallback.",
                hint=f"Set FRONTEND_PUBLIC_ORIGIN={PRODUCTION_ORIGIN} in the production environment.",
                id="engagement.I001",
            )
        )
    elif urlparse(origin).scheme != "https":
        messages.append(
            Info(
                f"FRONTEND_PUBLIC_ORIGIN ({origin}) is not https; certificates would print an insecure verification address.",
                hint=f"Set FRONTEND_PUBLIC_ORIGIN={PRODUCTION_ORIGIN}.",
                id="engagement.I002",
            )
        )
    if not qr_available():
        messages.append(
            Info(
                "The segno package is not installed; certificates are issued without a QR code.",
                hint="Install backend/requirements.txt (segno is pinned there).",
                id="engagement.I003",
            )
        )
    return messages
