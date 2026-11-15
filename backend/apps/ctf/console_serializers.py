"""Request and response shapes for Console -> Exams (``/api/ctf-admin/``).

Responses are plain dicts from ``console.py`` rendered through these
serializers. None of them has a field for answers, hashes or normalisation.
"""

from __future__ import annotations

from rest_framework import serializers

from apps.users.identity_serializers import ConsoleStudentIdentitySerializer, ConsoleStudentRefSerializer

from .console import STATE_CHOICES
from .models import CATEGORY_CHOICES, DIFFICULTY_CHOICES, MAX_ATTEMPTS_CAP, CtfExam, CtfParticipation
from .serializers import MATERIAL_KIND_CHOICES


# --- Requests ---------------------------------------------------------------
class ExamUploadSerializer(serializers.Serializer):
    file = serializers.FileField(required=False, help_text="The exam JSON file (multipart).")
    content = serializers.CharField(required=False, trim_whitespace=False, help_text="Or the JSON text itself.")
    allow_content_change = serializers.BooleanField(required=False, default=False)

    def validate(self, attrs):
        if not attrs.get("file") and not attrs.get("content"):
            raise serializers.ValidationError({"file": ["Choose the exam JSON file."]})
        return attrs


class ExamUpdateSerializer(serializers.Serializer):
    opens_at = serializers.DateTimeField(required=False, allow_null=True)
    closes_at = serializers.DateTimeField(required=False, allow_null=True)
    time_limit_minutes = serializers.IntegerField(required=False, allow_null=True, min_value=1, max_value=24 * 60)
    default_max_attempts = serializers.IntegerField(required=False, min_value=1, max_value=MAX_ATTEMPTS_CAP)
    batch_ids = serializers.ListField(child=serializers.IntegerField(min_value=1), required=False, max_length=200)
    batch_slugs = serializers.ListField(child=serializers.SlugField(), required=False, max_length=200)


class MaterialUploadSerializer(serializers.Serializer):
    path = serializers.CharField(max_length=300)
    file = serializers.FileField()


# --- Responses --------------------------------------------------------------
class BatchSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    slug = serializers.CharField()
    title = serializers.CharField()
    batch = serializers.CharField(allow_blank=True)


class BatchOptionSerializer(BatchSerializer):
    student_count = serializers.IntegerField()


class BatchListSerializer(serializers.Serializer):
    results = BatchOptionSerializer(many=True)


class ExamStatsSerializer(serializers.Serializer):
    participants = serializers.IntegerField()
    active = serializers.IntegerField()
    submitted = serializers.IntegerField()
    expired = serializers.IntegerField()
    average_score = serializers.FloatField(allow_null=True)
    top_score = serializers.IntegerField(allow_null=True)


class ConsoleExamRowSerializer(serializers.Serializer):
    slug = serializers.CharField()
    title = serializers.CharField()
    state = serializers.ChoiceField(choices=STATE_CHOICES)
    status = serializers.ChoiceField(choices=CtfExam.STATUS_CHOICES)
    window = serializers.ChoiceField(choices=CtfExam.WINDOW_CHOICES)
    opens_at = serializers.DateTimeField(allow_null=True)
    closes_at = serializers.DateTimeField(allow_null=True)
    time_limit_minutes = serializers.IntegerField(allow_null=True)
    question_count = serializers.IntegerField()
    total_points = serializers.IntegerField()
    batches = BatchSerializer(many=True)
    ready = serializers.BooleanField(allow_null=True, help_text="Readiness (staff only; null for instructors).")
    stats = ExamStatsSerializer()
    results_finalized_at = serializers.DateTimeField(allow_null=True)


class ConsoleExamListSerializer(serializers.Serializer):
    results = ConsoleExamRowSerializer(many=True)
    can_manage = serializers.BooleanField()
    server_time = serializers.DateTimeField()


class ReadinessItemSerializer(serializers.Serializer):
    id = serializers.CharField()
    label = serializers.CharField()
    ok = serializers.BooleanField()
    detail = serializers.CharField(allow_blank=True)


class ReadinessSerializer(serializers.Serializer):
    ready = serializers.BooleanField()
    items = ReadinessItemSerializer(many=True)
    reasons = serializers.ListField(child=serializers.CharField())


class ConsoleMaterialSerializer(serializers.Serializer):
    path = serializers.CharField()
    label = serializers.CharField(allow_blank=True)
    kind = serializers.ChoiceField(choices=MATERIAL_KIND_CHOICES)
    uploaded = serializers.BooleanField()
    material_id = serializers.IntegerField(allow_null=True)
    size = serializers.IntegerField(allow_null=True)


class ConsoleQuestionSerializer(serializers.Serializer):
    key = serializers.CharField()
    order = serializers.IntegerField()
    title = serializers.CharField()
    category = serializers.ChoiceField(choices=CATEGORY_CHOICES)
    difficulty = serializers.ChoiceField(choices=DIFFICULTY_CHOICES)
    points = serializers.IntegerField()
    max_attempts = serializers.IntegerField()
    materials = ConsoleMaterialSerializer(many=True)


