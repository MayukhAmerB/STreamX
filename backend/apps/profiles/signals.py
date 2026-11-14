"""New student accounts get their automatic handle right away (owner rule: every
student has a handle; inside the app students are shown by handle only).

The profile row (private, unpublished, ``handle_auto=True``) is created after
the signup transaction commits, so a failure here can never undo a signup or a
paid enrolment; ``manage.py generate_missing_handles --apply`` (idempotent)
catches any account this missed. The student is prompted once to pick their
own handle.
"""

from __future__ import annotations

import logging

from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

logger = logging.getLogger(__name__)


def _needs_handle(user) -> bool:
    return bool(
        user is not None
        and getattr(user, "is_active", True)
        and not getattr(user, "is_staff", False)
        and not getattr(user, "is_superuser", False)
        and getattr(user, "role", "student") == "student"
    )


def assign_handle_after_signup(user_id: int) -> None:
    from django.contrib.auth import get_user_model

    from .services import create_auto_profile

    user = get_user_model().objects.filter(pk=user_id).first()
    if not _needs_handle(user):
        return
    try:
        create_auto_profile(user, source="signup")
    except Exception:  # noqa: BLE001 - never break signup; the release command backfills
        logger.exception("profiles: could not assign an automatic handle to account %s", user_id)


@receiver(post_save, sender="users.User", dispatch_uid="profiles.assign_handle_on_signup")
def assign_handle_on_signup(sender, instance, created, raw=False, **kwargs):
    if raw or not created or not _needs_handle(instance):
        return
    user_id = instance.pk
    transaction.on_commit(lambda: assign_handle_after_signup(user_id))
