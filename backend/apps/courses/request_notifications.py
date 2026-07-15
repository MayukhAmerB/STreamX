import json
import logging
from urllib.error import URLError
from urllib.request import Request, urlopen

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import Enrollment, EnrollmentRequestNotification, LiveClassEnrollment

logger = logging.getLogger(__name__)


def _admin_destination():
    return str(getattr(settings, "ENROLLMENT_REQUEST_WHATSAPP_ADMIN_NUMBER", "") or "").strip()


def _webhook_url():
    return str(getattr(settings, "ENROLLMENT_REQUEST_WHATSAPP_WEBHOOK_URL", "") or "").strip()


def _webhook_token():
    return str(getattr(settings, "ENROLLMENT_REQUEST_WHATSAPP_WEBHOOK_TOKEN", "") or "").strip()


def _target_label(*, course=None, live_class=None):
    if course is not None:
        return f"Course: {course.title}"
    if live_class is not None:
        return f"Live class: {live_class.title}"
    return "General enrollment enquiry"


def _user_label(user):
    full_name = str(getattr(user, "full_name", "") or "").strip()
    email = str(getattr(user, "email", "") or "").strip()
    if full_name and email:
        return f"{full_name} <{email}>"
    return full_name or email or f"User #{getattr(user, 'id', 'unknown')}"


def build_authenticated_course_request_message(enrollment):
    return "\n".join(
        [
            "Course access request",
            f"Student: {_user_label(enrollment.user)}",
            f"Target: {_target_label(course=enrollment.course)}",
            f"Current status: {enrollment.payment_status}",
        ]
    )


def build_authenticated_live_class_request_message(enrollment):
    return "\n".join(
        [
            "Live class access request",
            f"Student: {_user_label(enrollment.user)}",
            f"Target: {_target_label(live_class=enrollment.live_class)}",
            f"Current status: {enrollment.status}",
        ]
    )


def _send_webhook(notification):
    url = _webhook_url()
    if not url:
        notification.status = EnrollmentRequestNotification.STATUS_SKIPPED
        notification.last_error = "WhatsApp webhook URL is not configured."
        notification.save(update_fields=["status", "last_error", "updated_at"])
        return notification

    payload = {
        "channel": notification.channel,
        "destination": notification.destination,
        "message": notification.message,
        "notification_id": notification.id,
    }
    headers = {"Content-Type": "application/json"}
    token = _webhook_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    notification.attempts = int(notification.attempts or 0) + 1
    try:
        request = Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urlopen(request, timeout=4) as response:
            body = response.read(4096).decode("utf-8", errors="replace")
            status_code = int(getattr(response, "status", 200) or 200)
    except (OSError, URLError, TimeoutError) as exc:
        notification.status = EnrollmentRequestNotification.STATUS_FAILED
        notification.last_error = str(exc)[:2000]
        notification.save(update_fields=["attempts", "status", "last_error", "updated_at"])
        logger.warning("Enrollment WhatsApp webhook failed: %s", exc)
        return notification

    notification.provider_response = {"status_code": status_code, "body": body[:2000]}
    if 200 <= status_code < 300:
        notification.status = EnrollmentRequestNotification.STATUS_SENT
        notification.sent_at = timezone.now()
        notification.last_error = ""
        notification.save(
            update_fields=[
                "attempts",
                "status",
                "provider_response",
                "last_error",
                "sent_at",
                "updated_at",
            ]
        )
    else:
        notification.status = EnrollmentRequestNotification.STATUS_FAILED
        notification.last_error = f"Webhook returned HTTP {status_code}"
        notification.save(
            update_fields=["attempts", "status", "provider_response", "last_error", "updated_at"]
        )
    return notification


def _create_and_send(*, message, public_lead=None, enrollment=None, live_class_enrollment=None):
    notification = EnrollmentRequestNotification.objects.create(
        public_lead=public_lead,
        enrollment=enrollment,
        live_class_enrollment=live_class_enrollment,
        destination=_admin_destination(),
        message=message,
        status=EnrollmentRequestNotification.STATUS_PENDING,
    )
    return _send_webhook(notification)


def queue_course_request_whatsapp_notification(enrollment_id):
    enrollment = Enrollment.objects.select_related("user", "course").get(pk=enrollment_id)
    return _create_and_send(
        enrollment=enrollment,
        message=build_authenticated_course_request_message(enrollment),
    )


def queue_live_class_request_whatsapp_notification(enrollment_id):
    enrollment = LiveClassEnrollment.objects.select_related("user", "live_class").get(pk=enrollment_id)
    return _create_and_send(
        live_class_enrollment=enrollment,
        message=build_authenticated_live_class_request_message(enrollment),
    )


def notify_after_commit(callback, object_id):
    def _run():
        try:
            callback(object_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Enrollment request notification callback failed: %s", exc)

    transaction.on_commit(_run)
