import hashlib
import json
import logging

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import Notification, NotificationRecipient, WebPushSubscription

logger = logging.getLogger(__name__)


def _dedupe_user_ids(user_ids):
    seen = set()
    normalized = []
    for user_id in user_ids or []:
        try:
            parsed = int(user_id)
        except (TypeError, ValueError):
            continue
        if parsed <= 0 or parsed in seen:
            continue
        seen.add(parsed)
        normalized.append(parsed)
    return normalized


def _frontend_path(path):
    value = str(path or "").strip()
    if not value:
        return "/"
    if value.startswith(("http://", "https://")):
        return value
    return value if value.startswith("/") else f"/{value}"


def _notification_payload(notification):
    return {
        "title": notification.title,
        "body": notification.body,
        "url": _frontend_path(notification.action_url),
        "notification_id": notification.id,
        "kind": notification.kind,
    }


def create_notification(
    *,
    kind,
    title,
    body,
    recipients,
    event_key,
    action_url="",
    course=None,
    lecture=None,
    live_class=None,
    created_by=None,
):
    user_ids = _dedupe_user_ids(recipients)
    if not user_ids:
        return None

    with transaction.atomic():
        notification, _created = Notification.objects.get_or_create(
            event_key=str(event_key or "")[:220],
            defaults={
                "kind": kind,
                "title": str(title or "")[:180],
                "body": str(body or ""),
                "action_url": _frontend_path(action_url)[:512],
                "course": course,
                "lecture": lecture,
                "live_class": live_class,
                "created_by": created_by,
            },
        )
        NotificationRecipient.objects.bulk_create(
            [
                NotificationRecipient(user_id=user_id, notification=notification)
                for user_id in user_ids
            ],
            ignore_conflicts=True,
        )

    if _push_is_configured():
        try:
            from apps.users.async_jobs import async_jobs_enabled, enqueue_web_push_job
        except Exception:
            async_jobs_enabled = lambda: False
            enqueue_web_push_job = None

        if async_jobs_enabled() and enqueue_web_push_job is not None:
            enqueue_web_push_job(notification_id=notification.id, user_ids=user_ids)
        else:
            send_push_for_notification(notification, user_ids)
    return notification


def course_enrolled_user_ids(course):
    if not course or not getattr(course, "pk", None):
        return []
    from apps.courses.models import Enrollment

    return list(
        Enrollment.objects.filter(
            course=course,
            payment_status=Enrollment.STATUS_PAID,
            user__is_active=True,
        ).values_list("user_id", flat=True)
    )


def live_class_recipient_user_ids(live_class):
    if not live_class or not getattr(live_class, "pk", None):
        return []
    from apps.courses.models import Enrollment, LiveClassEnrollment

    user_ids = list(
        LiveClassEnrollment.objects.filter(
            live_class=live_class,
            status=LiveClassEnrollment.STATUS_APPROVED,
            user__is_active=True,
        ).values_list("user_id", flat=True)
    )
    linked_course = getattr(live_class, "linked_course", None)
    if linked_course:
        user_ids.extend(
            Enrollment.objects.filter(
                course=linked_course,
                payment_status=Enrollment.STATUS_PAID,
                user__is_active=True,
            ).values_list("user_id", flat=True)
        )
    return _dedupe_user_ids(user_ids)


def _lecture_source_fingerprint(lecture):
    raw_source = str(getattr(getattr(lecture, "video_file", None), "name", "") or "")
    raw_key = str(getattr(lecture, "video_key", "") or "")
    source = raw_source or raw_key
    if not source:
        return ""
    return hashlib.sha1(source.encode("utf-8", errors="ignore")).hexdigest()[:16]


def notify_course_video_uploaded(lecture):
    if not lecture or not getattr(lecture, "pk", None):
        return None
    course = getattr(getattr(lecture, "section", None), "course", None)
    if not course or not getattr(course, "pk", None) or not getattr(course, "is_published", False):
        return None
    fingerprint = _lecture_source_fingerprint(lecture)
    if not fingerprint:
        return None
    recipients = course_enrolled_user_ids(course)
    title = "New course video uploaded"
    body = f'"{lecture.title}" is now available in {course.title}.'
    event_key = f"course-video-uploaded:{lecture.pk}:{fingerprint}"
    return create_notification(
        kind=Notification.KIND_COURSE_VIDEO_UPLOADED,
        title=title,
        body=body,
        recipients=recipients,
        event_key=event_key,
        action_url=f"/learn/{course.pk}",
        course=course,
        lecture=lecture,
        created_by=getattr(course, "instructor", None),
    )


def notify_live_class_started(session):
    if not session or not getattr(session, "pk", None):
        return None
    live_class = getattr(session, "linked_live_class", None)
    if not live_class or not getattr(live_class, "pk", None):
        return None
    recipients = live_class_recipient_user_ids(live_class)
    title = "Live class started"
    body = f'"{live_class.title}" is live now. Join from the live classroom.'
    return create_notification(
        kind=Notification.KIND_LIVE_CLASS_STARTED,
        title=title,
        body=body,
        recipients=recipients,
        event_key=f"live-class-started:{session.pk}",
        action_url="/join-live",
        course=getattr(live_class, "linked_course", None),
        live_class=live_class,
        created_by=getattr(session, "host", None),
    )


def _push_is_configured():
    return bool(
        getattr(settings, "WEB_PUSH_ENABLED", False)
        and str(getattr(settings, "WEB_PUSH_VAPID_PUBLIC_KEY", "") or "").strip()
        and str(getattr(settings, "WEB_PUSH_VAPID_PRIVATE_KEY", "") or "").strip()
    )


def send_push_for_notification(notification, user_ids):
    if not notification or not _push_is_configured():
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except Exception as exc:
        logger.warning("Web push is enabled but pywebpush is unavailable: %s", exc)
        return 0

    normalized_user_ids = _dedupe_user_ids(user_ids)
    if not normalized_user_ids:
        return 0

    payload = json.dumps(_notification_payload(notification))
    subscriptions = WebPushSubscription.objects.filter(
        user_id__in=normalized_user_ids,
        is_active=True,
    )
    sent = 0
    for subscription in subscriptions.iterator():
        try:
            webpush(
                subscription_info={
                    "endpoint": subscription.endpoint,
                    "keys": {
                        "p256dh": subscription.p256dh,
                        "auth": subscription.auth,
                    },
                },
                data=payload,
                vapid_private_key=settings.WEB_PUSH_VAPID_PRIVATE_KEY,
                vapid_claims={"sub": settings.WEB_PUSH_VAPID_SUBJECT},
            )
            sent += 1
            NotificationRecipient.objects.filter(
                user_id=subscription.user_id,
                notification=notification,
            ).update(pushed_at=timezone.now(), push_error="")
        except WebPushException as exc:
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            if status_code in {404, 410}:
                subscription.is_active = False
                subscription.save(update_fields=["is_active", "updated_at"])
            NotificationRecipient.objects.filter(
                user_id=subscription.user_id,
                notification=notification,
            ).update(push_error=str(exc)[:1000])
        except Exception as exc:
            NotificationRecipient.objects.filter(
                user_id=subscription.user_id,
                notification=notification,
            ).update(push_error=str(exc)[:1000])
    return sent
