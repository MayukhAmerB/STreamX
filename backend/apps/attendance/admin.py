"""Django admin for attendance and the class calendar.

Attendance rows are read-only here: status changes go through the audited
service (``services.override_status``), also from the admin actions below.
Schedules are edited here or in the Console; saving one re-materialises its
upcoming classes through the outbox.
"""

from django.contrib import admin, messages
from django.db import transaction

from apps.core.errors import DomainError

from . import services
from .models import (
    AttendanceAudit,
    AttendanceFlushLog,
    AttendancePolicy,
    AttendanceRecord,
    CalendarFeedToken,
    ClassSchedule,
    ScheduledClass,
    ScheduleException,
    SessionAttendance,
)

ADMIN_REASON = "Changed in the Django admin."


class ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(AttendancePolicy)
class AttendancePolicyAdmin(admin.ModelAdmin):
    list_display = ("__str__", "present_min_minutes", "short_session_ratio", "low_attendance_percent", "updated_at", "updated_by")
    readonly_fields = ("updated_at", "updated_by")

    def has_add_permission(self, request):
        return not AttendancePolicy.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False

    def changelist_view(self, request, extra_context=None):
        AttendancePolicy.current()  # always one row to edit
        return super().changelist_view(request, extra_context)

    def save_model(self, request, obj, form, change):
        obj.updated_by = request.user
        super().save_model(request, obj, form, change)


@admin.register(SessionAttendance)
class SessionAttendanceAdmin(ReadOnlyAdmin):
    list_display = (
        "session_ref_id",
        "title",
        "course",
        "class_start",
        "on_air_seconds",
        "short_session",
        "present_count",
        "partial_count",
        "absent_count",
        "excused_count",
        "finalized_at",
    )
    list_filter = ("short_session", ("class_start", admin.DateFieldListFilter))
    search_fields = ("title", "session_ref_id")
    list_select_related = ("course",)
    date_hierarchy = "class_start"
    actions = ["refinalize"]

    def has_change_permission(self, request, obj=None):
        return obj is None and request.user.has_perm("attendance.change_sessionattendance")

    @admin.action(description="Re-run finalisation (idempotent; staff overrides are kept)")
    def refinalize(self, request, queryset):
        done = 0
        for row in queryset[:50]:
            if services.finalize_session(row.session_ref_id) is not None:
                done += 1
        self.message_user(request, f"Re-finalised {done} class(es).", messages.SUCCESS)


class _OverrideActions:
    def _override(self, request, queryset, status):
        changed = 0
        for record in queryset.select_related("user")[:500]:
            try:
                services.override_status(
                    session_ref_id=record.session_ref_id,
                    user_id=record.user_id,
                    status=status,
                    reason=ADMIN_REASON,
                    actor=request.user,
                    request=request,
                )
                changed += 1
            except DomainError as exc:
                self.message_user(request, f"{record}: {exc.message}", messages.WARNING)
        self.message_user(request, f"Updated {changed} record(s).", messages.SUCCESS)


@admin.register(AttendanceRecord)
class AttendanceRecordAdmin(_OverrideActions, ReadOnlyAdmin):
    list_display = (
        "id",
        "user",
        "title",
        "course",
        "class_start",
        "status",
        "seconds_present",
        "on_air_seconds",
        "percent",
        "manual_override",
        "source",
    )
    list_filter = ("status", "manual_override", "source", ("class_start", admin.DateFieldListFilter))
    search_fields = ("user__email", "user__full_name", "title", "session_ref_id")
    raw_id_fields = ("user",)
    list_select_related = ("user", "course")
    date_hierarchy = "class_start"
    show_full_result_count = False
    actions = ["mark_excused", "mark_present", "reset_automatic"]

    def has_change_permission(self, request, obj=None):
        return obj is None and request.user.has_perm("attendance.change_attendancerecord")

    def get_readonly_fields(self, request, obj=None):
        return [field.name for field in self.model._meta.fields]

    @admin.action(description="Mark excused (audited)")
    def mark_excused(self, request, queryset):
        self._override(request, queryset, AttendanceRecord.STATUS_EXCUSED)

    @admin.action(description="Mark present (audited)")
    def mark_present(self, request, queryset):
        self._override(request, queryset, AttendanceRecord.STATUS_PRESENT)

    @admin.action(description="Back to the automatic status (audited)")
    def reset_automatic(self, request, queryset):
        self._override(request, queryset, "auto")


