"""Attendance API (``/api/attendance/``). Views map HTTP onto services/queries.

Every endpoint answers 403 ``feature_disabled`` while the ``attendance``
switch is off. Exports use ``?export=csv`` (``?format=`` is DRF's renderer
switch).
"""

from __future__ import annotations

from django.http import HttpResponse
from django.utils import timezone
from rest_framework import permissions
from rest_framework.views import APIView

from apps.core.errors import PermissionDenied, ValidationFailed
from config.response import api_response
from config.throttling import ClientIpUserRateThrottle

from . import access, presence, queries, services
from .models import AttendancePolicy
from .serializers import OverrideSerializer, PolicySerializer
from .throttles import (
    AttendancePresenceThrottle,
    AttendanceReadThrottle,
    AttendanceStaffThrottle,
    AttendanceWriteThrottle,
)


def _int_param(request, name, default=None, *, minimum=None, maximum=None):
    raw = request.query_params.get(name)
    if raw in (None, ""):
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValidationFailed(f"'{name}' must be a whole number.", details={name: ["Use a whole number."]}) from exc
    if minimum is not None and value < minimum:
        value = minimum
    if maximum is not None and value > maximum:
        value = maximum
    return value


def _wants_csv(request) -> bool:
    return str(request.query_params.get("export", "")).strip().lower() == "csv"


def csv_response(body: str, filename: str) -> HttpResponse:
    response = HttpResponse("﻿" + body, content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Cache-Control"] = "private, no-store"
    return response


def _private(response, max_age: int = 0):
    response["Cache-Control"] = f"private, max-age={int(max_age)}" if max_age else "private, no-store"
    return response


# --- presence ------------------------------------------------------------------------------
class PresenceView(APIView):
    """``POST`` once a minute while a live class page is open and visible."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, AttendancePresenceThrottle]

    def post(self, request, session_id):
        access.require_enabled()
        result = presence.ping(int(session_id), request.user)
        return api_response(
            success=True,
            message="Presence recorded." if result.counted else "Not counted.",
            data={**result.as_dict(), "interval_seconds": 60},
        )


class LeaveView(APIView):
    """``POST`` (or ``navigator.sendBeacon``) when the live page closes: stops the clock."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, AttendancePresenceThrottle]

    def post(self, request, session_id):
        access.require_enabled()
        result = presence.ping(int(session_id), request.user, kind="leave")
        return api_response(success=True, message="Left the class.", data=result.as_dict())


# --- student --------------------------------------------------------------------------------
class MySummaryView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, AttendanceReadThrottle]

    def get(self, request):
        access.require_enabled()
        return _private(api_response(success=True, message="Attendance summary.", data=queries.student_summary(request.user)), 15)


class MyClassesView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, AttendanceReadThrottle]

    def get(self, request):
        access.require_enabled()
        data = queries.student_classes(
            request.user,
            course_id=_int_param(request, "course", minimum=1),
            status=str(request.query_params.get("status", "") or "").strip().lower() or None,
            page=_int_param(request, "page", 1, minimum=1),
            page_size=_int_param(request, "page_size", 25, minimum=1, maximum=queries.MAX_PAGE_SIZE),
        )
        return _private(api_response(success=True, message="Attendance by class.", data=data), 15)


# --- staff / instructors ---------------------------------------------------------------------------
class _StaffView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, AttendanceStaffThrottle]

    def scope(self, request):
        access.require_enabled()
        return access.staff_scope(request.user)


class StaffCoursesView(_StaffView):
    """Batches the viewer can report on (filter options)."""

    def get(self, request):
        from apps.courses.models import Course

        scope = self.scope(request)
        courses = Course.objects.all() if scope is access.ALL else Course.objects.filter(pk__in=sorted(scope))
        data = [
            {"id": row["id"], "title": row["title"], "batch": row["batch"] or ""}
            for row in courses.order_by("title", "id").values("id", "title", "batch")[:500]
        ]
        return _private(api_response(success=True, message="Batches.", data={"courses": data, "is_staff": scope is access.ALL}))


