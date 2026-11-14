"""Calendar API (``/api/calendar/``): student calendar, iCalendar feed, staff
schedules with preview, and the public "Live classes" list."""

from __future__ import annotations

from django.core.cache import cache
from django.db import transaction
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import permissions
from rest_framework.views import APIView

from apps.core.errors import NotFound, PermissionDenied, ValidationFailed
from config.response import api_response
from config.throttling import ClientIpUserRateThrottle

from . import access, calendar_queries, ics, scheduling
from .models import CalendarFeedToken, ClassSchedule, ScheduledClass, ScheduleException
from .serializers import ClassScheduleSerializer, ExceptionSerializer, build_schedule, validate_exception_model
from .signals import EVENT_MATERIALIZE_SCHEDULE
from .throttles import (
    AttendanceReadThrottle,
    AttendanceStaffThrottle,
    AttendanceWriteThrottle,
    CalendarFeedThrottle,
    CalendarPublicThrottle,
)

PUBLIC_CACHE_KEY = "calendar:public-upcoming:v1:{limit}"
PUBLIC_CACHE_SECONDS = 60


def _invalid(serializer):
    raise ValidationFailed("Please correct the highlighted fields.", details=serializer.errors)


def _private(response, max_age: int = 0):
    response["Cache-Control"] = f"private, max-age={int(max_age)}" if max_age else "private, no-store"
    return response


# --- student ------------------------------------------------------------------------------
class MyEventsView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, AttendanceReadThrottle]

    def get(self, request):
        access.require_enabled()
        start, end = calendar_queries.parse_range(request.query_params.get("from"), request.query_params.get("to"))
        events = calendar_queries.student_events(request.user, start, end)
        return _private(
            api_response(
                success=True,
                message="Your classes.",
                data={
                    "from": start.isoformat(),
                    "to": end.isoformat(),
                    "timezone": "Asia/Kolkata",
                    "events": [calendar_queries.serialize_event(event) for event in events],
                },
            ),
            15,
        )


def _feed_payload(request, feed: CalendarFeedToken | None) -> dict:
    if feed is None or not feed.active:
        return {"active": False, "url": None, "webcal_url": None, "created_at": None, "last_accessed_at": None}
    token = calendar_queries.feed_token(feed)
    url = request.build_absolute_uri(f"/api/calendar/feed/{token}.ics")
    webcal = "webcal://" + url.split("://", 1)[-1]
    return {
        "active": True,
        "url": url,
        "webcal_url": webcal,
        "google_url": "https://calendar.google.com/calendar/render?cid=" + webcal,
        "created_at": feed.created_at.isoformat(),
        "last_accessed_at": feed.last_accessed_at.isoformat() if feed.last_accessed_at else None,
    }


class MyFeedView(APIView):
    """GET the subscription link, POST to create / replace it, DELETE to revoke it."""

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, AttendanceWriteThrottle]

    def get_throttles(self):
        if self.request.method.upper() == "GET":
            return [ClientIpUserRateThrottle(), AttendanceReadThrottle()]
        return super().get_throttles()

    def get(self, request):
        access.require_enabled()
        feed = CalendarFeedToken.objects.filter(user=request.user).first()
        return _private(api_response(success=True, message="Calendar feed.", data=_feed_payload(request, feed)))

    def post(self, request):
        access.require_enabled()
        feed, _created = CalendarFeedToken.objects.get_or_create(user=request.user)
        from .models import _new_nonce

        feed.nonce = _new_nonce()  # a new link always: older links stop working
        feed.revoked_at = None
        feed.created_at = timezone.now()
        feed.last_accessed_at = None
        feed.save()
        return _private(api_response(success=True, message="Calendar link ready.", data=_feed_payload(request, feed)))

    def delete(self, request):
        access.require_enabled()
        CalendarFeedToken.objects.filter(user=request.user).update(revoked_at=timezone.now(), nonce="")
        return _private(api_response(success=True, message="Calendar link turned off.", data=_feed_payload(request, None)))


