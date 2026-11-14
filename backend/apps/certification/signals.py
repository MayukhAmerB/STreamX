"""Hook: a certification-exam participation that ends queues its automatic decision.

``post_save`` on ``ctf.CtfParticipation`` (finishing the exam and the time
running out on an answer both save the row). Rows ended with ``.update()``
(the CTF scheduler's bulk expiry, the exam window closing) are picked up by
the periodic sweep (``sweep.py``). Fail-safe: the hook runs in a savepoint
and never breaks the exam flow.
"""

from __future__ import annotations

import logging

from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

logger = logging.getLogger("apps.certification")

ENDED = ("submitted", "expired")


@receiver(post_save, sender="ctf.CtfParticipation", dispatch_uid="certification.participation_ended")
def participation_saved(sender, instance, created=False, update_fields=None, **kwargs):
    try:
        if instance.is_staff_preview or instance.status not in ENDED:
            return
        if update_fields is not None and "status" not in update_fields:
            return
        from .models import ExamCertificationPolicy
        from .services import queue_decision

        with transaction.atomic():
            if ExamCertificationPolicy.objects.filter(exam_id=instance.exam_id, is_enabled=True).exists():
                queue_decision(instance.pk)
    except Exception:  # noqa: BLE001 - never break an exam over certification
        logger.exception("certification.queue_failed participation=%s", getattr(instance, "pk", None))
