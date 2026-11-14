"""Attendance (source of truth for live-class presence) and the class calendar.

Attendance
    ``AttendanceRecord``   one row per (session, student): seconds present while
                           the class was on air, status, manual override.
    ``SessionAttendance``  one row per finalised session: on-air time, the
                           threshold used, "short session" flag and counts.
    ``AttendanceAudit``    every manual status change (who, from, to, why).
    ``AttendancePolicy``   admin-editable thresholds (singleton).
    ``AttendanceFlushLog`` exactly-once marker for each write-behind batch.

Calendar
    ``ClassSchedule``      a batch's pre-decided timetable (weekdays, time,
                           duration, Asia/Kolkata) and its exceptions.
    ``ScheduledClass``     one materialised occurrence (the calendar entry),
                           linked to the RealtimeSession created for it.
    ``CalendarFeedToken``  a student's revocable iCalendar subscription.

Rows keep the realtime session id (``session_ref_id``) next to the nullable
FK, so attendance history survives a deleted session.
"""

from __future__ import annotations

import secrets
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone

from . import conf


class AttendancePolicy(models.Model):
    """Thresholds the finaliser uses (one row; created from settings on first read)."""

    present_min_minutes = models.PositiveIntegerField(
        default=40,
        help_text="Present = at least this many minutes in the LIVE class (recordings never count).",
    )
    short_session_ratio = models.DecimalField(
        max_digits=4,
        decimal_places=2,
        default=Decimal("0.80"),
        help_text=(
            "When the class itself was on air for less than the minutes above, present = at least this share "
            "of its on-air time (0.80 = 80 %). Such classes are flagged as short sessions for staff."
        ),
    )
    low_attendance_percent = models.PositiveIntegerField(
        default=75, help_text="Students below this attendance % appear on the follow-up list."
    )
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        verbose_name = "attendance policy"
        verbose_name_plural = "attendance policy"

    def __str__(self):
        return f"Present = {self.present_min_minutes}+ minutes live"

    def clean(self):
        super().clean()
        if not 1 <= int(self.present_min_minutes or 0) <= 600:
            raise ValidationError({"present_min_minutes": "Use 1 to 600 minutes."})
        ratio = float(self.short_session_ratio or 0)
        if not 0.05 <= ratio <= 1:
            raise ValidationError({"short_session_ratio": "Use a value between 0.05 and 1.00."})
        if not 1 <= int(self.low_attendance_percent or 0) <= 100:
            raise ValidationError({"low_attendance_percent": "Use 1 to 100."})

    @classmethod
    def current(cls) -> AttendancePolicy:
        row = cls.objects.order_by("pk").first()
        if row is None:
            row = cls.objects.create(
                present_min_minutes=conf.present_min_minutes(),
                short_session_ratio=round(conf.short_session_ratio(), 2),
                low_attendance_percent=conf.low_attendance_percent(),
            )
        return row