class FeedView(APIView):
    """The personal ``.ics`` feed (no sign-in: the signed token is the credential)."""

    permission_classes = [permissions.AllowAny]
    authentication_classes = []
    throttle_classes = [CalendarFeedThrottle]

    def get(self, request, token):
        if not access.enabled():
            raise NotFound("Calendar not found.", code="calendar_feed_not_found")
        feed = calendar_queries.resolve_feed_token(token)
        if feed is None:
            raise NotFound("Calendar not found.", code="calendar_feed_not_found")
        from datetime import timedelta

        from . import conf

        now = timezone.now()
        start = now - timedelta(days=conf.calendar_feed_past_days())
        end = now + timedelta(days=conf.calendar_feed_future_days())
        events = calendar_queries.student_events(feed.user, start, end, now=now)
        body = ics.calendar(calendar_queries.ics_events(events), now=now)
        if feed.last_accessed_at is None or (now - feed.last_accessed_at).total_seconds() > 3600:
            CalendarFeedToken.objects.filter(pk=feed.pk).update(last_accessed_at=now)
        response = HttpResponse(body, content_type="text/calendar; charset=utf-8")
        response["Content-Disposition"] = 'inline; filename="alsyed-classes.ics"'
        response["Cache-Control"] = "private, max-age=300"
        response["X-Robots-Tag"] = "noindex"
        response["Referrer-Policy"] = "no-referrer"
        return response


class PublicUpcomingView(APIView):
    """Upcoming live classes for the public landing page (cached 60 s)."""

    permission_classes = [permissions.AllowAny]
    authentication_classes = []
    throttle_classes = [CalendarPublicThrottle]

    def get(self, request):
        try:
            limit = max(1, min(50, int(request.query_params.get("limit", 12))))
        except (TypeError, ValueError):
            limit = 12
        if not access.enabled():
            data = []
        else:
            key = PUBLIC_CACHE_KEY.format(limit=limit)
            data = cache.get(key)
            if data is None:
                data = calendar_queries.public_upcoming(limit=limit)
                cache.set(key, data, timeout=PUBLIC_CACHE_SECONDS)
        response = api_response(success=True, message="Upcoming live classes.", data={"events": data, "timezone": "Asia/Kolkata"})
        response["Cache-Control"] = f"public, max-age={PUBLIC_CACHE_SECONDS}"
        return response


# --- staff ------------------------------------------------------------------------------------------
class _StaffView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, AttendanceStaffThrottle]

    def scope(self, request):
        access.require_enabled()
        return access.staff_scope(request.user)


class StaffEventsView(_StaffView):
    def get(self, request):
        scope = self.scope(request)
        start, end = calendar_queries.parse_range(request.query_params.get("from"), request.query_params.get("to"))

        def _int(name):
            raw = request.query_params.get(name)
            return int(raw) if raw and str(raw).isdigit() else None

        events = calendar_queries.staff_events(scope, start, end, course_id=_int("course"), host_id=_int("host"))
        return _private(
            api_response(
                success=True,
                message="Class calendar.",
                data={
                    "from": start.isoformat(),
                    "to": end.isoformat(),
                    "timezone": "Asia/Kolkata",
                    "events": [calendar_queries.serialize_event(event) for event in events],
                },
            )
        )


