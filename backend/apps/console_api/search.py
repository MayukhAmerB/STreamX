"""Command palette record search: ``GET /api/admin/search/?q=`` (plan §4.5).

OWNER: WS-G. Staff only; at least ``ADMIN_SEARCH_MIN_CHARS`` characters; at
most ``ADMIN_SEARCH_GROUP_LIMIT`` hits per group; ``icontains`` on a few
indexed/short fields per model. Groups (in this order): people, courses,
payments, classes, exams, recordings, report_tasks. A group is left out when
it has no hits or the viewer may not view its model.

Every hit is ``{id, title, subtitle, href}``; ``id`` is ``<group>_<pk>`` so
the palette can key and remember items across groups.
"""

from __future__ import annotations

import logging
from decimal import Decimal

from django.conf import settings
from django.db import DatabaseError
from django.db.models import Q

from .permissions import is_staff_user

logger = logging.getLogger(__name__)

GROUP_KEYS = ("people", "courses", "payments", "classes", "exams", "recordings", "report_tasks")
GROUP_LABELS = {
    "people": "People",
    "courses": "Courses",
    "payments": "Payments",
    "classes": "Classes",
    "exams": "Exams",
    "recordings": "Recordings",
    "report_tasks": "Report tasks",
}
MAX_QUERY_LENGTH = 100


def min_chars() -> int:
    return int(getattr(settings, "ADMIN_SEARCH_MIN_CHARS", 2))


def group_limit() -> int:
    return max(1, int(getattr(settings, "ADMIN_SEARCH_GROUP_LIMIT", 5)))


def _icontains(fields, q):
    condition = Q()
    for field in fields:
        condition |= Q(**{f"{field}__icontains": q})
    return condition


def _money(amount, currency) -> str:
    if amount is None:
        return ""
    value = Decimal(amount)
    text = f"{value:,.0f}" if value == value.to_integral() else f"{value:,.2f}"
    symbol = "₹" if (currency or "INR").upper() == "INR" else f"{currency} "
    return f"{symbol}{text}"


def _join(*parts) -> str:
    return " · ".join(str(part) for part in parts if part)


# ----------------------------------------------------------------- groups


def _people(user, q, limit):
    from django.contrib.auth import get_user_model

    if not user.has_perm("users.view_user"):
        return None
    User = get_user_model()
    rows = (
        User.objects.filter(_icontains(("email", "full_name", "phone_number"), q))
        .order_by("full_name", "pk")
        .values("pk", "email", "full_name", "role", "is_staff")[:limit]
    )
    items = []
    for row in rows:
        role = "Admin" if row["is_staff"] else ("Instructor" if row["role"] == "instructor" else "Student")
        items.append(
            {
                "id": f"user_{row['pk']}",
                "title": row["full_name"] or row["email"],
                "subtitle": _join(row["email"], role),
                "href": f"/admin/users/user/{row['pk']}/change/",
            }
        )
    return items


def _courses(user, q, limit):
    from apps.courses.models import Course

    rows = Course.objects.filter(title__icontains=q).order_by("title", "pk").values("pk", "title", "is_published")[:limit]
    return [
        {
            "id": f"course_{row['pk']}",
            "title": row["title"],
            "subtitle": "Published" if row["is_published"] else "Draft",
            "href": f"/console/admin/courses/{row['pk']}",
        }
        for row in rows
    ]


def _payments(user, q, limit):
    from apps.payments.models import Payment

    if not user.has_perm("payments.view_payment"):
        return None
    fields = ("razorpay_order_id", "razorpay_payment_id", "user_email_snapshot", "buyer_email", "invoice_number")
    rows = (
        Payment.objects.filter(_icontains(fields, q))
        .order_by("-created_at", "-pk")
        .values(
            "pk",
            "razorpay_order_id",
            "invoice_number",
            "user_email_snapshot",
            "buyer_email",
            "amount",
            "currency",
            "status",
            "course_title_snapshot",
        )[:limit]
    )
    status_labels = dict(Payment.STATUS_CHOICES)
    items = []
    for row in rows:
        reference = row["razorpay_order_id"] or row["invoice_number"] or f"#{row['pk']}"
        items.append(
            {
                "id": f"pay_{row['pk']}",
                "title": f"Order {reference}",
                "subtitle": _join(
                    row["user_email_snapshot"] or row["buyer_email"],
                    _money(row["amount"], row["currency"]),
                    status_labels.get(row["status"], row["status"]),
                ),
                "href": f"/admin/payments/payment/{row['pk']}/change/",
            }
        )
    return items


