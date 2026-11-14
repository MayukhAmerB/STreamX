"""Request and response shapes for the weekly-report API.

Responses are built as plain dicts by ``presenters.py`` and rendered through
these serializers, so the OpenAPI contract describes exactly what is sent.
"""

from __future__ import annotations

import json
from decimal import Decimal

from config.upload_validators import REPORT_ALLOWED_EXTENSIONS
from django.conf import settings
from django.utils import timezone
from rest_framework import serializers

from .models import GRADE_ACTION_CHOICES, SCAN_STATUS_CHOICES, ReportSubmission, ReportTask

STUDENT_STATUS_CHOICES = ReportSubmission.STATUS_CHOICES
WINDOW_CHOICES = [("not_open", "Not open"), ("open", "Open"), ("late", "Late window"), ("closed", "Closed")]
PREVIEW_CHOICES = [("pdf", "PDF"), ("image", "Image"), ("markdown", "Markdown"), ("canvas", "Canvas"), ("none", "None")]
CELL_STATUS_CHOICES = [*ReportSubmission.STATUS_CHOICES, ("missing", "Missing")]
FILE_TYPE_CHOICES = [(value, f".{value}") for value in REPORT_ALLOWED_EXTENSIONS]


# ---------------------------------------------------------------------------
# Shared pieces
# ---------------------------------------------------------------------------
class RefSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    title = serializers.CharField()


class PersonSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    full_name = serializers.CharField(allow_blank=True)
    email = serializers.EmailField()


class StoredFileSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    name = serializers.CharField()
    extension = serializers.CharField()
    content_type = serializers.CharField()
    size = serializers.IntegerField()
    created_at = serializers.DateTimeField()
    preview = serializers.ChoiceField(choices=PREVIEW_CHOICES)
    scan_status = serializers.ChoiceField(choices=SCAN_STATUS_CHOICES)
    download_url = serializers.CharField()


class CriterionSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    name = serializers.CharField()
    description = serializers.CharField(allow_blank=True)
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2)


class VersionSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    number = serializers.IntegerField()
    note = serializers.CharField(allow_blank=True)
    submitted_at = serializers.DateTimeField()
    is_late = serializers.BooleanField()
    minutes_late = serializers.IntegerField()
    is_revision = serializers.BooleanField()
    files = StoredFileSerializer(many=True)


class CriterionMarkSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    name = serializers.CharField()
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2)
    marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)


class FeedbackFileSerializer(serializers.Serializer):
    name = serializers.CharField()
    extension = serializers.CharField()
    size = serializers.IntegerField()
    preview = serializers.ChoiceField(choices=PREVIEW_CHOICES)
    scan_status = serializers.ChoiceField(choices=SCAN_STATUS_CHOICES)
    download_url = serializers.CharField()


class StudentGradeSerializer(serializers.Serializer):
    raw_marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    late_penalty = serializers.DecimalField(max_digits=6, decimal_places=2)
    final_marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2)
    criteria = CriterionMarkSerializer(many=True)
    feedback = serializers.CharField(allow_blank=True)
    graded_at = serializers.DateTimeField(allow_null=True)
    annotated_file = FeedbackFileSerializer(allow_null=True)


# ---------------------------------------------------------------------------
# Student
# ---------------------------------------------------------------------------
class StudentTaskSummarySerializer(serializers.Serializer):
    id = serializers.IntegerField()
    course = RefSerializer()
    section = RefSerializer(allow_null=True)
    week_number = serializers.IntegerField(allow_null=True)
    title = serializers.CharField()
    opens_at = serializers.DateTimeField(allow_null=True)
    due_at = serializers.DateTimeField()
    late_policy = serializers.ChoiceField(choices=ReportTask.LATE_POLICY_CHOICES)
    late_until = serializers.DateTimeField(allow_null=True)
    accepting_until = serializers.DateTimeField()
    window = serializers.ChoiceField(choices=WINDOW_CHOICES)
    task_status = serializers.ChoiceField(choices=ReportTask.STATUS_CHOICES)
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2)
    marks_visibility = serializers.ChoiceField(choices=ReportTask.MARKS_VISIBILITY_CHOICES)
    status = serializers.ChoiceField(choices=STUDENT_STATUS_CHOICES)
    is_late = serializers.BooleanField()
    minutes_late = serializers.IntegerField()
    submitted_at = serializers.DateTimeField(allow_null=True)
    version_count = serializers.IntegerField()
    marks_visible = serializers.BooleanField()
    final_marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    can_submit = serializers.BooleanField()


