"""Django admin for OSINT CTF exams.

* Exams come from ``manage.py load_ctf_exam``; here staff only schedule them
  (status, window, time limit, eligible batches) and publish or close them.
* Participations (scores) and attempts (every answer) are read-only records.
  Attempts are append-only in the database too.
* Answer hashes and normalisation rules are never shown.

Correct attempts contain the right answer in plain text, so grant the
"view CTF attempt" permission to trusted staff only.
"""

from __future__ import annotations

from django.contrib import admin, messages
from django.db.models import Count, F, Q
from django.http import Http404
from django.urls import path, reverse
from django.utils.html import format_html

from . import answers, exports
from .models import CtfAttempt, CtfExam, CtfParticipation, CtfQuestion


def _changelist(model, **params):
    opts = model._meta
    url = reverse(f"admin:{opts.app_label}_{opts.model_name}_changelist")
    if params:
        url += "?" + "&".join(f"{key}={value}" for key, value in params.items())
    return url


def _lines_display(value):
    value = value if isinstance(value, dict) else {}
    english = value.get("en") or []
    if isinstance(english, str):
        english = [english]
    return "\n".join(str(item) for item in english) or "-"


class CtfQuestionInline(admin.TabularInline):
    """Read-only overview; deliberately without answer hashes or normalisation."""

    model = CtfQuestion
    extra = 0
    can_delete = False
    fields = ("order", "key", "title_en", "category", "difficulty", "points", "max_attempts", "is_active", "stats")
    readonly_fields = fields
    ordering = ("order",)

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def get_queryset(self, request):
        return (
            super()
            .get_queryset(request)
            .annotate(
                _answers=Count("attempts"),
                _solves=Count("attempts", filter=Q(attempts__is_correct=True)),
            )
        )

    @admin.display(description="Title")
    def title_en(self, obj):
        return obj.title_en

    @admin.display(description="Answers / solves")
    def stats(self, obj):
        return f"{getattr(obj, '_answers', 0)} / {getattr(obj, '_solves', 0)}"


