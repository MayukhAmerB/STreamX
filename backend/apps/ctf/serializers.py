"""Request and response shapes for the CTF exam API (``/api/ctf/``).

Responses are built as plain dicts by ``presenters.py`` and rendered through
these serializers, so the OpenAPI contract describes exactly what is sent.
No serializer here has a field for answers, answer hashes or normalisation.
"""

from __future__ import annotations

from rest_framework import serializers

from .models import CATEGORY_CHOICES, DIFFICULTY_CHOICES, MAX_ANSWER_LENGTH, CtfExam, CtfParticipation

MATERIAL_KIND_CHOICES = [("image", "Image"), ("file", "File")]


class LocalizedTextSerializer(serializers.Serializer):
    en = serializers.CharField(allow_blank=True)
    ur = serializers.CharField(allow_blank=True)


class LocalizedLinesSerializer(serializers.Serializer):
    en = serializers.ListField(child=serializers.CharField())
    ur = serializers.ListField(child=serializers.CharField())


class PromptBodySerializer(serializers.Serializer):
    briefing = serializers.ListField(child=serializers.CharField())
    artifact = serializers.CharField(allow_blank=True)
    search_patterns = serializers.ListField(child=serializers.CharField())
    task = serializers.CharField(allow_blank=True)
    constraints = serializers.CharField(allow_blank=True)
    answer_format = serializers.CharField(allow_blank=True)


class PromptSerializer(serializers.Serializer):
    en = PromptBodySerializer()
    ur = PromptBodySerializer()


class MaterialSerializer(serializers.Serializer):
    label = LocalizedTextSerializer()
    url = serializers.CharField(help_text="Path on the labs site, e.g. /materials/exams/<folder>/photo.jpg")
    kind = serializers.ChoiceField(choices=MATERIAL_KIND_CHOICES)
    alt = LocalizedTextSerializer()


class ParticipationSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=CtfParticipation.STATUS_CHOICES)
    started_at = serializers.DateTimeField()
    deadline_at = serializers.DateTimeField(allow_null=True)
    submitted_at = serializers.DateTimeField(allow_null=True)
    score = serializers.IntegerField()
    solved_count = serializers.IntegerField()
    wrong_count = serializers.IntegerField()


class QuestionSerializer(serializers.Serializer):
    key = serializers.CharField()
    order = serializers.IntegerField()
    category = serializers.ChoiceField(choices=CATEGORY_CHOICES)
    difficulty = serializers.ChoiceField(choices=DIFFICULTY_CHOICES)
    points = serializers.IntegerField()
    title = LocalizedTextSerializer()
    prompt = PromptSerializer()
    materials = MaterialSerializer(many=True)
    max_attempts = serializers.IntegerField()
    attempts_used = serializers.IntegerField()
    solved = serializers.BooleanField()
    points_awarded = serializers.IntegerField()


class ExamSummarySerializer(serializers.Serializer):
    slug = serializers.CharField()
    title = LocalizedTextSerializer()
    status = serializers.ChoiceField(choices=CtfExam.STATUS_CHOICES)
    window = serializers.ChoiceField(choices=CtfExam.WINDOW_CHOICES)
    opens_at = serializers.DateTimeField(allow_null=True)
    closes_at = serializers.DateTimeField(allow_null=True)
    time_limit_minutes = serializers.IntegerField(allow_null=True)
    question_count = serializers.IntegerField()
    total_points = serializers.IntegerField()
    can_start = serializers.BooleanField()
    participation = ParticipationSerializer(allow_null=True)


class ExamListSerializer(serializers.Serializer):
    results = ExamSummarySerializer(many=True)
    server_time = serializers.DateTimeField()


class ExamInfoSerializer(serializers.Serializer):
    slug = serializers.CharField()
    title = LocalizedTextSerializer()
    status = serializers.ChoiceField(choices=CtfExam.STATUS_CHOICES)
    window = serializers.ChoiceField(choices=CtfExam.WINDOW_CHOICES)
    opens_at = serializers.DateTimeField(allow_null=True)
    closes_at = serializers.DateTimeField(allow_null=True)
    briefing = LocalizedLinesSerializer()
    rules = LocalizedLinesSerializer()
    time_limit_minutes = serializers.IntegerField(allow_null=True)
    question_count = serializers.IntegerField()
    total_points = serializers.IntegerField()
    can_start = serializers.BooleanField()


class ExamDetailSerializer(serializers.Serializer):
    exam = ExamInfoSerializer()
    participation = ParticipationSerializer(allow_null=True)
    server_time = serializers.DateTimeField()
    questions = QuestionSerializer(many=True)


class ParticipationResponseSerializer(serializers.Serializer):
    participation = ParticipationSerializer()


class AttemptRequestSerializer(serializers.Serializer):
    answer = serializers.CharField(max_length=MAX_ANSWER_LENGTH, trim_whitespace=False)

    def validate_answer(self, value):
        if not value.strip():
            raise serializers.ValidationError("Type an answer.")
        return value


class AttemptResultSerializer(serializers.Serializer):
    attempt_number = serializers.IntegerField()
    correct = serializers.BooleanField()
    points_awarded = serializers.IntegerField()
    attempts_remaining = serializers.IntegerField()


class AttemptResponseSerializer(serializers.Serializer):
    attempt = AttemptResultSerializer()
    participation = ParticipationSerializer()