class StudentTaskListSerializer(serializers.Serializer):
    results = StudentTaskSummarySerializer(many=True)
    next_due = StudentTaskSummarySerializer(allow_null=True)
    server_time = serializers.DateTimeField()


class StudentSubmissionSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    status = serializers.ChoiceField(choices=STUDENT_STATUS_CHOICES)
    revision = serializers.IntegerField()
    version_count = serializers.IntegerField()
    first_submitted_at = serializers.DateTimeField(allow_null=True)
    submitted_at = serializers.DateTimeField(allow_null=True)
    is_late = serializers.BooleanField()
    minutes_late = serializers.IntegerField()
    current_version = VersionSerializer(allow_null=True)
    versions = VersionSerializer(many=True)


class StudentTaskDetailSerializer(StudentTaskSummarySerializer):
    brief = serializers.CharField(allow_blank=True)
    late_penalty_percent_per_day = serializers.DecimalField(max_digits=5, decimal_places=2)
    allowed_extensions = serializers.ListField(child=serializers.CharField())
    max_files = serializers.IntegerField()
    max_file_size_mb = serializers.IntegerField()
    max_total_size_mb = serializers.IntegerField()
    criteria = CriterionSerializer(many=True)
    attachments = StoredFileSerializer(many=True)
    lock_reason = serializers.CharField(allow_blank=True)
    submission = StudentSubmissionSerializer(allow_null=True)
    staged_files = StoredFileSerializer(many=True)
    grade = StudentGradeSerializer(allow_null=True)
    revision_feedback = serializers.CharField(allow_blank=True)
    marks_hidden_until_release = serializers.BooleanField()


class SubmitReportRequestSerializer(serializers.Serializer):
    file_ids = serializers.ListField(child=serializers.IntegerField(min_value=1), allow_empty=False, max_length=50)
    note = serializers.CharField(required=False, allow_blank=True, max_length=2000, default="")


class SubmitReportResponseSerializer(serializers.Serializer):
    created = serializers.BooleanField()
    task = StudentTaskDetailSerializer()


class UploadRequestSerializer(serializers.Serializer):
    file = serializers.FileField()


class GradebookCellSerializer(serializers.Serializer):
    task_id = serializers.IntegerField()
    target_count = serializers.IntegerField(required=False, default=0)
    status = serializers.ChoiceField(choices=CELL_STATUS_CHOICES)
    submission_id = serializers.IntegerField(allow_null=True)
    final_marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2)
    is_late = serializers.BooleanField()
    minutes_late = serializers.IntegerField()
    is_missing = serializers.BooleanField()


class GradebookTotalsSerializer(serializers.Serializer):
    total_marks = serializers.DecimalField(max_digits=10, decimal_places=2)
    max_marks = serializers.DecimalField(max_digits=10, decimal_places=2)
    percentage = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    graded_count = serializers.IntegerField()
    missing_count = serializers.IntegerField()
    late_count = serializers.IntegerField()
    submitted_count = serializers.IntegerField()


class GradebookTaskSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    title = serializers.CharField()
    week_number = serializers.IntegerField(allow_null=True)
    due_at = serializers.DateTimeField()
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2)
    status = serializers.ChoiceField(choices=ReportTask.STATUS_CHOICES)


class MyMarksCourseSerializer(serializers.Serializer):
    course = RefSerializer()
    tasks = GradebookTaskSerializer(many=True)
    cells = GradebookCellSerializer(many=True)
    totals = GradebookTotalsSerializer()


