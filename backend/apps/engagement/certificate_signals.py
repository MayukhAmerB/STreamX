"""Monthly CTF finalist certificates join the certificate system.

``apps.ctf.season_services.finalise`` grants the season's rewards with
``bulk_create`` (no per-row signal) and then saves the season as finalised.
That save publishes one deduplicated outbox event (inside a savepoint, so it
can never roll back or break the finalisation); the worker then issues a
reference-numbered ``Certificate`` (type CTF, real name) for every reward of
kind ``certificate``. Issuing is idempotent, so retries and re-runs are safe.

Unlike XP and badges this does not depend on the ``engagement`` switch: the
Monthly CTF has its own switch and already promised these certificates, so
they must carry a verifiable reference however engagement is set. Older
rewards are certified on first lookup by their slug, or in bulk with
``manage.py engagement_issue_certificates --apply``.
"""

from __future__ import annotations

import logging

from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.core.outbox import outbox_handler, publish

logger = logging.getLogger("apps.engagement.certificates")

EVENT_CTF_CERTIFICATES = "engagement.ctf_season_certificates"


@receiver(post_save, sender="ctf.CtfSeason", dispatch_uid="engagement.ctf_season_certificates")
def ctf_season_saved(sender, instance, update_fields=None, **kwargs):
    try:
        if getattr(instance, "status", "") != "finalised":
            return
        if update_fields is not None and "status" not in update_fields:
            return
        with transaction.atomic():
            publish(EVENT_CTF_CERTIFICATES, {"season_id": instance.pk}, dedupe_key=f"eng-ctf-certs:{instance.pk}")
    except Exception:  # noqa: BLE001 - never break a season finalisation over a certificate
        logger.exception("engagement.ctf_certificates_publish_failed season=%s", getattr(instance, "pk", None))


@outbox_handler(EVENT_CTF_CERTIFICATES, max_attempts=8)
def handle_ctf_season_certificates(event):
    from .certificates import issue_for_ctf_season

    season_id = (event.payload or {}).get("season_id")
    if season_id:
        issued = issue_for_ctf_season(int(season_id))
        logger.info("engagement.ctf_certificates_issued season=%s issued=%s", season_id, issued)