class AttendanceRecord(models.Model):
    STATUS_PRESENT = "present"
    STATUS_PARTIAL = "partial"
    STATUS_ABSENT = "absent"
    STATUS_EXCUSED = "excused"
    STATUS_CHOICES = [
        (STATUS_PRESENT, "Present"),
        (STATUS_PARTIAL, "Partial (joined, below the bar)"),
        (STATUS_ABSENT, "Absent"),
        (STATUS_EXCUSED, "Excused"),
    ]
    STATUSES = tuple(value for value, _label in STATUS_CHOICES)

    SOURCE_PRESENCE = "presence"
    SOURCE_JOIN = "join"
    SOURCE_ROSTER = "roster"
    SOURCE_MANUAL = "manual"
    SOURCE_CHOICES = [
        (SOURCE_PRESENCE, "Live presence pings"),
        (SOURCE_JOIN, "Join event"),
        (SOURCE_ROSTER, "Roster (never joined)"),
        (SOURCE_MANUAL, "Staff entry"),
    ]

    session = models.ForeignKey(
        "realtime.RealtimeSession",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="attendance_records",
    )
    session_ref_id = models.PositiveBigIntegerField(help_text="RealtimeSession id (kept if the session is deleted).")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="attendance_records")
    course = models.ForeignKey(
        "courses.Course", on_delete=models.SET_NULL, null=True, blank=True, related_name="attendance_records"
    )
    live_class = models.ForeignKey(
        "courses.LiveClass", on_delete=models.SET_NULL, null=True, blank=True, related_name="attendance_records"
    )
    title = models.CharField(max_length=255, blank=True, default="")
    class_start = models.DateTimeField(null=True, blank=True, help_text="When the class went on air.")
    first_joined_at = models.DateTimeField(null=True, blank=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)
    seconds_present = models.PositiveIntegerField(default=0, help_text="Seconds present while the class was on air.")
    on_air_seconds = models.PositiveIntegerField(default=0)
    percent = models.DecimalField(max_digits=5, decimal_places=1, default=0)
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=STATUS_ABSENT)
    source = models.CharField(max_length=12, choices=SOURCE_CHOICES, default=SOURCE_PRESENCE)
    manual_override = models.BooleanField(default=False)
    override_reason = models.CharField(max_length=300, blank=True, default="")
    overridden_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    overridden_at = models.DateTimeField(null=True, blank=True)
    finalized_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-class_start", "-id"]
        verbose_name = "attendance record"
        constraints = [
            models.UniqueConstraint(fields=["session_ref_id", "user"], name="att_record_session_user_uniq"),
        ]
        indexes = [
            models.Index(fields=["user", "class_start"], name="att_record_user_start_idx"),
            models.Index(fields=["course", "class_start"], name="att_record_course_start_idx"),
            models.Index(fields=["session_ref_id", "status"], name="att_record_session_status_idx"),
        ]

    def __str__(self):
        return f"user {self.user_id} in session {self.session_ref_id}: {self.status}"

    @property
    def minutes_present(self) -> int:
        return int(self.seconds_present or 0) // 60


class SessionAttendance(models.Model):
    session = models.ForeignKey(
        "realtime.RealtimeSession",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="attendance_summaries",
    )
    session_ref_id = models.PositiveBigIntegerField(unique=True)
    course = models.ForeignKey(
        "courses.Course", on_delete=models.SET_NULL, null=True, blank=True, related_name="attendance_sessions"
    )
    title = models.CharField(max_length=255, blank=True, default="")
    class_start = models.DateTimeField(null=True, blank=True)
    on_air_seconds = models.PositiveIntegerField(default=0)
    threshold_seconds = models.PositiveIntegerField(default=0)
    short_session = models.BooleanField(
        default=False, help_text="On air for less than the present minimum: present = share of on-air time."
    )
    roster_count = models.PositiveIntegerField(default=0)
    present_count = models.PositiveIntegerField(default=0)
    partial_count = models.PositiveIntegerField(default=0)
    absent_count = models.PositiveIntegerField(default=0)
    excused_count = models.PositiveIntegerField(default=0)
    finalized_at = models.DateTimeField(null=True, blank=True)
    finalize_count = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-class_start", "-id"]
        verbose_name = "session attendance"
        verbose_name_plural = "session attendance"
        indexes = [
            models.Index(fields=["course", "class_start"], name="att_session_course_start_idx"),
            models.Index(fields=["short_session", "class_start"], name="att_session_short_idx"),
        ]

    def __str__(self):
        return f"session {self.session_ref_id}: {self.present_count}/{self.roster_count} present"


class AttendanceAudit(models.Model):
    record = models.ForeignKey(AttendanceRecord, on_delete=models.CASCADE, related_name="audits")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    from_status = models.CharField(max_length=12, blank=True, default="")
    to_status = models.CharField(max_length=12)
    from_override = models.BooleanField(default=False)
    to_override = models.BooleanField(default=True)
    reason = models.CharField(max_length=300)
    ip_address = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "attendance change"
        indexes = [models.Index(fields=["created_at"], name="att_audit_created_idx")]

    def __str__(self):
        return f"{self.from_status or '-'} -> {self.to_status} by {self.actor_id}"


class AttendanceFlushLog(models.Model):
    token = models.CharField(max_length=64, unique=True)
    rows = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "attendance flush"

    def __str__(self):
        return f"{self.token} ({self.rows})"


# --- calendar -------------------------------------------------------------------------------
WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def validate_weekdays(value):
    if not isinstance(value, list) or not value:
        raise ValidationError("Pick at least one weekday.")
    for day in value:
        if not isinstance(day, int) or isinstance(day, bool) or not 0 <= day <= 6:
            raise ValidationError("Weekdays are numbers 0 (Monday) to 6 (Sunday).")