class MyMarksSerializer(serializers.Serializer):
    courses = MyMarksCourseSerializer(many=True)


# ---------------------------------------------------------------------------
# Grading / management
# ---------------------------------------------------------------------------
class SectionOptionSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    title = serializers.CharField()
    order = serializers.IntegerField()


class GradableCourseSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    title = serializers.CharField()
    sections = SectionOptionSerializer(many=True)
    next_week_number = serializers.IntegerField()


class GradableCourseListSerializer(serializers.Serializer):
    results = GradableCourseSerializer(many=True)


class CriterionInputSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    description = serializers.CharField(required=False, allow_blank=True, max_length=2000, default="")
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2, min_value=Decimal("0.01"))


class TaskCountsSerializer(serializers.Serializer):
    students = serializers.IntegerField()
    submitted = serializers.IntegerField()
    awaiting = serializers.IntegerField()
    graded = serializers.IntegerField()
    returned = serializers.IntegerField()
    late = serializers.IntegerField()


class ManageTaskSerializer(serializers.Serializer):
    """Create/update input and the grader's view of a task."""

    id = serializers.IntegerField(read_only=True)
    course = serializers.IntegerField()
    course_title = serializers.CharField(read_only=True)
    section = serializers.IntegerField(required=False, allow_null=True, default=None)
    section_title = serializers.CharField(read_only=True, allow_null=True)
    week_number = serializers.IntegerField(required=False, allow_null=True, min_value=1, max_value=520, default=None)
    title = serializers.CharField(max_length=200)
    brief = serializers.CharField(required=False, allow_blank=True, max_length=20000, default="")
    opens_at = serializers.DateTimeField(required=False, allow_null=True, default=None)
    due_at = serializers.DateTimeField()
    late_policy = serializers.ChoiceField(choices=ReportTask.LATE_POLICY_CHOICES, default=ReportTask.LATE_NOT_ALLOWED)
    late_until = serializers.DateTimeField(required=False, allow_null=True, default=None)
    late_penalty_percent_per_day = serializers.DecimalField(
        max_digits=5, decimal_places=2, min_value=Decimal("0"), max_value=Decimal("100"), default=Decimal("0")
    )
    max_marks = serializers.DecimalField(
        max_digits=6, decimal_places=2, min_value=Decimal("0.01"), max_value=Decimal("1000"), default=Decimal("10")
    )
    allowed_file_types = serializers.ListField(
        child=serializers.ChoiceField(choices=FILE_TYPE_CHOICES),
        required=False,
        default=list,
    )
    max_files = serializers.IntegerField(min_value=1, default=5)
    max_file_size_mb = serializers.IntegerField(min_value=1, default=50)
    max_total_size_mb = serializers.IntegerField(min_value=1, default=200)
    marks_visibility = serializers.ChoiceField(
        choices=ReportTask.MARKS_VISIBILITY_CHOICES, default=ReportTask.MARKS_ON_GRADE
    )
    criteria = CriterionInputSerializer(many=True, required=False, default=list)
    status = serializers.ChoiceField(choices=ReportTask.STATUS_CHOICES, read_only=True)
    published_at = serializers.DateTimeField(read_only=True, allow_null=True)
    closed_at = serializers.DateTimeField(read_only=True, allow_null=True)
    marks_released_at = serializers.DateTimeField(read_only=True, allow_null=True)
    created_at = serializers.DateTimeField(read_only=True)
    updated_at = serializers.DateTimeField(read_only=True)
    has_grades = serializers.BooleanField(read_only=True)
    counts = TaskCountsSerializer(read_only=True)
    attachments = StoredFileSerializer(many=True, read_only=True)
    criteria_detail = CriterionSerializer(many=True, read_only=True)

    def validate_title(self, value):
        value = str(value or "").strip()
        if not value:
            raise serializers.ValidationError("Give the weekly target a title.")
        return value

    def validate_criteria(self, value):
        if len(value) > 20:
            raise serializers.ValidationError("Use at most 20 rubric criteria.")
        for item in value:
            item["name"] = str(item.get("name") or "").strip()
            if not item["name"]:
                raise serializers.ValidationError("Every rubric criterion needs a name.")
        return value

    def validate(self, attrs):
        instance = getattr(self, "instance", None)

        def current(name):
            if name in attrs:
                return attrs[name]
            return getattr(instance, name, None) if instance is not None else None

        due_at = current("due_at")
        opens_at = current("opens_at")
        late_policy = current("late_policy") or ReportTask.LATE_NOT_ALLOWED
        late_until = current("late_until")
        if opens_at and due_at and opens_at >= due_at:
            raise serializers.ValidationError({"opens_at": ["The report must open before it is due."]})
        if late_policy == ReportTask.LATE_ALLOWED:
            if not late_until:
                raise serializers.ValidationError({"late_until": ["Choose until when late reports are accepted."]})
            if due_at and late_until <= due_at:
                raise serializers.ValidationError({"late_until": ["The late cut-off must be after the deadline."]})
        files_cap = int(getattr(settings, "REPORTS_MAX_FILES_CAP", 20))
        size_cap = int(getattr(settings, "REPORTS_MAX_FILE_SIZE_MB_CAP", 200))
        max_files = current("max_files") or 5
        per_file = current("max_file_size_mb") or 50
        total = current("max_total_size_mb") or 200
        if max_files > files_cap:
            raise serializers.ValidationError({"max_files": [f"At most {files_cap} files per report."]})
        if per_file > size_cap:
            raise serializers.ValidationError({"max_file_size_mb": [f"At most {size_cap} MB per file."]})
        if total < per_file:
            raise serializers.ValidationError(
                {"max_total_size_mb": ["The total limit must be at least the per-file limit."]}
            )
        if total > size_cap * files_cap:
            raise serializers.ValidationError({"max_total_size_mb": [f"At most {size_cap * files_cap} MB in total."]})
        if instance is None and due_at and due_at <= timezone.now():
            raise serializers.ValidationError({"due_at": ["Choose a deadline in the future."]})
        return attrs