class StaffSessionsView(_StaffView):
    def get(self, request):
        scope = self.scope(request)
        data = queries.staff_sessions(
            scope,
            course_id=_int_param(request, "course", minimum=1),
            day_from=request.query_params.get("from"),
            day_to=request.query_params.get("to"),
            short_only=str(request.query_params.get("short", "")).lower() in {"1", "true", "yes"},
            page=_int_param(request, "page", 1, minimum=1),
            page_size=_int_param(request, "page_size", 25, minimum=1, maximum=queries.MAX_PAGE_SIZE),
        )
        return _private(api_response(success=True, message="Classes.", data=data))


class StaffRosterView(_StaffView):
    def get(self, request, session_id):
        scope = self.scope(request)
        data = queries.session_roster(int(session_id), scope)
        if _wants_csv(request):
            return csv_response(queries.roster_csv(data), f"attendance-session-{int(session_id)}.csv")
        return _private(api_response(success=True, message="Class roster.", data=data))


class StaffOverrideView(_StaffView):
    throttle_classes = [ClientIpUserRateThrottle, AttendanceWriteThrottle]

    def post(self, request, session_id):
        scope = self.scope(request)
        serializer = OverrideSerializer(data=request.data)
        if not serializer.is_valid():
            raise ValidationFailed("Please correct the highlighted fields.", details=serializer.errors)
        payload = serializer.validated_data
        record = services.override_status(
            session_ref_id=int(session_id),
            user_id=payload["user_id"],
            status=payload["status"],
            reason=payload["reason"],
            actor=request.user,
            scope=scope,
            request=request,
        )
        return api_response(
            success=True,
            message="Attendance updated.",
            data={
                "record_id": record.pk,
                "user_id": record.user_id,
                "session_id": record.session_ref_id,
                "status": record.status,
                "manual_override": record.manual_override,
                "override_reason": record.override_reason,
                "overridden_at": queries.iso(record.overridden_at),
            },
        )


class StaffMatrixView(_StaffView):
    def get(self, request):
        scope = self.scope(request)
        course_id = _int_param(request, "course", minimum=1)
        if not course_id:
            raise ValidationFailed("Pick a batch.", details={"course": ["Pick a batch."]})
        data = queries.batch_matrix(
            scope, course_id=course_id, day_from=request.query_params.get("from"), day_to=request.query_params.get("to")
        )
        if _wants_csv(request):
            return csv_response(queries.matrix_csv(data), f"attendance-batch-{course_id}.csv")
        return _private(api_response(success=True, message="Attendance matrix.", data=data))


class StaffLowAttendanceView(_StaffView):
    def get(self, request):
        scope = self.scope(request)
        data = queries.low_attendance(
            scope,
            course_id=_int_param(request, "course", minimum=1),
            threshold=_int_param(request, "threshold", None, minimum=1, maximum=100),
            min_classes=_int_param(request, "min_classes", 1, minimum=1, maximum=100),
        )
        if _wants_csv(request):
            stamp = timezone.localdate().isoformat()
            return csv_response(queries.low_attendance_csv(data), f"low-attendance-{stamp}.csv")
        return _private(api_response(success=True, message="Low attendance.", data=data))


class StaffPolicyView(_StaffView):
    """Read the attendance rule; staff may change it (audited by ``updated_by``)."""

    def get(self, request):
        self.scope(request)
        return _private(api_response(success=True, message="Attendance rule.", data=queries.rule_payload()))

    def patch(self, request):
        self.scope(request)
        if not access.is_staff(request.user):
            raise PermissionDenied("Only staff can change the attendance rule.", code="attendance_staff_only")
        serializer = PolicySerializer(data=request.data)
        if not serializer.is_valid():
            raise ValidationFailed("Please correct the highlighted fields.", details=serializer.errors)
        values = serializer.validated_data
        row = AttendancePolicy.current()
        if "present_min_minutes" in values:
            row.present_min_minutes = values["present_min_minutes"]
        if "short_session_percent" in values:
            row.short_session_ratio = round(values["short_session_percent"] / 100, 2)
        if "low_attendance_percent" in values:
            row.low_attendance_percent = values["low_attendance_percent"]
        row.updated_by = request.user
        row.full_clean()
        row.save()
        try:
            from config.audit import log_security_event

            log_security_event("attendance.policy_changed", request=request, **{k: int(v) for k, v in values.items()})
        except Exception:  # noqa: BLE001
            pass
        return api_response(success=True, message="Attendance rule saved.", data=queries.rule_payload(row))