def validate_timezone_name(value):
    try:
        ZoneInfo(str(value))
    except Exception as exc:  # noqa: BLE001
        raise ValidationError("Unknown time zone.") from exc


class ClassSchedule(models.Model):
    SESSION_TYPE_CHOICES = [("meeting", "Meeting"), ("broadcasting", "Broadcasting")]
    STREAM_SERVICE_CHOICES = [("alsyed_stream", "Alsyed Stream (Browser Host Studio)"), ("obs_stream", "Alsyed OBS Stream")]

    course = models.ForeignKey("courses.Course", on_delete=models.CASCADE, related_name="class_schedules")
    live_class = models.ForeignKey(
        "courses.LiveClass",
        on_delete=models.CASCADE,
        related_name="class_schedules",
        help_text="Live class the generated sessions link to (decides who may join).",
    )
    name = models.CharField(max_length=120, blank=True, default="", help_text="e.g. 'Batch 7, term 1'.")
    title_pattern = models.CharField(
        max_length=200,
        default="{course} · Class {n}",
        help_text="Placeholders: {course}, {batch}, {live_class}, {n}, {date}, {weekday}.",
    )
    start_date = models.DateField()
    end_date = models.DateField()
    weekdays = models.JSONField(default=list, validators=[validate_weekdays], help_text="0 = Monday … 6 = Sunday.")
    start_time = models.TimeField()
    duration_minutes = models.PositiveIntegerField(default=60)
    timezone = models.CharField(max_length=64, default=conf.TIMEZONE_NAME, validators=[validate_timezone_name])
    host = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="hosted_class_schedules")
    session_type = models.CharField(max_length=20, choices=SESSION_TYPE_CHOICES, default="meeting")
    stream_service = models.CharField(max_length=20, choices=STREAM_SERVICE_CHOICES, default="alsyed_stream")
    description = models.TextField(blank=True, default="")
    is_active = models.BooleanField(default=True)
    version = models.PositiveIntegerField(default=1)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    last_materialized_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-start_date", "-id"]
        verbose_name = "class schedule"
        indexes = [
            models.Index(fields=["is_active", "end_date"], name="cal_schedule_active_idx"),
            models.Index(fields=["course", "is_active"], name="cal_schedule_course_idx"),
        ]

    def __str__(self):
        return self.name or f"{self.course} schedule"

    def clean(self):
        super().clean()
        from config.model_validators import validate_no_active_content

        validate_no_active_content(self.title_pattern, "title_pattern")
        validate_no_active_content(self.name, "name")
        validate_no_active_content(self.description, "description")
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValidationError({"end_date": "The end date must be on or after the start date."})
        if self.start_date and self.end_date and (self.end_date - self.start_date).days > 730:
            raise ValidationError({"end_date": "A schedule can cover at most two years."})
        if not 15 <= int(self.duration_minutes or 0) <= 600:
            raise ValidationError({"duration_minutes": "Use 15 to 600 minutes."})
        if self.live_class_id and self.course_id and self.live_class.linked_course_id not in (None, self.course_id):
            raise ValidationError({"live_class": "The live class must belong to the selected course."})
        if self.session_type == "meeting" and self.stream_service != "alsyed_stream":
            raise ValidationError({"stream_service": "Meetings support only Alsyed Stream mode."})

    @property
    def tz(self) -> ZoneInfo:
        try:
            return ZoneInfo(self.timezone or conf.TIMEZONE_NAME)
        except Exception:  # noqa: BLE001
            return ZoneInfo(conf.TIMEZONE_NAME)