class ManageTaskListSerializer(serializers.Serializer):
    results = ManageTaskSerializer(many=True)


class SubmissionQueueItemSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    task = GradebookTaskSerializer()
    student = PersonSerializer()
    target_name = serializers.CharField(allow_blank=True)
    target_key = serializers.CharField(allow_blank=True)
    week_start = serializers.DateField(allow_null=True)
    week_label = serializers.CharField(allow_blank=True)
    same_target_count = serializers.IntegerField()
    sha256_match_count = serializers.IntegerField()
    different_target_confirmed = serializers.BooleanField()
    status = serializers.ChoiceField(choices=STUDENT_STATUS_CHOICES)
    submitted_at = serializers.DateTimeField(allow_null=True)
    is_late = serializers.BooleanField()
    minutes_late = serializers.IntegerField()
    version_count = serializers.IntegerField()
    final_marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2)
    revision = serializers.IntegerField()


class SubmissionQueueSerializer(serializers.Serializer):
    results = SubmissionQueueItemSerializer(many=True)
    counts = TaskCountsSerializer()


class GraderGradeSerializer(serializers.Serializer):
    raw_marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    late_penalty = serializers.DecimalField(max_digits=6, decimal_places=2)
    final_marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    criteria = CriterionMarkSerializer(many=True)
    feedback = serializers.CharField(allow_blank=True)
    revision_feedback = serializers.CharField(allow_blank=True)
    annotated_file = FeedbackFileSerializer(allow_null=True)
    graded_by = serializers.CharField(allow_blank=True)
    graded_at = serializers.DateTimeField(allow_null=True)
    graded_version = serializers.IntegerField(allow_null=True)


class AuditEntrySerializer(serializers.Serializer):
    id = serializers.IntegerField()
    action = serializers.CharField()
    action_label = serializers.CharField()
    actor = serializers.CharField(allow_blank=True)
    from_status = serializers.CharField(allow_blank=True)
    to_status = serializers.CharField(allow_blank=True)
    old_final_marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    new_final_marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    created_at = serializers.DateTimeField()


class GradingTaskSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    title = serializers.CharField()
    origin = serializers.CharField()
    week_start = serializers.DateField(allow_null=True)
    course = RefSerializer()
    week_number = serializers.IntegerField(allow_null=True)
    due_at = serializers.DateTimeField()
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2)
    late_penalty_percent_per_day = serializers.DecimalField(max_digits=5, decimal_places=2)
    marks_visibility = serializers.ChoiceField(choices=ReportTask.MARKS_VISIBILITY_CHOICES)
    marks_released_at = serializers.DateTimeField(allow_null=True)
    criteria = CriterionSerializer(many=True)


class SubmissionNeighboursSerializer(serializers.Serializer):
    previous_id = serializers.IntegerField(allow_null=True)
    next_id = serializers.IntegerField(allow_null=True)
    next_ungraded_id = serializers.IntegerField(allow_null=True)
    position = serializers.IntegerField(allow_null=True)
    total = serializers.IntegerField()


class SameTargetSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    student = PersonSerializer()
    status = serializers.ChoiceField(choices=STUDENT_STATUS_CHOICES)


class Sha256MatchSerializer(serializers.Serializer):
    file_id = serializers.IntegerField()
    file_name = serializers.CharField()
    sha256 = serializers.CharField()
    submission_id = serializers.IntegerField()
    student = PersonSerializer()
    target_name = serializers.CharField(allow_blank=True)


class SubmissionDetailSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    task = GradingTaskSerializer()
    student = PersonSerializer()
    target_name = serializers.CharField(allow_blank=True)
    different_target_confirmed = serializers.BooleanField()
    similar_targets = serializers.ListField(child=serializers.CharField())
    revision_deadline = serializers.DateTimeField(allow_null=True)
    same_target = SameTargetSerializer(many=True)
    sha256_matches = Sha256MatchSerializer(many=True)
    status = serializers.ChoiceField(choices=STUDENT_STATUS_CHOICES)
    revision = serializers.IntegerField()
    submitted_at = serializers.DateTimeField(allow_null=True)
    first_submitted_at = serializers.DateTimeField(allow_null=True)
    is_late = serializers.BooleanField()
    minutes_late = serializers.IntegerField()
    current_version = VersionSerializer(allow_null=True)
    versions = VersionSerializer(many=True)
    grade = GraderGradeSerializer(allow_null=True)
    audit = AuditEntrySerializer(many=True)
    neighbours = SubmissionNeighboursSerializer()


class GradeRequestSerializer(serializers.Serializer):
    action = serializers.ChoiceField(choices=GRADE_ACTION_CHOICES)
    expected_revision = serializers.IntegerField(min_value=0)
    marks = serializers.DecimalField(max_digits=8, decimal_places=4, required=False, allow_null=True, default=None)
    criteria_marks = serializers.JSONField(required=False, default=dict)
    feedback = serializers.CharField(required=False, allow_blank=True, max_length=10000, default="")
    annotated_file = serializers.FileField(required=False, allow_null=True, default=None)
    remove_annotated_file = serializers.BooleanField(required=False, default=False)

    def validate_criteria_marks(self, value):
        if isinstance(value, str):
            try:
                value = json.loads(value) if value.strip() else {}
            except ValueError:
                raise serializers.ValidationError("Rubric marks are not valid.") from None
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError("Rubric marks are not valid.")
        return {str(key): item for key, item in value.items()}


class GradebookRowSerializer(serializers.Serializer):
    student = PersonSerializer()
    cells = GradebookCellSerializer(many=True)
    totals = GradebookTotalsSerializer()


class GradebookSerializer(serializers.Serializer):
    course = RefSerializer()
    tasks = GradebookTaskSerializer(many=True)
    rows = GradebookRowSerializer(many=True)


class AttachmentUploadResponseSerializer(serializers.Serializer):
    attachment = StoredFileSerializer()