@admin.register(CtfExam)
class CtfExamAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "slug",
        "status",
        "opens_at",
        "closes_at",
        "time_limit_minutes",
        "question_count",
        "participant_count",
        "records",
    )
    list_filter = ("status",)
    search_fields = ("slug", "title", "title_ur")
    autocomplete_fields = ("eligible_courses",)
    inlines = (CtfQuestionInline,)
    actions = ("publish_selected", "close_selected")
    readonly_fields = (
        "slug",
        "title",
        "title_ur",
        "briefing_text",
        "rules_text",
        "default_max_attempts",
        "content_sha256",
        "answer_key_status",
        "content_loaded_at",
        "created_at",
        "updated_at",
        "records",
    )
    fieldsets = (
        ("Exam (from the exam file)", {"fields": ("slug", "title", "title_ur", "briefing_text", "rules_text")}),
        ("Schedule", {"fields": ("status", "opens_at", "closes_at", "time_limit_minutes")}),
        ("Who may sit it", {"fields": ("eligible_courses",)}),
        ("Results", {"fields": ("records",)}),
        (
            "Content",
            {
                "fields": (
                    "default_max_attempts",
                    "content_sha256",
                    "answer_key_status",
                    "content_loaded_at",
                    "created_at",
                    "updated_at",
                )
            },
        ),
    )

    def has_add_permission(self, request):
        return False  # exams are created by `manage.py load_ctf_exam`

    def get_queryset(self, request):
        return (
            super()
            .get_queryset(request)
            .annotate(
                _questions=Count("questions", filter=Q(questions__is_active=True), distinct=True),
                _participants=Count(
                    "participations", filter=Q(participations__is_staff_preview=False), distinct=True
                ),
            )
        )

    def get_urls(self):
        return [
            path(
                "<int:pk>/attempts.csv",
                self.admin_site.admin_view(self.attempts_csv_view),
                name="ctf_ctfexam_attempts_csv",
            ),
            path(
                "<int:pk>/scores.csv",
                self.admin_site.admin_view(self.scores_csv_view),
                name="ctf_ctfexam_scores_csv",
            ),
            *super().get_urls(),
        ]

    def _exam_or_404(self, pk):
        exam = CtfExam.objects.filter(pk=pk).first()
        if exam is None:
            raise Http404
        return exam

    def attempts_csv_view(self, request, pk):
        if not CtfAttemptAdmin.has_view_permission_for(request):
            raise Http404
        exam = self._exam_or_404(pk)
        queryset = CtfAttempt.objects.filter(exam=exam).order_by("created_at", "id")
        return exports.csv_response(
            exports.iter_attempts_csv(queryset), exports.export_filename("ctf-attempts", exam.slug)
        )

    def scores_csv_view(self, request, pk):
        if not CtfParticipationAdmin.has_view_permission_for(request):
            raise Http404
        exam = self._exam_or_404(pk)
        queryset = CtfParticipation.objects.filter(exam=exam).order_by(*LEADERBOARD_ORDERING)
        return exports.csv_response(
            exports.iter_participations_csv(queryset), exports.export_filename("ctf-scores", exam.slug)
        )

    @admin.display(description="Questions", ordering="_questions")
    def question_count(self, obj):
        return getattr(obj, "_questions", 0)

    @admin.display(description="Students", ordering="_participants")
    def participant_count(self, obj):
        return getattr(obj, "_participants", 0)

    @admin.display(description="Records")
    def records(self, obj):
        if not obj or not obj.pk:
            return "-"
        return format_html(
            '<a href="{}">Scores</a> · <a href="{}">Every answer</a> · '
            '<a href="{}">Scores CSV</a> · <a href="{}">Answers CSV</a>',
            _changelist(CtfParticipation, exam__id__exact=obj.pk),
            _changelist(CtfAttempt, exam__id__exact=obj.pk),
            reverse("admin:ctf_ctfexam_scores_csv", args=[obj.pk]),
            reverse("admin:ctf_ctfexam_attempts_csv", args=[obj.pk]),
        )

    @admin.display(description="Briefing (English)")
    def briefing_text(self, obj):
        return _lines_display(obj.briefing)

    @admin.display(description="Rules (English)")
    def rules_text(self, obj):
        return _lines_display(obj.rules)

    @admin.display(description="Answer key")
    def answer_key_status(self, obj):
        if not obj.answer_key_id:
            return "Not loaded"
        try:
            current = answers.answer_key_id()
        except answers.CtfNotConfigured:
            return "CTF_ANSWER_PEPPER is not configured"
        if obj.answer_key_id == current:
            return "Matches the server pepper"
        return "DOES NOT match the server pepper: reload the exam file"

    @admin.action(description="Publish selected exams (students can see them)")
    def publish_selected(self, request, queryset):
        done = 0
        for exam in queryset:
            problem = self._publish_problem(exam)
            if problem:
                self.message_user(request, f"{exam.slug}: {problem}", messages.WARNING)
                continue
            exam.status = CtfExam.STATUS_PUBLISHED
            exam.save(update_fields=["status", "updated_at"])
            done += 1
            if not exam.eligible_courses.exists():
                self.message_user(
                    request, f"{exam.slug}: published, but no batch is eligible yet, so no student can see it.",
                    messages.WARNING,
                )
        if done:
            self.message_user(request, f"Published {done} exam(s).", messages.SUCCESS)

    @staticmethod
    def _publish_problem(exam):
        if not exam.questions.filter(is_active=True).exists():
            return "it has no questions. Load the exam file first."
        try:
            current = answers.answer_key_id()
        except answers.CtfNotConfigured:
            return "CTF_ANSWER_PEPPER is not configured on the server."
        if exam.answer_key_id != current:
            return "its answer key was made with a different pepper. Reload the exam file."
        return ""

    @admin.action(description="Close selected exams (no more answers)")
    def close_selected(self, request, queryset):
        updated = 0
        for exam in queryset.exclude(status=CtfExam.STATUS_CLOSED):
            exam.status = CtfExam.STATUS_CLOSED
            exam.save(update_fields=["status", "updated_at"])
            updated += 1
        self.message_user(request, f"Closed {updated} exam(s).", messages.SUCCESS)


# Leaderboard order: highest score first, earlier last-correct answer wins ties.
LEADERBOARD_ORDERING = ("exam", "-score", F("last_correct_at").asc(nulls_last=True), "started_at", "id")


class _ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @classmethod
    def has_view_permission_for(cls, request):
        opts = cls.model._meta
        user = request.user
        return bool(
            user.is_active
            and user.is_staff
            and (
                user.has_perm(f"{opts.app_label}.view_{opts.model_name}")
                or user.has_perm(f"{opts.app_label}.change_{opts.model_name}")
            )
        )


class CtfAttemptInline(admin.TabularInline):
    model = CtfAttempt
    extra = 0
    can_delete = False
    fields = ("created_at", "question", "attempt_number", "submitted_answer", "is_correct", "points_awarded")
    readonly_fields = fields
    ordering = ("created_at", "id")

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("question")