class ScheduleException(models.Model):
    KIND_CANCELLED = "cancelled"
    KIND_RESCHEDULED = "rescheduled"
    KIND_EXTRA = "extra"
    KIND_CHOICES = [
        (KIND_CANCELLED, "Cancelled date"),
        (KIND_RESCHEDULED, "Rescheduled date"),
        (KIND_EXTRA, "Extra class"),
    ]

    schedule = models.ForeignKey(ClassSchedule, on_delete=models.CASCADE, related_name="exceptions")
    kind = models.CharField(max_length=12, choices=KIND_CHOICES)
    date = models.DateField(help_text="The regular class date this changes (for an extra class: its date).")
    new_start = models.DateTimeField(null=True, blank=True, help_text="Rescheduled/extra: the new start.")
    duration_minutes = models.PositiveIntegerField(null=True, blank=True)
    title = models.CharField(max_length=200, blank=True, default="")
    note = models.CharField(max_length=300, blank=True, default="", help_text="Shown to students (e.g. the reason).")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["date", "id"]
        verbose_name = "schedule exception"
        indexes = [models.Index(fields=["schedule", "date"], name="cal_exception_sched_date_idx")]

    def __str__(self):
        return f"{self.get_kind_display()} {self.date}"

    def clean(self):
        super().clean()
        from config.model_validators import validate_no_active_content

        validate_no_active_content(self.title, "title")
        validate_no_active_content(self.note, "note")
        if self.kind in (self.KIND_RESCHEDULED, self.KIND_EXTRA) and not self.new_start:
            raise ValidationError({"new_start": "Give the new start time."})
        if self.duration_minutes is not None and not 15 <= int(self.duration_minutes) <= 600:
            raise ValidationError({"duration_minutes": "Use 15 to 600 minutes."})


class ScheduledClass(models.Model):
    STATUS_SCHEDULED = "scheduled"
    STATUS_CANCELLED = "cancelled"
    STATUS_CHOICES = [(STATUS_SCHEDULED, "Scheduled"), (STATUS_CANCELLED, "Cancelled")]

    KIND_REGULAR = "regular"
    KIND_RESCHEDULED = "rescheduled"
    KIND_EXTRA = "extra"
    KIND_CHOICES = [(KIND_REGULAR, "Regular"), (KIND_RESCHEDULED, "Rescheduled"), (KIND_EXTRA, "Extra")]

    schedule = models.ForeignKey(ClassSchedule, on_delete=models.CASCADE, related_name="occurrences")
    occurrence_key = models.CharField(max_length=80, unique=True)
    original_date = models.DateField()
    kind = models.CharField(max_length=12, choices=KIND_CHOICES, default=KIND_REGULAR)
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=STATUS_SCHEDULED)
    title = models.CharField(max_length=255)
    note = models.CharField(max_length=300, blank=True, default="")
    course = models.ForeignKey("courses.Course", on_delete=models.CASCADE, related_name="scheduled_classes")
    live_class = models.ForeignKey(
        "courses.LiveClass", on_delete=models.SET_NULL, null=True, blank=True, related_name="scheduled_classes"
    )
    host = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    session = models.OneToOneField(
        "realtime.RealtimeSession",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="scheduled_class",
    )
    # Set once a session was created for this occurrence; a session deleted by a
    # person afterwards is never re-created ("respect manual edits").
    session_created_at = models.DateTimeField(null=True, blank=True)
    session_fingerprint = models.CharField(max_length=64, blank=True, default="")
    manually_edited = models.BooleanField(
        default=False, help_text="Someone edited the generated session: the schedule no longer changes it."
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["starts_at", "id"]
        verbose_name = "scheduled class"
        verbose_name_plural = "scheduled classes"
        indexes = [
            models.Index(fields=["starts_at"], name="cal_occ_starts_idx"),
            models.Index(fields=["course", "starts_at"], name="cal_occ_course_starts_idx"),
            models.Index(fields=["live_class", "starts_at"], name="cal_occ_live_starts_idx"),
            models.Index(fields=["schedule", "starts_at"], name="cal_occ_sched_starts_idx"),
        ]

    def __str__(self):
        return f"{self.title} @ {self.starts_at:%Y-%m-%d %H:%M}"


def _new_nonce() -> str:
    return secrets.token_urlsafe(18)


class CalendarFeedToken(models.Model):
    """A student's iCalendar subscription. The URL token is signed over the
    user id and ``nonce``; rotating or revoking changes/clears the nonce, so
    every older URL stops working at once."""

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="calendar_feed")
    nonce = models.CharField(max_length=48, default=_new_nonce)
    revoked_at = models.DateTimeField(null=True, blank=True)
    last_accessed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        verbose_name = "calendar feed"

    def __str__(self):
        return f"calendar feed of user {self.user_id}"

    @property
    def active(self) -> bool:
        return self.revoked_at is None and bool(self.nonce)