# ---------------------------------------------------------------------------
# Self-service weekly reports (Phase 3)
# ---------------------------------------------------------------------------
WEEK_WHICH_CHOICES = [("current", "This week"), ("previous", "Last week (late window)")]
WEEK_STATUS_CHOICES = [("open", "Open"), ("late", "Late window"), ("closed", "Closed"), ("future", "Not open yet")]


class DraftFileSerializer(StoredFileSerializer):
    scan_pending = serializers.BooleanField()
    blocked_reason = serializers.CharField(allow_blank=True)


class ReportRulesSerializer(serializers.Serializer):
    allowed_extensions = serializers.ListField(child=serializers.CharField())
    max_files = serializers.IntegerField()
    max_file_size_mb = serializers.IntegerField()
    max_total_size_mb = serializers.IntegerField()
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2)
    late_penalty_percent_per_day = serializers.DecimalField(max_digits=5, decimal_places=2)
    grace_hours = serializers.IntegerField()
    max_targets_per_week = serializers.IntegerField(allow_null=True)
    marks_visibility = serializers.CharField()
    brief = serializers.CharField(allow_blank=True)


class WeekTargetSummarySerializer(serializers.Serializer):
    id = serializers.IntegerField()
    target_name = serializers.CharField()
    status = serializers.ChoiceField(choices=STUDENT_STATUS_CHOICES)
    submitted_at = serializers.DateTimeField(allow_null=True)
    is_late = serializers.BooleanField()
    minutes_late = serializers.IntegerField()
    version_count = serializers.IntegerField()
    file_count = serializers.IntegerField()
    draft_file_count = serializers.IntegerField()
    marks_visible = serializers.BooleanField()
    final_marks = serializers.DecimalField(max_digits=6, decimal_places=2, allow_null=True)
    max_marks = serializers.DecimalField(max_digits=6, decimal_places=2)
    can_change = serializers.BooleanField()


class ReportWeekSerializer(serializers.Serializer):
    which = serializers.ChoiceField(choices=WEEK_WHICH_CHOICES)
    week_start = serializers.DateField()
    week_end = serializers.DateField()
    week_number = serializers.IntegerField(allow_null=True)
    label = serializers.CharField()
    due_at = serializers.DateTimeField()
    late_until = serializers.DateTimeField()
    status = serializers.ChoiceField(choices=WEEK_STATUS_CHOICES)
    penalty_percent = serializers.DecimalField(max_digits=6, decimal_places=2)
    task_id = serializers.IntegerField(allow_null=True)
    slots_left = serializers.IntegerField(allow_null=True)
    targets = WeekTargetSummarySerializer(many=True)


class CourseWeekSerializer(serializers.Serializer):
    course = RefSerializer()
    enabled = serializers.BooleanField()
    reason = serializers.CharField(allow_blank=True)
    legacy_task_count = serializers.IntegerField()
    weeks = ReportWeekSerializer(many=True)
    rules = ReportRulesSerializer(allow_null=True)


class MyWeekSerializer(serializers.Serializer):
    courses = CourseWeekSerializer(many=True)
    server_time = serializers.DateTimeField()


class CreateTargetRequestSerializer(serializers.Serializer):
    course = serializers.IntegerField(min_value=1)
    target_name = serializers.CharField(max_length=400, allow_blank=True)
    week = serializers.ChoiceField(choices=WEEK_WHICH_CHOICES, default="current")
    confirm_different = serializers.BooleanField(default=False)


class SubmitTargetRequestSerializer(serializers.Serializer):
    file_ids = serializers.ListField(
        child=serializers.IntegerField(min_value=1), required=False, allow_empty=False, max_length=50
    )
    note = serializers.CharField(required=False, allow_blank=True, max_length=2000, default="")


class TargetDetailSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    course = RefSerializer()
    task_id = serializers.IntegerField()
    week_start = serializers.DateField()
    week_label = serializers.CharField()
    due_at = serializers.DateTimeField()
    late_until = serializers.DateTimeField(allow_null=True)
    window = serializers.ChoiceField(choices=WINDOW_CHOICES)
    target_name = serializers.CharField()
    status = serializers.ChoiceField(choices=STUDENT_STATUS_CHOICES)
    can_change = serializers.BooleanField()
    lock_reason = serializers.CharField(allow_blank=True)
    is_late = serializers.BooleanField()
    minutes_late = serializers.IntegerField()
    submitted_at = serializers.DateTimeField(allow_null=True)
    version_count = serializers.IntegerField()
    revision = serializers.IntegerField()
    revision_deadline = serializers.DateTimeField(allow_null=True)
    undo_until = serializers.DateTimeField(allow_null=True)
    different_target_confirmed = serializers.BooleanField()
    draft_files = DraftFileSerializer(many=True)
    current_version = VersionSerializer(allow_null=True)
    marks_visible = serializers.BooleanField()
    grade = StudentGradeSerializer(allow_null=True)
    revision_feedback = serializers.CharField(allow_blank=True)
    marks_hidden_until_release = serializers.BooleanField()
    rules = ReportRulesSerializer()


class SubmitTargetResponseSerializer(serializers.Serializer):
    created = serializers.BooleanField()
    target = TargetDetailSerializer()


POLICY_MARKS_VISIBILITY_CHOICES = [
    ("on_grade", "Show marks as soon as they are graded"),
    ("on_release", "Release all marks together (by hand)"),
    ("auto_release", "Release automatically after the late window"),
]


class ReportPolicySerializer(serializers.Serializer):
    """Grader view and update of a course's weekly report policy."""

    course = serializers.IntegerField(read_only=True)
    self_service = serializers.BooleanField(default=False)
    due_weekday = serializers.IntegerField(min_value=0, max_value=6, default=6)
    due_time = serializers.TimeField(default="23:59")
    grace_hours = serializers.IntegerField(min_value=0, max_value=144, default=48)
    late_penalty_percent_per_day = serializers.DecimalField(
        max_digits=5, decimal_places=2, min_value=Decimal("0"), max_value=Decimal("100"), default=Decimal("10")
    )
    max_marks = serializers.DecimalField(
        max_digits=6, decimal_places=2, min_value=Decimal("0.01"), max_value=Decimal("1000"), default=Decimal("10")
    )
    max_targets_per_week = serializers.IntegerField(min_value=1, max_value=50, allow_null=True, default=None)
    marks_visibility = serializers.ChoiceField(choices=POLICY_MARKS_VISIBILITY_CHOICES, default="on_grade")
    auto_release_delay_hours = serializers.IntegerField(min_value=0, max_value=24 * 14, default=24)
    revision_window_hours = serializers.IntegerField(min_value=1, max_value=24 * 30, default=72)
    brief = serializers.CharField(required=False, allow_blank=True, max_length=20000, default="")
    allowed_file_types = serializers.ListField(
        child=serializers.ChoiceField(choices=FILE_TYPE_CHOICES), required=False, default=list
    )
    max_files = serializers.IntegerField(min_value=1, default=5)
    max_file_size_mb = serializers.IntegerField(min_value=1, default=50)
    max_total_size_mb = serializers.IntegerField(min_value=1, default=200)
    updated_at = serializers.DateTimeField(read_only=True, allow_null=True)

    def validate(self, attrs):
        files_cap = int(getattr(settings, "REPORTS_MAX_FILES_CAP", 20))
        size_cap = int(getattr(settings, "REPORTS_MAX_FILE_SIZE_MB_CAP", 200))
        if attrs.get("max_files", 5) > files_cap:
            raise serializers.ValidationError({"max_files": [f"At most {files_cap} files per report."]})
        if attrs.get("max_file_size_mb", 50) > size_cap:
            raise serializers.ValidationError({"max_file_size_mb": [f"At most {size_cap} MB per file."]})
        if attrs.get("max_total_size_mb", 200) < attrs.get("max_file_size_mb", 50):
            raise serializers.ValidationError(
                {"max_total_size_mb": ["The total limit must be at least the per-file limit."]}
            )
        return attrs
