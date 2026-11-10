"""Outbox handlers for notifications (autodiscovered by apps.core).

Reference adoption of the transactional outbox (Phase 0): web push for a new
notification is published by ``services.create_notification`` inside the
notification's transaction and delivered here by the async worker.
"""

from apps.core.outbox import outbox_handler

WEB_PUSH_EVENT = "notifications.web_push"


@outbox_handler(WEB_PUSH_EVENT, max_attempts=3)
def deliver_web_push(event):
    """Idempotent: recipients already pushed (``pushed_at`` set) are skipped,
    so a redelivery after a crash never pushes the same user twice."""
    from .models import Notification, NotificationRecipient
    from .services import send_push_for_notification

    payload = event.payload or {}
    notification = Notification.objects.filter(pk=payload.get("notification_id")).first()
    if notification is None:
        return  # deleted since publish: nothing left to deliver
    pending_user_ids = list(
        NotificationRecipient.objects.filter(
            notification=notification,
            user_id__in=list(payload.get("user_ids") or []),
            pushed_at__isnull=True,
        ).values_list("user_id", flat=True)
    )
    if pending_user_ids:
        send_push_for_notification(notification, pending_user_ids)