class StaffOptionsView(_StaffView):
    """Courses, live classes and hosts the viewer may schedule."""

    def get(self, request):
        from django.contrib.auth import get_user_model

        from apps.courses.models import Course, LiveClass

        scope = self.scope(request)
        courses = Course.objects.all() if scope is access.ALL else Course.objects.filter(pk__in=sorted(scope))
        course_rows = list(courses.order_by("title", "id").values("id", "title", "batch")[:500])
        course_ids = [row["id"] for row in course_rows]
        live_classes = list(
            LiveClass.objects.filter(linked_course_id__in=course_ids)
            .order_by("title", "id")
            .values("id", "title", "linked_course_id", "class_duration_minutes", "is_active")[:1000]
        )
        user_model = get_user_model()
        if scope is access.ALL:
            hosts = user_model.objects.filter(is_active=True).filter(is_staff=True) | user_model.objects.filter(
                is_active=True, role="instructor"
            )
            host_rows = list(hosts.distinct().order_by("full_name", "id").values("id", "full_name", "email")[:300])
        else:
            host_rows = [{"id": request.user.pk, "full_name": request.user.full_name, "email": request.user.email}]
        return _private(
            api_response(
                success=True,
                message="Scheduling options.",
                data={
                    "courses": [{"id": r["id"], "title": r["title"], "batch": r["batch"] or ""} for r in course_rows],
                    "live_classes": [
                        {
                            "id": r["id"],
                            "title": r["title"],
                            "course_id": r["linked_course_id"],
                            "duration_minutes": r["class_duration_minutes"],
                            "is_active": r["is_active"],
                        }
                        for r in live_classes
                    ],
                    "hosts": [{"id": r["id"], "name": (r["full_name"] or "").strip() or r["email"]} for r in host_rows],
                    "is_staff": scope is access.ALL,
                    "timezone": "Asia/Kolkata",
                },
            )
        )


def schedule_payload(schedule: ClassSchedule, *, with_occurrences: bool = True) -> dict:
    data = {
        "id": schedule.pk,
        "course": {"id": schedule.course_id, "title": schedule.course.title, "batch": schedule.course.batch or ""},
        "live_class": {"id": schedule.live_class_id, "title": schedule.live_class.title},
        "name": schedule.name,
        "title_pattern": schedule.title_pattern,
        "start_date": schedule.start_date.isoformat(),
        "end_date": schedule.end_date.isoformat(),
        "weekdays": list(schedule.weekdays or []),
        "start_time": schedule.start_time.strftime("%H:%M"),
        "duration_minutes": schedule.duration_minutes,
        "timezone": schedule.timezone,
        "host": {"id": schedule.host_id, "name": (schedule.host.full_name or "").strip() or schedule.host.email},
        "session_type": schedule.session_type,
        "stream_service": schedule.stream_service,
        "description": schedule.description,
        "is_active": schedule.is_active,
        "version": schedule.version,
        "last_materialized_at": schedule.last_materialized_at.isoformat() if schedule.last_materialized_at else None,
        "exceptions": [
            {
                "id": row.pk,
                "kind": row.kind,
                "date": row.date.isoformat(),
                "new_start": row.new_start.isoformat() if row.new_start else None,
                "duration_minutes": row.duration_minutes,
                "title": row.title,
                "note": row.note,
            }
            for row in schedule.exceptions.all()
        ],
    }
    if with_occurrences:
        occurrences = scheduling.generate_occurrences(
            scheduling.spec_from_schedule(schedule), scheduling.exceptions_from_rows(schedule.exceptions.all())
        )
        data["occurrence_count"] = sum(1 for occ in occurrences if occ.status == ScheduledClass.STATUS_SCHEDULED)
        now = timezone.now()
        data["next_occurrences"] = [occ.as_dict(schedule.tz) for occ in occurrences if occ.ends_at > now][:10]
    return data


def _resolve_host(request, scope, host_id):
    from django.contrib.auth import get_user_model

    from apps.users import teaching

    if not host_id or int(host_id) == request.user.pk:
        return request.user
    if scope is not access.ALL:
        raise PermissionDenied("Instructors can only schedule classes they host.", code="calendar_host_forbidden")
    host = get_user_model().objects.filter(pk=host_id, is_active=True).first()
    if host is None or not (teaching.is_staff(host) or teaching.has_instructor_role(host)):
        raise ValidationFailed("Pick a staff or instructor account as host.", details={"host": ["Not a teacher."]})
    return host


def _publish_materialize(schedule: ClassSchedule, *, notify: bool) -> None:
    from apps.core.outbox import publish

    publish(
        EVENT_MATERIALIZE_SCHEDULE,
        {"schedule_id": schedule.pk, "notify": bool(notify), "version": schedule.version},
        dedupe_key=f"cal-sched:{schedule.pk}:v{schedule.version}",
    )


