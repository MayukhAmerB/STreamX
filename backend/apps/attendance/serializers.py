"""Input validation for the staff calendar and attendance endpoints."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone
from rest_framework import serializers

from . import conf
from .models import AttendanceRecord, ClassSchedule, ScheduleException


class OverrideSerializer(serializers.Serializer):
    user_id = serializers.IntegerField(min_value=1)
    status = serializers.ChoiceField(choices=[*AttendanceRecord.STATUSES, "auto"])
    reason = serializers.CharField(max_length=300, trim_whitespace=True)


class PolicySerializer(serializers.Serializer):
    present_min_minutes = serializers.IntegerField(min_value=1, max_value=600, required=False)
    short_session_percent = serializers.IntegerField(min_value=5, max_value=100, required=False)
    low_attendance_percent = serializers.IntegerField(min_value=1, max_value=100, required=False)


class ExceptionSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=[choice for choice, _label in ScheduleException.KIND_CHOICES])
    date = serializers.DateField(required=False, allow_null=True)
    # A time without an offset is read as India time (the schedule's zone).
    new_start = serializers.DateTimeField(required=False, allow_null=True, default_timezone=ZoneInfo(conf.TIMEZONE_NAME))
    duration_minutes = serializers.IntegerField(required=False, allow_null=True, min_value=15, max_value=600)
    title = serializers.CharField(required=False, allow_blank=True, max_length=200, default="")
    note = serializers.CharField(required=False, allow_blank=True, max_length=300, default="")

    def validate(self, attrs):
        kind = attrs["kind"]
        if kind in (ScheduleException.KIND_RESCHEDULED, ScheduleException.KIND_EXTRA) and not attrs.get("new_start"):
            raise serializers.ValidationError({"new_start": "Give the new start time."})
        if kind == ScheduleException.KIND_EXTRA and not attrs.get("date"):
            attrs["date"] = timezone.localtime(attrs["new_start"], ZoneInfo(conf.TIMEZONE_NAME)).date()
        if not attrs.get("date"):
            raise serializers.ValidationError({"date": "Pick the class date this changes."})
        return attrs


class ClassScheduleSerializer(serializers.Serializer):
    course = serializers.IntegerField(min_value=1)
    live_class = serializers.IntegerField(min_value=1)
    name = serializers.CharField(required=False, allow_blank=True, max_length=120, default="")
    title_pattern = serializers.CharField(required=False, max_length=200, default="{course} · Class {n}")
    start_date = serializers.DateField()
    end_date = serializers.DateField()
    weekdays = serializers.ListField(child=serializers.IntegerField(min_value=0, max_value=6), min_length=1, max_length=7)
    start_time = serializers.TimeField()
    duration_minutes = serializers.IntegerField(min_value=15, max_value=600, default=60)
    timezone = serializers.CharField(required=False, max_length=64, default=conf.TIMEZONE_NAME)
    host = serializers.IntegerField(required=False, allow_null=True, min_value=1)
    session_type = serializers.ChoiceField(choices=["meeting", "broadcasting"], default="meeting")
    stream_service = serializers.ChoiceField(choices=["alsyed_stream", "obs_stream"], default="alsyed_stream")
    description = serializers.CharField(required=False, allow_blank=True, max_length=4000, default="")
    is_active = serializers.BooleanField(required=False, default=True)
    exceptions = ExceptionSerializer(many=True, required=False)

    def validate_weekdays(self, value):
        return sorted(set(int(day) for day in value))

    def validate(self, attrs):
        if attrs.get("end_date") and attrs.get("start_date") and attrs["end_date"] < attrs["start_date"]:
            raise serializers.ValidationError({"end_date": "The end date must be on or after the start date."})
        return attrs


def build_schedule(data: dict, *, instance: ClassSchedule | None = None) -> ClassSchedule:
    """An unsaved (or updated) schedule validated with the model's own rules."""
    from apps.courses.models import Course, LiveClass

    schedule = instance or ClassSchedule()
    course = Course.objects.filter(pk=data["course"]).first()
    if course is None:
        raise serializers.ValidationError({"course": "Course not found."})
    live_class = LiveClass.objects.filter(pk=data["live_class"]).first()
    if live_class is None:
        raise serializers.ValidationError({"live_class": "Live class not found."})
    schedule.course = course
    schedule.live_class = live_class
    for name in (
        "name",
        "title_pattern",
        "start_date",
        "end_date",
        "weekdays",
        "start_time",
        "duration_minutes",
        "timezone",
        "session_type",
        "stream_service",
        "description",
        "is_active",
    ):
        if name in data:
            setattr(schedule, name, data[name])
    try:
        schedule.full_clean(exclude=["host", "created_by"])
    except DjangoValidationError as exc:
        raise serializers.ValidationError(exc.message_dict) from exc
    return schedule


def naive_to_tz(value: datetime | None, tz) -> datetime | None:
    if value is None:
        return None
    if timezone.is_naive(value):
        return value.replace(tzinfo=tz)
    return value


def validate_exception_model(row: ScheduleException) -> None:
    try:
        row.full_clean(exclude=["schedule", "created_by"])
    except DjangoValidationError as exc:
        raise serializers.ValidationError(exc.message_dict) from exc
