"""Response shapes of the unified gradebook (``/api/gradebook/``)."""

from __future__ import annotations

from rest_framework import serializers

from apps.users.identity_serializers import (
    ConsoleOwnIdentitySerializer,
    ConsoleStudentIdentitySerializer,
    ConsoleStudentRefSerializer,
)

KIND_CHOICES = [("report", "Weekly report"), ("exam", "CTF exam")]


class UnifiedGradebookCourseSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    slug = serializers.CharField()
    title = serializers.CharField()
    batch = serializers.CharField(allow_blank=True)


class UnifiedGradebookCourseListSerializer(serializers.Serializer):
    results = UnifiedGradebookCourseSerializer(many=True)


class UnifiedGradebookStudentSerializer(ConsoleStudentRefSerializer):
    """Owner rule (Console): handles only. Real names are in Django admin -> Examination."""


class UnifiedGradebookColumnSerializer(serializers.Serializer):
    key = serializers.CharField()
    kind = serializers.ChoiceField(choices=KIND_CHOICES)
    id = serializers.IntegerField()
    title = serializers.CharField()
    short_title = serializers.CharField()
    date = serializers.DateTimeField(allow_null=True)
    max = serializers.FloatField(allow_null=True)


class UnifiedGradebookCellSerializer(serializers.Serializer):
    key = serializers.CharField()
    kind = serializers.ChoiceField(choices=KIND_CHOICES)
    status = serializers.CharField(
        help_text="graded | missing | not_submitted | submitted | ... (reports); result | absent | pending | in_progress (exams)"
    )
    value = serializers.FloatField(allow_null=True)
    max = serializers.FloatField(allow_null=True)
    is_late = serializers.BooleanField()
    rank = serializers.IntegerField(allow_null=True)


class UnifiedGradebookPartSerializer(serializers.Serializer):
    total = serializers.FloatField()
    max = serializers.FloatField()
    percentage = serializers.FloatField(allow_null=True)
    count = serializers.IntegerField()


class UnifiedGradebookTotalsSerializer(serializers.Serializer):
    reports = UnifiedGradebookPartSerializer()
    exams = UnifiedGradebookPartSerializer()
    overall_percentage = serializers.FloatField(allow_null=True)
    missing_count = serializers.IntegerField()
    late_count = serializers.IntegerField()


class UnifiedGradebookRowSerializer(serializers.Serializer):
    identity = ConsoleStudentIdentitySerializer(required=False, help_text="Roll number, handle, stats (first).")
    student = UnifiedGradebookStudentSerializer()
    cells = UnifiedGradebookCellSerializer(many=True)
    totals = UnifiedGradebookTotalsSerializer()


class UnifiedBatchGradebookSerializer(serializers.Serializer):
    course = UnifiedGradebookCourseSerializer()
    columns = UnifiedGradebookColumnSerializer(many=True)
    rows = UnifiedGradebookRowSerializer(many=True)
    generated_at = serializers.DateTimeField()


class UnifiedStudentCourseSectionSerializer(serializers.Serializer):
    course = UnifiedGradebookCourseSerializer()
    columns = UnifiedGradebookColumnSerializer(many=True)
    cells = UnifiedGradebookCellSerializer(many=True)
    totals = UnifiedGradebookTotalsSerializer()


class UnifiedStudentGradebookSerializer(serializers.Serializer):
    identity = ConsoleStudentIdentitySerializer(required=False, help_text="Roll number, handle, stats (first).")
    student = UnifiedGradebookStudentSerializer()
    courses = UnifiedStudentCourseSectionSerializer(many=True)
    generated_at = serializers.DateTimeField()


class UnifiedMyGradebookSerializer(UnifiedStudentGradebookSerializer):
    """``/api/gradebook/me/``: the student's own gradebook, so their own real name is included.

    Staff and instructor payloads (``UnifiedStudentGradebookSerializer``) stay handle-only.
    """

    identity = ConsoleOwnIdentitySerializer(
        required=False, help_text="Roll number, the student's own real name, handle, stats (first)."
    )
