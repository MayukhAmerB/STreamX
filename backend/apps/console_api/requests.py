"""Enrolment and live-class requests for the Console Admin (plan §4.3, §4.6).

OWNER: WS-G. ``GET /api/admin/requests/`` lists both kinds in one list
(newest first); ``POST /api/admin/requests/actions/`` approves, rejects or
reopens ("Undo") one or many through :mod:`apps.courses.enrollment_actions`
(per-row ``save()``, audit, student notification; never
``queryset.update()``).

Row ids are ``"<kind>_<pk>"`` (``course_12``, ``live_class_4``) so one list
can hold both models. Viewing needs the model's Django ``view`` permission,
acting needs ``change`` (superusers have both).
"""

from __future__ import annotations

from django.db.models import Count, Q

from apps.core.errors import PermissionDenied, ValidationFailed
from apps.courses import enrollment_actions as actions
from apps.courses.models import Enrollment, LiveClassEnrollment

STATUSES = (actions.STATUS_PENDING, actions.STATUS_APPROVED, actions.STATUS_REJECTED)
KIND_ALL = "all"
KIND_FILTERS = (KIND_ALL, *actions.KINDS)
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100
MAX_BULK = 200
KIND_LABELS = {actions.KIND_COURSE: "Course access", actions.KIND_LIVE_CLASS: "Live class"}


def row_id(kind: str, pk: int) -> str:
    return f"{kind}_{pk}"


def parse_row_id(value) -> tuple[str, int]:
    text = str(value or "")
    kind, _, pk = text.rpartition("_")
    if kind not in actions.KINDS or not pk.isdigit():
        raise ValidationFailed(details={"ids": [f"Unknown request {text!r}."]})
    return kind, int(pk)


def _queryset(kind: str):
    if kind == actions.KIND_COURSE:
        return Enrollment.objects.select_related("user", "course"), "enrolled_at"
    return LiveClassEnrollment.objects.select_related("user", "live_class"), "created_at"


def _serialize(kind: str, obj, viewer) -> dict:
    target = obj.course if kind == actions.KIND_COURSE else obj.live_class
    user = obj.user
    requested_at = obj.enrolled_at if kind == actions.KIND_COURSE else obj.created_at
    admin_path = "courses/enrollment" if kind == actions.KIND_COURSE else "courses/liveclassenrollment"
    return {
        "id": row_id(kind, obj.pk),
        "pk": obj.pk,
        "kind": kind,
        "kind_label": KIND_LABELS[kind],
        "status": actions.status_of(kind, obj),
        "requested_at": requested_at.isoformat() if requested_at else None,
        "student": {
            "id": user.pk,
            "name": user.full_name or user.email,
            "email": user.email,
            "phone": user.phone_number or "",
        },
        "target": {"id": target.pk, "title": target.title},
        "can_change": actions.can_change(viewer, kind),
        "back_office_href": f"/admin/{admin_path}/{obj.pk}/change/",
    }


def _status_counts(kind: str) -> dict:
    spec_field = "payment_status" if kind == actions.KIND_COURSE else "status"
    model = actions.model_for(kind)
    aggregates = {
        status: Count("pk", filter=Q(**{spec_field: actions.db_status(kind, status)})) for status in STATUSES
    }
    return model.objects.aggregate(**aggregates)


def visible_kinds(user, kind: str = KIND_ALL) -> list[str]:
    kinds = actions.KINDS if kind == KIND_ALL else (kind,)
    return [item for item in kinds if actions.can_view(user, item)]


def list_requests(user, *, status: str = "pending", kind: str = KIND_ALL, q: str = "", page: int = 1, page_size: int = DEFAULT_PAGE_SIZE) -> dict:
    status = status if status in STATUSES else actions.STATUS_PENDING
    kind = kind if kind in KIND_FILTERS else KIND_ALL
    page = max(1, int(page or 1))
    page_size = max(1, min(MAX_PAGE_SIZE, int(page_size or DEFAULT_PAGE_SIZE)))
    query = " ".join(str(q or "").split())[:100]

    kinds = visible_kinds(user, kind)
    counts = {item: 0 for item in STATUSES}
    by_kind = {}
    for item in visible_kinds(user):
        item_counts = _status_counts(item)
        by_kind[item] = item_counts.get(actions.STATUS_PENDING, 0)
        if item in kinds:
            for word in STATUSES:
                counts[word] += int(item_counts.get(word) or 0)

    window = page * page_size
    merged = []
    total = 0
    for item in kinds:
        queryset, date_field = _queryset(item)
        field = "payment_status" if item == actions.KIND_COURSE else "status"
        queryset = queryset.filter(**{field: actions.db_status(item, status)})
        if query:
            target = "course__title" if item == actions.KIND_COURSE else "live_class__title"
            queryset = queryset.filter(
                Q(user__email__icontains=query) | Q(user__full_name__icontains=query) | Q(**{f"{target}__icontains": query})
            )
        total += queryset.count()
        oldest_first = status == actions.STATUS_PENDING
        ordering = (date_field, "pk") if oldest_first else (f"-{date_field}", "-pk")
        for obj in queryset.order_by(*ordering)[:window]:
            merged.append((getattr(obj, date_field), item, obj))
    pending = status == actions.STATUS_PENDING
    merged.sort(key=lambda entry: (entry[0], entry[2].pk), reverse=not pending)
    page_rows = merged[(page - 1) * page_size : window]
    return {
        "results": [_serialize(item, obj, user) for _when, item, obj in page_rows],
        "count": total,
        "page": page,
        "page_size": page_size,
        "status": status,
        "kind": kind,
        "q": query,
        "counts": counts,
        "pending_by_kind": by_kind,
        "kinds": [{"key": item, "label": KIND_LABELS[item]} for item in visible_kinds(user)],
    }


def act(user, *, ids, action: str, request=None) -> dict:
    """Apply ``action`` to rows ``ids`` (``kind_pk`` strings). Returns the
    rows' new state and how many changed."""
    if action not in actions.ACTIONS:
        raise ValidationFailed(details={"action": ["Choose approve, reject or reopen."]})
    if not isinstance(ids, (list, tuple)) or not ids:
        raise ValidationFailed(details={"ids": ["Choose at least one request."]})
    if len(ids) > MAX_BULK:
        raise ValidationFailed(details={"ids": [f"Choose at most {MAX_BULK} requests at a time."]})
    parsed = [parse_row_id(value) for value in ids]
    for kind in {kind for kind, _pk in parsed}:
        if not actions.can_change(user, kind):
            raise PermissionDenied("You can't change these requests.", code="request_change_forbidden")
    results = []
    for kind, pk in parsed:
        results.extend(actions.apply_bulk(kind, [pk], action, by=user, request=request))
    return {
        "action": action,
        "changed": sum(1 for result in results if result.changed),
        "results": [
            {"id": row_id(result.kind, result.id), "status": result.status, "changed": result.changed} for result in results
        ],
        "missing": sorted(set(ids) - {row_id(result.kind, result.id) for result in results}),
    }