def _exception_rows(schedule, items, actor) -> list[ScheduleException]:
    rows = []
    for item in items or []:
        row = ScheduleException(
            schedule=schedule,
            kind=item["kind"],
            date=item["date"],
            new_start=item.get("new_start"),
            duration_minutes=item.get("duration_minutes"),
            title=item.get("title", ""),
            note=item.get("note", ""),
            created_by=actor if getattr(actor, "pk", None) else None,
        )
        validate_exception_model(row)
        rows.append(row)
    return rows


class StaffSchedulesView(_StaffView):
    def get(self, request):
        scope = self.scope(request)
        queryset = ClassSchedule.objects.select_related("course", "live_class", "host").prefetch_related("exceptions")
        if scope is not access.ALL:
            queryset = queryset.filter(course_id__in=sorted(scope))
        course = request.query_params.get("course")
        if course and str(course).isdigit():
            queryset = queryset.filter(course_id=int(course))
        data = [schedule_payload(row, with_occurrences=False) for row in queryset.order_by("-is_active", "-start_date", "-id")[:200]]
        return _private(api_response(success=True, message="Schedules.", data={"schedules": data}))

    def post(self, request):
        scope = self.scope(request)
        serializer = ClassScheduleSerializer(data=request.data)
        if not serializer.is_valid():
            _invalid(serializer)
        data = serializer.validated_data
        access.require_course_in_scope(scope, data["course"])
        schedule = build_schedule(data)
        schedule.host = _resolve_host(request, scope, data.get("host"))
        schedule.created_by = request.user
        with transaction.atomic():
            schedule.save()
            rows = _exception_rows(schedule, data.get("exceptions"), request.user)
            ScheduleException.objects.bulk_create(rows)
            _publish_materialize(schedule, notify=True)
        schedule = ClassSchedule.objects.select_related("course", "live_class", "host").get(pk=schedule.pk)
        return api_response(success=True, message="Schedule saved.", data=schedule_payload(schedule), status_code=201)


class StaffSchedulePreviewView(_StaffView):
    """The dates a schedule would create, before saving (nothing is written)."""

    def post(self, request):
        scope = self.scope(request)
        serializer = ClassScheduleSerializer(data=request.data)
        if not serializer.is_valid():
            _invalid(serializer)
        data = serializer.validated_data
        access.require_course_in_scope(scope, data["course"])
        schedule = build_schedule(data)
        spec = scheduling.spec_from_schedule(schedule)
        exceptions = [
            scheduling.ExceptionSpec(
                kind=item["kind"],
                date=item["date"],
                new_start=item.get("new_start"),
                duration_minutes=item.get("duration_minutes"),
                title=item.get("title", ""),
                note=item.get("note", ""),
            )
            for item in data.get("exceptions") or []
        ]
        occurrences = scheduling.generate_occurrences(spec, exceptions)
        return api_response(
            success=True,
            message="Preview.",
            data={
                "timezone": schedule.timezone,
                "count": sum(1 for occ in occurrences if occ.status == ScheduledClass.STATUS_SCHEDULED),
                "cancelled": sum(1 for occ in occurrences if occ.status == ScheduledClass.STATUS_CANCELLED),
                "occurrences": [occ.as_dict(schedule.tz) for occ in occurrences],
                "truncated": len(occurrences) >= scheduling.conf.max_schedule_occurrences(),
            },
        )


