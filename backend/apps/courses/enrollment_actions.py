"""Approve, reject or reopen enrolment and live-class requests (one service).

OWNER: WS-G (UI overhaul plan §4.6). Used by the Console Admin Requests page
(``apps.console_api.requests``) and by the Django back-office bulk actions
(WS-E), so both rooms behave the same:

* every row goes through ``Model.save()`` (signals and cache invalidation run;
  never ``queryset.update()``);
* each change is written to Django's ``LogEntry`` (the admin history and the
  Console Activity feed) and to the security audit log;
* the student gets an in-app notification when a request is approved or
  rejected (after commit, so a rolled-back change never notifies);
* re-applying the current status is a no-op that writes nothing.

``reopen`` puts a request back to pending: it is the "Undo" of the Console
toast, and is audited like the other actions.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from django.db import transaction
from django.utils import timezone

from config.audit import log_security_event

from .models import Enrollment, LiveClassEnrollment

logger = logging.getLogger(__name__)

KIND_COURSE = "course"
KIND_LIVE_CLASS = "live_class"
KINDS = (KIND_COURSE, KIND_LIVE_CLASS)

ACTION_APPROVE = "approve"
ACTION_REJECT = "reject"
ACTION_REOPEN = "reopen"
ACTIONS = (ACTION_APPROVE, ACTION_REJECT, ACTION_REOPEN)

# Request status vocabulary shared by both kinds (what the Console shows).
STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"

_SPEC = {
    KIND_COURSE: {
        "model": Enrollment,
        "field": "payment_status",
        "to_db": {
            STATUS_PENDING: Enrollment.STATUS_PENDING,
            STATUS_APPROVED: Enrollment.STATUS_PAID,
            STATUS_REJECTED: Enrollment.STATUS_FAILED,
        },
        "change_perm": "courses.change_enrollment",
        "view_perm": "courses.view_enrollment",
    },
    KIND_LIVE_CLASS: {
        "model": LiveClassEnrollment,
        "field": "status",
        "to_db": {
            STATUS_PENDING: LiveClassEnrollment.STATUS_PENDING,
            STATUS_APPROVED: LiveClassEnrollment.STATUS_APPROVED,
            STATUS_REJECTED: LiveClassEnrollment.STATUS_REJECTED,
        },
        "change_perm": "courses.change_liveclassenrollment",
        "view_perm": "courses.view_liveclassenrollment",
    },
}

_ACTION_TARGET = {
    ACTION_APPROVE: STATUS_APPROVED,
    ACTION_REJECT: STATUS_REJECTED,
    ACTION_REOPEN: STATUS_PENDING,
}


@dataclass(frozen=True)
class ActionResult:
    kind: str
    id: int
    status: str
    changed: bool


def model_for(kind: str):
    return _SPEC[kind]["model"]


def view_permission(kind: str) -> str:
    return _SPEC[kind]["view_perm"]


def change_permission(kind: str) -> str:
    return _SPEC[kind]["change_perm"]


def can_view(user, kind: str) -> bool:
    return bool(user and user.is_authenticated and user.has_perm(view_permission(kind)))


def can_change(user, kind: str) -> bool:
    return bool(user and user.is_authenticated and user.has_perm(change_permission(kind)))


def status_of(kind: str, obj) -> str:
    """The shared status word (pending / approved / rejected) of a request row."""
    raw = getattr(obj, _SPEC[kind]["field"])
    for word, db_value in _SPEC[kind]["to_db"].items():
        if db_value == raw:
            return word
    return str(raw)


def db_status(kind: str, status: str) -> str:
    return _SPEC[kind]["to_db"][status]


def _target_title(kind: str, obj) -> str:
    target = obj.course if kind == KIND_COURSE else obj.live_class
    return str(getattr(target, "title", "") or "")


def _log_entry(user, obj, message: str) -> None:
    from django.contrib.admin.models import CHANGE, LogEntry

    if not user or not getattr(user, "pk", None):
        return
    try:
        LogEntry.objects.log_actions(user.pk, [obj], CHANGE, change_message=message, single_object=True)
    except AttributeError:  # pragma: no cover - Django < 5.1
        from django.contrib.contenttypes.models import ContentType

        LogEntry.objects.log_action(
            user_id=user.pk,
            content_type_id=ContentType.objects.get_for_model(obj).pk,
            object_id=obj.pk,
            object_repr=str(obj)[:200],
            action_flag=CHANGE,
            change_message=message,
        )


def _notify_student(kind: str, obj, status: str, by) -> None:
    if status not in (STATUS_APPROVED, STATUS_REJECTED):
        return
    from apps.notifications.models import Notification
    from apps.notifications.services import create_notification

    title_text = _target_title(kind, obj) or ("your course" if kind == KIND_COURSE else "your live class")
    if status == STATUS_APPROVED:
        title = f"You're in: {title_text}"[:180]
        body = "Your access request was approved. It is ready in your Console."
        action_url = f"/learn/{obj.course_id}" if kind == KIND_COURSE else "/join-live"
    else:
        title = f"Request not approved: {title_text}"[:180]
        body = "Your access request was not approved this time. Contact us on WhatsApp if you think this is a mistake."
        action_url = "/console"
    stamp = timezone.now().strftime("%Y%m%d%H%M%S%f")
    event_key = f"enrollment-request:{kind}:{obj.pk}:{status}:{stamp}"

    def send():
        try:
            create_notification(
                kind=Notification.KIND_ANNOUNCEMENT,
                title=title,
                body=body,
                recipients=[obj.user_id],
                event_key=event_key,
                action_url=action_url,
                course=obj.course if kind == KIND_COURSE else None,
                live_class=obj.live_class if kind == KIND_LIVE_CLASS else None,
                created_by=by if getattr(by, "pk", None) else None,
            )
        except Exception:  # noqa: BLE001 - a notification never undoes the decision
            logger.exception("enrollment request notification failed (%s #%s)", kind, obj.pk)

    transaction.on_commit(send)


def set_status(kind: str, obj_id: int, action: str, *, by, request=None) -> ActionResult:
    """Apply ``action`` to one request. Returns what happened; raises
    ``DoesNotExist`` for an unknown id and ``ValueError`` for a bad kind/action."""
    if kind not in KINDS:
        raise ValueError(f"Unknown request kind {kind!r}.")
    if action not in ACTIONS:
        raise ValueError(f"Unknown action {action!r}.")
    spec = _SPEC[kind]
    target = _ACTION_TARGET[action]
    with transaction.atomic():
        related = ("user", "course") if kind == KIND_COURSE else ("user", "live_class")
        obj = spec["model"].objects.select_for_update(of=("self",)).select_related(*related).get(pk=obj_id)
        before = status_of(kind, obj)
        if before == target:
            return ActionResult(kind=kind, id=obj.pk, status=target, changed=False)
        setattr(obj, spec["field"], spec["to_db"][target])
        obj.save(update_fields=[spec["field"]])
        verb = {STATUS_APPROVED: "Approved", STATUS_REJECTED: "Rejected", STATUS_PENDING: "Reopened"}[target]
        _log_entry(by, obj, f"{verb} the access request (was {before}).")
        _notify_student(kind, obj, target, by)
    log_security_event(
        f"courses.enrollment_request_{action}",
        request=request,
        kind=kind,
        request_id_value=obj.pk,
        from_status=before,
        to_status=target,
    )
    _bump_attention()
    return ActionResult(kind=kind, id=obj.pk, status=target, changed=True)


def apply_bulk(kind: str, ids, action: str, *, by, request=None) -> list[ActionResult]:
    """One :func:`set_status` per row (each in its own transaction). Unknown
    ids are skipped. Used by the Console bulk bar and the Django actions."""
    results = []
    model = model_for(kind)
    for obj_id in ids:
        try:
            results.append(set_status(kind, int(obj_id), action, by=by, request=request))
        except (model.DoesNotExist, TypeError, ValueError):
            continue
    return results


def apply_to_queryset(kind: str, queryset, action: str, *, by, request=None) -> int:
    """Django admin action helper: returns how many rows actually changed."""
    ids = list(queryset.values_list("pk", flat=True))
    return sum(1 for result in apply_bulk(kind, ids, action, by=by, request=request) if result.changed)


def _bump_attention() -> None:
    try:
        from apps.console_api.attention import bump_version
    except Exception:  # pragma: no cover - console_api not installed
        return
    bump_version()
