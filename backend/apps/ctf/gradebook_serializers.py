"""Response shapes of the unified gradebook (``/api/gradebook/``)."""

from __future__ import annotations

from rest_framework import serializers

KIND_CHOICES = [("report", "Weekly report"), ("exam", "CTF exam")]


class UnifiedGradebookCourseSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    slug = serializers.CharField()
    title = serializers.CharField()
    batch = serializers.CharField(allow_blank=True)


class UnifiedGradebookCourseListSerializer(serializers.Serializer):
    results = UnifiedGradebookCourseSerializer(many=True)


class UnifiedGradebookStudentSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    full_name = serializers.CharField(allow_blank=True)
    email = serializers.CharField()


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
    student = UnifiedGradebookStudentSerializer()
    courses = UnifiedStudentCourseSectionSerializer(many=True)
    generated_at = serializers.DateTimeField()