class StaffScheduleDetailView(_StaffView):
    def _get(self, request, schedule_id):
        scope = self.scope(request)
        schedule = (
            ClassSchedule.objects.select_related("course", "live_class", "host")
            .prefetch_related("exceptions")
            .filter(pk=schedule_id)
            .first()
        )
        if schedule is None:
            raise NotFound("Schedule not found.", code="calendar_schedule_not_found")
        access.require_course_in_scope(scope, schedule.course_id)
        return scope, schedule

    def get(self, request, schedule_id):
        _scope, schedule = self._get(request, schedule_id)
        return _private(api_response(success=True, message="Schedule.", data=schedule_payload(schedule)))

    def patch(self, request, schedule_id):
        scope, schedule = self._get(request, schedule_id)
        current = schedule_payload(schedule, with_occurrences=False)
        merged = {
            "course": schedule.course_id,
            "live_class": schedule.live_class_id,
            **{key: current[key] for key in (
                "name", "title_pattern", "start_date", "end_date", "weekdays", "start_time",
                "duration_minutes", "timezone", "session_type", "stream_service", "description", "is_active",
            )},
            "host": schedule.host_id,
        }
        incoming = {key: value for key, value in dict(request.data).items() if key != "exceptions"}
        merged.update(incoming)
        serializer = ClassScheduleSerializer(data=merged)
        if not serializer.is_valid():
            _invalid(serializer)
        data = serializer.validated_data
        access.require_course_in_scope(scope, data["course"])
        schedule = build_schedule(data, instance=schedule)
        if "host" in incoming:
            schedule.host = _resolve_host(request, scope, data.get("host"))
        schedule.version = int(schedule.version or 1) + 1
        with transaction.atomic():
            schedule.save()
            _publish_materialize(schedule, notify=True)
        schedule = ClassSchedule.objects.select_related("course", "live_class", "host").get(pk=schedule.pk)
        return api_response(success=True, message="Schedule updated.", data=schedule_payload(schedule))

    def delete(self, request, schedule_id):
        """Pauses the schedule: upcoming classes are cancelled, history is kept."""
        _scope, schedule = self._get(request, schedule_id)
        schedule.is_active = False
        schedule.version = int(schedule.version or 1) + 1
        with transaction.atomic():
            schedule.save(update_fields=["is_active", "version", "updated_at"])
            _publish_materialize(schedule, notify=True)
        return api_response(success=True, message="Schedule paused.", data={"id": schedule.pk, "is_active": False})


class StaffScheduleExceptionsView(_StaffView):
    def post(self, request, schedule_id):
        scope = self.scope(request)
        schedule = ClassSchedule.objects.select_related("course", "live_class", "host").filter(pk=schedule_id).first()
        if schedule is None:
            raise NotFound("Schedule not found.", code="calendar_schedule_not_found")
        access.require_course_in_scope(scope, schedule.course_id)
        serializer = ExceptionSerializer(data=request.data)
        if not serializer.is_valid():
            _invalid(serializer)
        with transaction.atomic():
            rows = _exception_rows(schedule, [serializer.validated_data], request.user)
            row = rows[0]
            if row.kind != ScheduleException.KIND_EXTRA:
                ScheduleException.objects.filter(schedule=schedule, date=row.date).exclude(
                    kind=ScheduleException.KIND_EXTRA
                ).delete()  # one change per regular date: the latest wins
            row.save()
            schedule.version = int(schedule.version or 1) + 1
            schedule.save(update_fields=["version", "updated_at"])
            _publish_materialize(schedule, notify=True)
        schedule = ClassSchedule.objects.select_related("course", "live_class", "host").get(pk=schedule.pk)
        return api_response(success=True, message="Change saved.", data=schedule_payload(schedule), status_code=201)


class StaffExceptionDetailView(_StaffView):
    def delete(self, request, exception_id):
        scope = self.scope(request)
        row = ScheduleException.objects.select_related("schedule").filter(pk=exception_id).first()
        if row is None:
            raise NotFound("Change not found.", code="calendar_exception_not_found")
        schedule = row.schedule
        access.require_course_in_scope(scope, schedule.course_id)
        with transaction.atomic():
            row.delete()
            schedule.version = int(schedule.version or 1) + 1
            schedule.save(update_fields=["version", "updated_at"])
            _publish_materialize(schedule, notify=True)
        return api_response(success=True, message="Change removed.", data={"id": int(exception_id)})