@admin.register(CtfParticipation)
class CtfParticipationAdmin(_ReadOnlyAdmin):
    model = CtfParticipation
    list_display = (
        "student_email",
        "student_name",
        "exam",
        "batch_course",
        "status",
        "score",
        "solved_count",
        "wrong_count",
        "attempt_count",
        "started_at",
        "submitted_at",
        "is_staff_preview",
    )
    list_filter = ("exam", ("batch_course", admin.RelatedOnlyFieldListFilter), "status", "is_staff_preview")
    search_fields = ("user__email", "user__full_name")
    list_select_related = ("exam", "user", "batch_course")
    ordering = LEADERBOARD_ORDERING
    inlines = (CtfAttemptInline,)
    actions = ("export_scores_csv", "delete_staff_previews")
    readonly_fields = (
        "exam",
        "user",
        "batch_course",
        "is_staff_preview",
        "status",
        "started_at",
        "deadline_at",
        "submitted_at",
        "score",
        "solved_count",
        "wrong_count",
        "attempt_count",
        "last_correct_at",
        "updated_at",
    )

    @admin.display(description="Email", ordering="user__email")
    def student_email(self, obj):
        return obj.user.email

    @admin.display(description="Name", ordering="user__full_name")
    def student_name(self, obj):
        return getattr(obj.user, "full_name", "") or ""

    @admin.action(description="Export selected scores to CSV")
    def export_scores_csv(self, request, queryset):
        return exports.csv_response(
            exports.iter_participations_csv(queryset.order_by(*LEADERBOARD_ORDERING)),
            exports.export_filename("ctf-scores"),
        )

    @admin.action(description="Delete selected STAFF PREVIEW runs (students' runs are kept)")
    def delete_staff_previews(self, request, queryset):
        if not request.user.is_superuser:
            self.message_user(request, "Only superusers can delete staff preview runs.", messages.ERROR)
            return
        previews = queryset.filter(is_staff_preview=True)
        count = previews.count()
        # Collector cascade (not CtfAttempt.objects.delete) removes their attempts.
        for participation in previews:
            participation.delete()
        self.message_user(request, f"Deleted {count} staff preview run(s).", messages.SUCCESS)


class QuestionListFilter(admin.SimpleListFilter):
    """Questions of the exam picked in the Exam filter (or of every exam)."""

    title = "question"
    parameter_name = "question"

    def lookups(self, request, model_admin):
        questions = CtfQuestion.objects.select_related("exam").order_by("exam__slug", "order")
        exam_id = str(request.GET.get("exam__id__exact", "") or "")
        if exam_id.isdigit():
            questions = questions.filter(exam_id=int(exam_id))
        return [
            (str(question.pk), f"{question.exam.slug} Q{question.order}: {question.title_en[:60]}")
            for question in questions[:300]
        ]

    def queryset(self, request, queryset):
        value = str(self.value() or "")
        if value.isdigit():
            return queryset.filter(question_id=int(value))
        return queryset


@admin.register(CtfAttempt)
class CtfAttemptAdmin(_ReadOnlyAdmin):
    model = CtfAttempt
    list_display = (
        "created_at",
        "student_email",
        "exam",
        "question_label",
        "answer_preview",
        "is_correct",
        "points_awarded",
        "attempt_number",
        "ip_short",
    )
    list_filter = (
        "exam",
        QuestionListFilter,
        "is_correct",
        ("participation__batch_course", admin.RelatedOnlyFieldListFilter),
        "question__category",
    )
    date_hierarchy = "created_at"
    search_fields = ("user__email", "user__full_name", "submitted_answer")
    list_select_related = ("exam", "user", "question")
    ordering = ("-created_at", "-id")
    actions = ("export_attempts_csv",)
    fields = (
        "created_at",
        "exam",
        "question",
        "user",
        "participation",
        "attempt_number",
        "submitted_answer",
        "normalized_answer",
        "is_correct",
        "points_awarded",
        "client_ip_hash",
        "user_agent",
    )
    readonly_fields = fields

    @admin.display(description="Student", ordering="user__email")
    def student_email(self, obj):
        return obj.user.email

    @admin.display(description="Question", ordering="question__order")
    def question_label(self, obj):
        return f"Q{obj.question.order}: {obj.question.title_en[:50]}"

    @admin.display(description="Answer")
    def answer_preview(self, obj):
        text = obj.submitted_answer
        return text if len(text) <= 80 else f"{text[:77]}..."

    @admin.display(description="IP hash")
    def ip_short(self, obj):
        return obj.client_ip_hash[:10]

    @admin.action(description="Export selected answers to CSV")
    def export_attempts_csv(self, request, queryset):
        return exports.csv_response(
            exports.iter_attempts_csv(queryset.order_by("created_at", "id")), exports.export_filename("ctf-attempts")
        )