def _classes(user, q, limit):
    from apps.realtime.models import RealtimeSession

    rows = (
        RealtimeSession.objects.filter(title__icontains=q)
        .order_by("-created_at", "-pk")
        .values("pk", "title", "status", "session_type")[:limit]
    )
    statuses = dict(RealtimeSession.STATUS_CHOICES)
    types = dict(RealtimeSession.SESSION_TYPE_CHOICES)
    return [
        {
            "id": f"session_{row['pk']}",
            "title": row["title"],
            "subtitle": _join(types.get(row["session_type"], row["session_type"]), statuses.get(row["status"], row["status"])),
            "href": f"/console/admin/classes/{row['pk']}/studio",
        }
        for row in rows
    ]


def _exams(user, q, limit):
    from apps.ctf.models import CtfExam

    rows = (
        CtfExam.objects.filter(_icontains(("slug", "title"), q))
        .order_by("-opens_at", "-pk")
        .values("pk", "slug", "title", "status")[:limit]
    )
    statuses = dict(CtfExam.STATUS_CHOICES)
    return [
        {
            "id": f"exam_{row['pk']}",
            "title": row["title"],
            "subtitle": _join(row["slug"], statuses.get(row["status"], row["status"])),
            "href": f"/console/admin/exams/{row['slug']}",
        }
        for row in rows
    ]


def _recordings(user, q, limit):
    from apps.realtime.recording.models import ClassRecording

    rows = (
        ClassRecording.objects.filter(_icontains(("session__title", "lecture__title"), q))
        .order_by("-created_at", "-pk")
        .values("pk", "state", "session__title", "lecture__title")[:limit]
    )
    states = dict(ClassRecording.STATE_CHOICES)
    return [
        {
            "id": f"recording_{row['pk']}",
            "title": row["lecture__title"] or row["session__title"] or f"Recording #{row['pk']}",
            "subtitle": _join(row["session__title"] if row["lecture__title"] else "", states.get(row["state"], row["state"])),
            "href": f"/console/admin/recordings?open=cr_{row['pk']}",
        }
        for row in rows
    ]


def _report_tasks(user, q, limit):
    from apps.reports.models import ReportTask

    rows = (
        ReportTask.objects.filter(title__icontains=q)
        .order_by("-due_at", "-pk")
        .values("pk", "title", "status", "course__title")[:limit]
    )
    statuses = dict(ReportTask.STATUS_CHOICES)
    return [
        {
            "id": f"task_{row['pk']}",
            "title": row["title"],
            "subtitle": _join(row["course__title"], statuses.get(row["status"], row["status"])),
            "href": f"/console/admin/grading/tasks/{row['pk']}/edit",
        }
        for row in rows
    ]


_GROUPS = {
    "people": _people,
    "courses": _courses,
    "payments": _payments,
    "classes": _classes,
    "exams": _exams,
    "recordings": _recordings,
    "report_tasks": _report_tasks,
}


def search(user, q: str) -> dict:
    query = " ".join(str(q or "").split())[:MAX_QUERY_LENGTH]
    if not is_staff_user(user) or len(query) < min_chars():
        return {"q": query, "groups": []}
    limit = group_limit()
    groups = []
    for key in GROUP_KEYS:
        try:
            items = _GROUPS[key](user, query, limit)
        except DatabaseError:
            logger.exception("admin search group %s failed", key)
            items = None
        if items:
            groups.append({"key": key, "label": GROUP_LABELS[key], "items": items})
    return {"q": query, "groups": groups}
