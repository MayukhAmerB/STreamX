from datetime import timedelta
import json

from django.conf import settings
from django.core.mail import EmailMessage
from django.db import connection, transaction
from django.utils import timezone

from config.metrics import record_async_job_execution

from .models import AsyncJob


def async_jobs_enabled():
    return bool(getattr(settings, "ASYNC_JOBS_ENABLED", False))


def enqueue_email_job(*, subject, body, from_email, to, reply_to=None, max_attempts=5):
    return AsyncJob.objects.create(
        job_type=AsyncJob.TYPE_EMAIL_SEND,
        status=AsyncJob.STATUS_PENDING,
        payload={
            "subject": str(subject or ""),
            "body": str(body or ""),
            "from_email": str(from_email or ""),
            "to": list(to or []),
            "reply_to": list(reply_to or []),
        },
        max_attempts=max(1, int(max_attempts or 1)),
        run_after=timezone.now(),
    )


def enqueue_payment_webhook_retry_job(*, payload, signature, max_attempts=6):
    return AsyncJob.objects.create(
        job_type=AsyncJob.TYPE_PAYMENT_WEBHOOK_RETRY,
        status=AsyncJob.STATUS_PENDING,
        payload={
            "payload": payload,
            "signature": str(signature or ""),
        },
        max_attempts=max(1, int(max_attempts or 1)),
        run_after=timezone.now(),
    )


def enqueue_web_push_job(*, notification_id, user_ids, max_attempts=3):
    return AsyncJob.objects.create(
        job_type=AsyncJob.TYPE_WEB_PUSH_SEND,
        status=AsyncJob.STATUS_PENDING,
        payload={
            "notification_id": int(notification_id),
            "user_ids": [int(user_id) for user_id in user_ids or []],
        },
        max_attempts=max(1, int(max_attempts or 1)),
        run_after=timezone.now(),
    )


def _claim_due_jobs(limit):
    now = timezone.now()
    with transaction.atomic():
        lock_timeout_seconds = max(30, int(getattr(settings, "ASYNC_JOBS_LOCK_TIMEOUT_SECONDS", 300)))
        stale_cutoff = now - timedelta(seconds=lock_timeout_seconds)
        AsyncJob.objects.filter(
            status=AsyncJob.STATUS_PROCESSING,
            locked_at__lt=stale_cutoff,
        ).update(
            status=AsyncJob.STATUS_PENDING,
            locked_at=None,
            run_after=now,
        )

        queryset = AsyncJob.objects.filter(
            status=AsyncJob.STATUS_PENDING,
            run_after__lte=now,
        ).order_by("run_after", "id")

        if connection.vendor == "postgresql":
            queryset = queryset.select_for_update(skip_locked=True)
        else:
            queryset = queryset.select_for_update()

        jobs = list(queryset[:limit])
        if not jobs:
            return []

        ids = [job.id for job in jobs]
        AsyncJob.objects.filter(id__in=ids).update(
            status=AsyncJob.STATUS_PROCESSING,
            locked_at=now,
        )
        for job in jobs:
            job.status = AsyncJob.STATUS_PROCESSING
            job.locked_at = now
        return jobs


def _run_email_job(job):
    payload = job.payload or {}
    recipients = [str(item).strip() for item in list(payload.get("to") or []) if str(item).strip()]
    if not recipients:
        raise ValueError("Email async job has no recipients.")

    email = EmailMessage(
        subject=str(payload.get("subject") or ""),
        body=str(payload.get("body") or ""),
        from_email=str(payload.get("from_email") or ""),
        to=recipients,
        reply_to=[str(item).strip() for item in list(payload.get("reply_to") or []) if str(item).strip()],
    )
    email.send(fail_silently=False)
    return {"sent_to": recipients}


def _run_payment_webhook_retry_job(job):
    payload = job.payload or {}
    body_payload = payload.get("payload")
    if isinstance(body_payload, str):
        body_payload = json.loads(body_payload)
    if not isinstance(body_payload, dict):
        raise ValueError("Webhook retry payload must be a dictionary.")

    from apps.payments.views import process_payment_webhook_payload

    result = process_payment_webhook_payload(
        payload=body_payload,
        signature=str(payload.get("signature") or ""),
        request=None,
        source="async_retry",
    )
    status_code = int(result.get("status_code", 200))
    if status_code >= 500:
        raise RuntimeError(f"Webhook retry processing returned status_code={status_code}")
    return result


def _run_web_push_job(job):
    payload = job.payload or {}
    notification_id = payload.get("notification_id")
    user_ids = payload.get("user_ids") or []
    if not notification_id:
        raise ValueError("Web push job has no notification_id.")

    from apps.notifications.models import Notification
    from apps.notifications.services import send_push_for_notification

    notification = Notification.objects.get(pk=notification_id)
    sent = send_push_for_notification(notification, user_ids)
    return {"sent": sent, "notification_id": notification.id}


def _run_job(job):
    if job.job_type == AsyncJob.TYPE_EMAIL_SEND:
        return _run_email_job(job)
    if job.job_type == AsyncJob.TYPE_PAYMENT_WEBHOOK_RETRY:
        return _run_payment_webhook_retry_job(job)
    if job.job_type == AsyncJob.TYPE_WEB_PUSH_SEND:
        return _run_web_push_job(job)
    raise ValueError(f"Unsupported async job type: {job.job_type}")


def _backoff_seconds(attempt_number):
    return min(900, max(10, (2 ** max(0, attempt_number - 1)) * 30))


def _mark_success(job, *, result_payload):
    now = timezone.now()
    AsyncJob.objects.filter(id=job.id).update(
        status=AsyncJob.STATUS_SUCCEEDED,
        result_payload=result_payload or {},
        last_error="",
        locked_at=None,
        completed_at=now,
    )


def _mark_retry_or_dead(job, *, error_text):
    attempts = int(job.attempts or 0) + 1
    max_attempts = max(1, int(job.max_attempts or 1))
    now = timezone.now()
    if attempts >= max_attempts:
        AsyncJob.objects.filter(id=job.id).update(
            attempts=attempts,
            status=AsyncJob.STATUS_DEAD,
            last_error=str(error_text or "")[:5000],
            locked_at=None,
            completed_at=now,
        )
        return "dead"

    run_after = now + timedelta(seconds=_backoff_seconds(attempts))
    AsyncJob.objects.filter(id=job.id).update(
        attempts=attempts,
        status=AsyncJob.STATUS_PENDING,
        run_after=run_after,
        last_error=str(error_text or "")[:5000],
        locked_at=None,
    )
    return "retry"


def run_pending_jobs(*, batch_size=20):
    claimed_jobs = _claim_due_jobs(max(1, int(batch_size or 1)))
    stats = {
        "claimed": len(claimed_jobs),
        "succeeded": 0,
        "retried": 0,
        "dead": 0,
        "failed": 0,
    }
    for job in claimed_jobs:
        try:
            result_payload = _run_job(job)
        except Exception as exc:  # noqa: BLE001
            outcome = _mark_retry_or_dead(job, error_text=str(exc))
            stats["failed"] += 1
            if outcome == "dead":
                stats["dead"] += 1
                record_async_job_execution(job=job.job_type, result="dead")
            else:
                stats["retried"] += 1
                record_async_job_execution(job=job.job_type, result="retry")
            continue

        _mark_success(job, result_payload=result_payload if isinstance(result_payload, dict) else {})
        stats["succeeded"] += 1
        record_async_job_execution(job=job.job_type, result="success")

    return stats