class MaterialCountsSerializer(serializers.Serializer):
    referenced = serializers.IntegerField()
    uploaded = serializers.IntegerField()


class ConsoleExamDetailSerializer(ConsoleExamRowSerializer):
    title_ur = serializers.CharField(allow_blank=True)
    default_max_attempts = serializers.IntegerField()
    auto_publish = serializers.BooleanField()
    published_at = serializers.DateTimeField(allow_null=True)
    closed_at = serializers.DateTimeField(allow_null=True)
    content_loaded_at = serializers.DateTimeField(allow_null=True)
    content_fingerprint = serializers.CharField(allow_blank=True)
    questions = ConsoleQuestionSerializer(many=True)
    materials = MaterialCountsSerializer()
    readiness = ReadinessSerializer(allow_null=True)
    can_manage = serializers.BooleanField()
    labs_url = serializers.CharField()


class UploadReportSerializer(serializers.Serializer):
    slug = serializers.CharField()
    title = serializers.CharField(allow_blank=True)
    exam_created = serializers.BooleanField()
    dry_run = serializers.BooleanField()
    created = serializers.IntegerField()
    updated = serializers.IntegerField()
    unchanged = serializers.IntegerField()
    deactivated = serializers.IntegerField()
    removed = serializers.IntegerField()
    question_count = serializers.IntegerField()
    total_points = serializers.IntegerField()
    materials_referenced = serializers.IntegerField()
    eligible_courses = serializers.IntegerField(allow_null=True)
    changed_with_attempts = serializers.ListField(child=serializers.CharField())
    opens_at = serializers.DateTimeField(allow_null=True)
    closes_at = serializers.DateTimeField(allow_null=True)
    time_limit_minutes = serializers.IntegerField(allow_null=True)
    content_fingerprint = serializers.CharField()
    current_state = serializers.ChoiceField(choices=STATE_CHOICES, allow_null=True)


class UploadResponseSerializer(serializers.Serializer):
    report = UploadReportSerializer()
    exam = ConsoleExamDetailSerializer(allow_null=True)


class ResultRowSerializer(serializers.Serializer):
    # Owner rule (Console): handles only. Real names are in Django admin -> Examination.
    identity = ConsoleStudentIdentitySerializer(required=False, help_text="Roll number, handle, stats (first).")
    rank = serializers.IntegerField()
    student = ConsoleStudentRefSerializer()
    batch = BatchSerializer(allow_null=True)
    status = serializers.ChoiceField(choices=CtfParticipation.STATUS_CHOICES)
    score = serializers.IntegerField()
    solved_count = serializers.IntegerField()
    wrong_count = serializers.IntegerField()
    attempt_count = serializers.IntegerField()
    started_at = serializers.DateTimeField()
    deadline_at = serializers.DateTimeField(allow_null=True)
    submitted_at = serializers.DateTimeField(allow_null=True)


class WrongAnswerSerializer(serializers.Serializer):
    answer = serializers.CharField()
    count = serializers.IntegerField()


class QuestionStatSerializer(serializers.Serializer):
    key = serializers.CharField()
    order = serializers.IntegerField()
    title = serializers.CharField()
    points = serializers.IntegerField()
    attempted = serializers.IntegerField()
    solved = serializers.IntegerField()
    solve_rate = serializers.FloatField(allow_null=True)
    wrong_answers = WrongAnswerSerializer(many=True)


class ResultsExamSerializer(serializers.Serializer):
    slug = serializers.CharField()
    title = serializers.CharField()
    state = serializers.ChoiceField(choices=STATE_CHOICES)
    question_count = serializers.IntegerField()
    total_points = serializers.IntegerField()


class ResultsSerializer(serializers.Serializer):
    exam = ResultsExamSerializer()
    stats = ExamStatsSerializer()
    participants = ResultRowSerializer(many=True)
    questions = QuestionStatSerializer(many=True)


class MaterialUploadedSerializer(serializers.Serializer):
    material_id = serializers.IntegerField()
    path = serializers.CharField()
    size = serializers.IntegerField()
    sha256 = serializers.CharField()


class OpenExamSerializer(serializers.Serializer):
    slug = serializers.CharField()
    title = serializers.CharField()
    closes_at = serializers.DateTimeField(allow_null=True)
    active = serializers.IntegerField()


class ScheduledExamSerializer(serializers.Serializer):
    slug = serializers.CharField()
    title = serializers.CharField()
    opens_at = serializers.DateTimeField(allow_null=True)


class ConsoleSummarySerializer(serializers.Serializer):
    open = OpenExamSerializer(many=True)
    scheduled = ScheduledExamSerializer(many=True)
    labs_url = serializers.CharField()
    server_time = serializers.DateTimeField()