@admin.register(AttendanceAudit)
class AttendanceAuditAdmin(ReadOnlyAdmin):
    list_display = ("created_at", "record", "actor", "from_status", "to_status", "to_override", "reason")
    list_filter = ("to_status", ("created_at", admin.DateFieldListFilter))
    search_fields = ("record__user__email", "actor__email", "reason")
    list_select_related = ("record", "actor")
    date_hierarchy = "created_at"


@admin.register(AttendanceFlushLog)
class AttendanceFlushLogAdmin(ReadOnlyAdmin):
    list_display = ("created_at", "token", "rows")
    date_hierarchy = "created_at"


class ScheduleExceptionInline(admin.TabularInline):
    model = ScheduleException
    extra = 0
    fields = ("kind", "date", "new_start", "duration_minutes", "title", "note")


def _materialize_on_commit(schedule):
    def _publish():
        from apps.core.outbox import publish

        from .signals import EVENT_MATERIALIZE_SCHEDULE

        publish(
            EVENT_MATERIALIZE_SCHEDULE,
            {"schedule_id": schedule.pk, "notify": True, "version": schedule.version},
            dedupe_key=f"cal-sched:{schedule.pk}:v{schedule.version}",
        )

    transaction.on_commit(_publish)


@admin.register(ClassSchedule)
class ClassScheduleAdmin(admin.ModelAdmin):
    list_display = ("__str__", "course", "live_class", "weekdays", "start_time", "start_date", "end_date", "host", "is_active")
    list_filter = ("is_active", "session_type")
    search_fields = ("name", "course__title", "live_class__title")
    raw_id_fields = ("host", "created_by")
    list_select_related = ("course", "live_class", "host")
    readonly_fields = ("version", "created_at", "updated_at", "last_materialized_at")
    inlines = [ScheduleExceptionInline]

    def save_model(self, request, obj, form, change):
        if not obj.pk:
            obj.created_by = request.user
        else:
            obj.version = int(obj.version or 1) + 1
        super().save_model(request, obj, form, change)

    def save_related(self, request, form, formsets, change):
        super().save_related(request, form, formsets, change)
        _materialize_on_commit(form.instance)


@admin.register(ScheduledClass)
class ScheduledClassAdmin(ReadOnlyAdmin):
    list_display = ("title", "course", "starts_at", "ends_at", "status", "kind", "session", "manually_edited")
    list_filter = ("status", "kind", "manually_edited")
    search_fields = ("title", "occurrence_key", "course__title")
    list_select_related = ("course", "session")
    date_hierarchy = "starts_at"


@admin.register(CalendarFeedToken)
class CalendarFeedTokenAdmin(ReadOnlyAdmin):
    list_display = ("user", "created_at", "last_accessed_at", "revoked_at")
    search_fields = ("user__email",)
    raw_id_fields = ("user",)
    actions = ["revoke"]
    exclude = ("nonce",)

    def has_change_permission(self, request, obj=None):
        return obj is None and request.user.has_perm("attendance.change_calendarfeedtoken")

    @admin.action(description="Revoke selected calendar links")
    def revoke(self, request, queryset):
        from django.utils import timezone

        count = queryset.update(revoked_at=timezone.now(), nonce="")
        self.message_user(request, f"Revoked {count} calendar link(s).", messages.SUCCESS)


def _register_nav_groups():
    """Place the models in the admin's job-based navigation (no edit to enterprise_admin.py)."""
    try:
        from apps.users.templatetags.enterprise_admin import MODEL_JOBS
    except Exception:  # noqa: BLE001
        return
    for key, value in (
        ("attendance.attendancerecord", ("live", "Attendance")),
        ("attendance.sessionattendance", ("live", "Attendance by class")),
        ("attendance.classschedule", ("live", "Class schedules")),
        ("attendance.scheduledclass", ("live", "Class calendar")),
        ("attendance.attendancepolicy", ("settings", "Attendance rule")),
        ("attendance.attendanceaudit", ("system", "Attendance changes (audit)")),
        ("attendance.attendanceflushlog", ("system", "Attendance flushes")),
        ("attendance.calendarfeedtoken", ("system", "Calendar subscription links")),
    ):
        MODEL_JOBS.setdefault(key, value)


_register_nav_groups()
