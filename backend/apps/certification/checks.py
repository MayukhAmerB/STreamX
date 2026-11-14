"""Deploy checks: WhatsApp half-configured (some variables set, others missing)."""

from __future__ import annotations

from django.core.checks import Tags, Warning, register

from . import whatsapp


@register(Tags.compatibility, deploy=True)
def check_whatsapp_configuration(app_configs=None, **kwargs):
    missing = whatsapp.missing_settings()
    if len(missing) in (0, 3):
        return []
    return [
        Warning(
            "WhatsApp certificate delivery is partly configured and stays DISABLED.",
            hint="Set " + ", ".join(missing) + " (see the certification deploy notes).",
            id="certification.W001",
        )
    ]
