"""Console Admin › System › Health (plan §4.3). OWNER: WS-G.

``GET  /api/admin/system/health/``        failed outbox events, dead async
                                          jobs, the server-profile agent
``POST /api/admin/system/health/retry/``  ``{"kind": "outbox"|"job", "ids": [..]}``
                                          (``ids`` omitted = every failed one)

Outbox events are retried with ``apps.core.outbox.retry_events`` (the Django
admin action); async jobs are put back to pending row by row. Each list needs
the Django ``view`` permission of its model and Retry needs ``change``.
"""

from __future__ import annotations

from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from apps.core.errors import PermissionDenied, ValidationFailed

LIST_LIMIT = 25
ERROR_PREVIEW = 400
AGENT_OFFLINE_AFTER = timedelta(minutes=10)
KINDS = ("outbox", "job")


def _preview(text: str) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= ERROR_PREVIEW else f"{text[: ERROR_PREVIEW - 1]}…"


def _iso(value):
    return value.isoformat() if value else None


def _outbox(user):
    from apps.core.models import OutboxEvent

    if not user.has_perm("core.view_outboxevent"):
        return None
    failed = OutboxEvent.objects.filter(status=OutboxEvent.STATUS_DEAD)
    rows = failed.order_by("-created_at", "-pk")[:LIST_LIMIT]
    return {
        "count": failed.count(),
        "pending": OutboxEvent.objects.filter(status=OutboxEvent.STATUS_PENDING).count(),
        "can_retry": user.has_perm("core.change_outboxevent"),
        "items": [
            {
                "id": row.pk,
                "title": row.event_type,
                "attempts": row.attempts,
                "max_attempts": row.max_attempts,
                "error": _preview(row.last_error),
                "created_at": _iso(row.created_at),
                "href": f"/admin/core/outboxevent/{row.pk}/change/",
            }
            for row in rows
        ],
    }


def _jobs(user):
    from apps.users.models import AsyncJob

    if not user.has_perm("users.view_asyncjob"):
        return None
    failed = AsyncJob.objects.filter(status=AsyncJob.STATUS_DEAD)
    labels = dict(AsyncJob.TYPE_CHOICES)
    rows = failed.order_by("-updated_at", "-pk")[:LIST_LIMIT]
    return {
        "count": failed.count(),
        "pending": AsyncJob.objects.filter(status=AsyncJob.STATUS_PENDING).count(),
        "can_retry": user.has_perm("users.change_asyncjob"),
        "items": [
            {
                "id": row.pk,
                "title": labels.get(row.job_type, row.job_type),
                "attempts": row.attempts,
                "max_attempts": row.max_attempts,
                "error": _preview(row.last_error),
                "created_at": _iso(row.updated_at),
                "href": f"/admin/users/asyncjob/{row.pk}/change/",
            }
            for row in rows
        ],
    }


def _server_profile(user):
    from apps.realtime.models import ServerResourceProfile

    if not user.has_perm("realtime.view_serverresourceprofile"):
        return None
    profile = ServerResourceProfile.objects.filter(pk=1).first()
    if profile is None:
        return {"configured": False}
    now = timezone.now()
    seen = profile.agent_last_seen_at
    return {
        "configured": True,
        "profile": profile.get_profile_display(),
        "applied_profile": profile.applied_profile or "",
        "in_sync": profile.in_sync(),
        "agent_online": profile.agent_online(now),
        "agent_offline_too_long": bool(seen and now - seen > AGENT_OFFLINE_AFTER),
        "agent_last_seen_at": _iso(seen),
        "agent_error": _preview(profile.agent_last_error),
        "status_label": profile.status_label(),
        "href": "/admin/realtime/serverresourceprofile/",
    }


def system_health(user) -> dict:
    outbox = _outbox(user)
    jobs = _jobs(user)
    profile = _server_profile(user)
    problems = sum(part["count"] for part in (outbox, jobs) if part) + int(bool(profile and profile.get("agent_offline_too_long")))
    return {
        "status": "attention" if problems else "ok",
        "problems": problems,
        "failed_outbox": outbox,
        "failed_jobs": jobs,
        "server_profile": profile,
        "insights_href": "/admin/dashboard/",
        "checked_at": timezone.now().isoformat(),
    }


def _clean_ids(ids):
    if ids is None:
        return None
    if not isinstance(ids, (list, tuple)):
        raise ValidationFailed(details={"ids": ["Send a list of ids."]})
    cleaned = []
    for value in ids[:500]:
        try:
            cleaned.append(int(value))
        except (TypeError, ValueError) as exc:
            raise ValidationFailed(details={"ids": ["Ids are whole numbers."]}) from exc
    return cleaned


def retry(user, *, kind: str, ids=None) -> dict:
    """Retry failed outbox events or async jobs. Returns ``{kind, retried}``."""
    if kind not in KINDS:
        raise ValidationFailed(details={"kind": ["Choose outbox or job."]})
    ids = _clean_ids(ids)
    if kind == "outbox":
        from apps.core.models import OutboxEvent
        from apps.core.outbox import retry_events

        if not user.has_perm("core.change_outboxevent"):
            raise PermissionDenied("You can't retry outbox events.", code="retry_forbidden")
        queryset = OutboxEvent.objects.filter(status=OutboxEvent.STATUS_DEAD)
        if ids is not None:
            queryset = queryset.filter(pk__in=ids)
        retried = retry_events(queryset)
    else:
        from apps.users.models import AsyncJob

        if not user.has_perm("users.change_asyncjob"):
            raise PermissionDenied("You can't retry background jobs.", code="retry_forbidden")
        queryset = AsyncJob.objects.filter(status=AsyncJob.STATUS_DEAD)
        if ids is not None:
            queryset = queryset.filter(pk__in=ids)
        retried = 0
        now = timezone.now()
        for pk in list(queryset.values_list("pk", flat=True)[:500]):
            with transaction.atomic():
                job = AsyncJob.objects.select_for_update().filter(pk=pk, status=AsyncJob.STATUS_DEAD).first()
                if job is None:
                    continue
                job.status = AsyncJob.STATUS_PENDING
                job.attempts = 0
                job.run_after = now
                job.locked_at = None
                job.save(update_fields=["status", "attempts", "run_after", "locked_at", "updated_at"])
                retried += 1
    if retried:
        from config.audit import log_security_event

        log_security_event("console_admin.health_retry", kind=kind, retried=retried, user_id=getattr(user, "pk", None))
        try:
            from .attention import bump_version

            bump_version()
        except Exception:  # noqa: BLE001
            pass
    return {"kind": kind, "retried": int(retried)}
