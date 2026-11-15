"""Django admin for OSINT CTF exams.

* Exams come from ``manage.py load_ctf_exam``; here staff only schedule them
  (status, window, time limit, eligible batches) and publish or close them.
* Participations (scores) and attempts (every answer) are read-only records.
  Attempts are append-only in the database too.
* Answer hashes and normalisation rules are never shown.

Correct attempts contain the right answer in plain text, so grant the
"view CTF attempt" permission to trusted staff only.

These screens form the sidebar section "Examination" (see
``examination_admin.py``): the full student identity (roll number, REAL NAME,
most recent handle, stats) lives here. The Console shows handles only.
"""

from __future__ import annotations

from django.contrib import admin, messages
from django.db.models import Count, F, Q
from django.http import Http404
from django.urls import path, reverse
from django.utils import timezone
from django.utils.html import format_html

from apps.core.errors import DomainError
from apps.users.identity_admin import IDENTITY_LIST_DISPLAY, StudentIdentityAdminMixin

from . import answers, console, exports
from .models import CtfAttempt, CtfExam, CtfExamResult, CtfMaterial, CtfParticipation, CtfQuestion


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
        "state_label",
        "status",
        "opens_at",
        "closes_at",
        "time_limit_minutes",
        "batches",
        "question_count",
        "participant_count",
        "results_finalized_at",
        "records",
    )
    list_filter = ("status", "auto_publish", ("eligible_courses", admin.RelatedOnlyFieldListFilter))
    search_fields = ("slug", "title", "title_ur")
    autocomplete_fields = ("eligible_courses",)
    inlines = (CtfQuestionInline,)
    actions = ("publish_selected", "unschedule_selected", "close_selected")
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
        "state_label",
        "auto_publish",
        "published_at",
        "closed_at",
        "results_finalized_at",
        "results_notified_at",
        "stats_text",
    )
    fieldsets = (
        ("Exam (from the exam file)", {"fields": ("slug", "title", "title_ur", "briefing_text", "rules_text")}),
        (
            "Schedule",
            {
                "fields": (
                    "state_label",
                    "status",
                    "opens_at",
                    "closes_at",
                    "time_limit_minutes",
                    "auto_publish",
                    "published_at",
                    "closed_at",
                )
            },
        ),
        ("Who may sit it", {"fields": ("eligible_courses",)}),
        ("Results", {"fields": ("stats_text", "results_finalized_at", "results_notified_at", "records")}),
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
            .prefetch_related("eligible_courses")
        )

    @admin.display(description="State")
    def state_label(self, obj):
        if not obj or not obj.pk:
            return "-"
        return console.exam_state(obj).replace("_", " ").capitalize()

    @admin.display(description="Eligible batches")
    def batches(self, obj):
        names = [course.title for course in obj.eligible_courses.all()]
        return ", ".join(names) if names else "None yet"

    @admin.display(description="Stats (as in the Console)")
    def stats_text(self, obj):
        if not obj or not obj.pk:
            return "-"
        stats = console._participation_counts(obj)
        average = "-" if stats["average_score"] is None else f"{stats['average_score']:g}"
        top = "-" if stats["top_score"] is None else stats["top_score"]
        return (
            f"{stats['participants']} students · {stats['active']} active · {stats['submitted']} submitted · "
            f"{stats['expired']} expired · average {average} · top {top}"
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
        # Full identity (real name, e-mail): admins only.
        if not CtfAttemptAdmin.has_view_permission_for(request):
            raise Http404
        exam = self._exam_or_404(pk)
        queryset = CtfAttempt.objects.filter(exam=exam).order_by("created_at", "id")
        return exports.csv_response(
            exports.iter_attempts_csv(queryset), exports.export_filename("ctf-attempts", exam.slug)
        )

    def scores_csv_view(self, request, pk):
        # Full identity (real name, e-mail): admins only.
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
        from apps.certification.models import CertificationDecision

        return format_html(
            '<a href="{}">Results</a> · <a href="{}">Every answer</a> · <a href="{}">Questions</a> · '
            '<a href="{}">Final results</a> · <a href="{}">Certification</a> · '
            '<a href="{}">Results CSV</a> · <a href="{}">Answers CSV</a>',
            _changelist(CtfParticipation, exam__id__exact=obj.pk),
            _changelist(CtfAttempt, exam__id__exact=obj.pk),
            _changelist(CtfQuestion, exam__id__exact=obj.pk),
            _changelist(CtfExamResult, exam__id__exact=obj.pk),
            _changelist(CertificationDecision, exam__id__exact=obj.pk),
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
            return answers.exams_disabled_reason() or "CTF_ANSWER_PEPPER is not configured"
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
            exam.auto_publish = False
            # published_at lets ctf.scheduler send the "exam open" notice once.
            exam.published_at = exam.published_at or timezone.now()
            exam.save(update_fields=["status", "auto_publish", "published_at", "updated_at"])
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
            return answers.exams_disabled_reason() or "CTF_ANSWER_PEPPER is not configured on the server."
        if exam.answer_key_id != current:
            return "its answer key was made with a different pepper. Reload the exam file."
        return ""

    @admin.action(description="Take selected exams off the schedule (back to draft, as in the Console)")
    def unschedule_selected(self, request, queryset):
        done = 0
        for exam in queryset:
            try:
                console.unschedule_exam(exam)
            except DomainError as exc:
                self.message_user(request, f"{exam.slug}: {getattr(exc, 'message', None) or exc}", messages.WARNING)
                continue
            done += 1
        if done:
            self.message_user(request, f"Took {done} exam(s) off the schedule.", messages.SUCCESS)

    @admin.action(description="Close selected exams (no more answers)")
    def close_selected(self, request, queryset):
        updated = 0
        for exam in queryset.exclude(status=CtfExam.STATUS_CLOSED):
            exam.status = CtfExam.STATUS_CLOSED
            exam.closed_at = timezone.now()
            exam.save(update_fields=["status", "closed_at", "updated_at"])
            updated += 1
        self.message_user(request, f"Closed {updated} exam(s).", messages.SUCCESS)


# Leaderboard order: highest score first, earlier last-correct answer wins ties.
LEADERBOARD_ORDERING = ("exam", "-score", F("last_correct_at").asc(nulls_last=True), "started_at", "id")


def leaderboard_ranks(exam_ids):
    """``{participation id: rank}`` for the exams, exactly as the Console ranks them
    (staff previews unranked; equal score and last-correct time share a rank)."""
    from .scheduler import leaderboard

    ranks = {}
    for exam_id in exam_ids:
        previous_key, rank = None, 0
        rows = leaderboard(CtfExam(pk=exam_id)).values_list("pk", "score", "last_correct_at")
        for position, (pk, score, last_correct_at) in enumerate(rows, 1):
            key = (score, last_correct_at)
            if key != previous_key:
                rank, previous_key = position, key
            ranks[pk] = rank
    return ranks


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
class CtfParticipationAdmin(StudentIdentityAdminMixin, _ReadOnlyAdmin):
    model = CtfParticipation
    # Owner rule: roll number, real name, handle, stats first; then the record.
    list_display = (
        *IDENTITY_LIST_DISPLAY,
        "student_email",
        "exam",
        "batch_course",
        "rank",
        "status",
        "score",
        "solved_count",
        "wrong_count",
        "attempt_count",
        "started_at",
        "deadline_at",
        "submitted_at",
        "is_staff_preview",
    )
    list_filter = ("exam", ("batch_course", admin.RelatedOnlyFieldListFilter), "status", "is_staff_preview")
    # Roll numbers (AL-SYD-00042) are matched by StudentIdentityAdminMixin.
    search_fields = (
        "user__email",
        "user__full_name",
        "user__student_profile__handle",
        "student_handle_snapshot",
        "student_name_snapshot",
    )
    list_select_related = ("exam", "user", "batch_course")
    ordering = LEADERBOARD_ORDERING
    inlines = (CtfAttemptInline,)
    actions = ("export_scores_csv", "delete_staff_previews")
    readonly_fields = (
        "exam",
        "user",
        "student_roll_number",
        "student_name_snapshot",
        "student_handle_snapshot",
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

    def get_changelist_instance(self, request):
        changelist = super().get_changelist_instance(request)
        ranks = leaderboard_ranks({row.exam_id for row in changelist.result_list})
        for row in changelist.result_list:
            row._rank = ranks.get(row.pk)
        return changelist

    @admin.display(description="Rank")
    def rank(self, obj):
        if not hasattr(obj, "_rank"):
            obj._rank = leaderboard_ranks({obj.exam_id}).get(obj.pk)
        return obj._rank if obj._rank is not None else "-"

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
class CtfAttemptAdmin(StudentIdentityAdminMixin, _ReadOnlyAdmin):
    model = CtfAttempt
    identity_record_attr = "participation"
    list_display = (
        *IDENTITY_LIST_DISPLAY,
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
        "participation__status",
        "question__category",
    )
    date_hierarchy = "created_at"
    # Roll numbers (AL-SYD-00042) are matched by StudentIdentityAdminMixin.
    search_fields = (
        "user__email",
        "user__full_name",
        "user__student_profile__handle",
        "participation__student_handle_snapshot",
        "submitted_answer",
    )
    list_select_related = ("exam", "user", "question", "participation")
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

    @admin.display(description="Email", ordering="user__email")
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



# --- Phase 3: gradebook entries and Console-uploaded evidence (read only) ---
@admin.register(CtfExamResult)
class CtfExamResultAdmin(StudentIdentityAdminMixin, admin.ModelAdmin):
    """Written by ctf.scheduler when an exam closes; never edited by hand."""

    list_display = (
        *IDENTITY_LIST_DISPLAY,
        "student_email",
        "exam",
        "batch_course",
        "rank",
        "score",
        "total_points",
        "percent",
        "solved_count",
        "question_count",
        "status",
        "finalized_at",
        "notified_at",
    )
    list_filter = ("exam", ("batch_course", admin.RelatedOnlyFieldListFilter), "status")
    # Roll numbers (AL-SYD-00042) are matched by StudentIdentityAdminMixin.
    search_fields = (
        "user__email",
        "user__full_name",
        "user__student_profile__handle",
        "student_handle_snapshot",
        "exam__slug",
    )
    ordering = ("exam", F("rank").asc(nulls_last=True), "id")
    list_select_related = ("exam", "user", "batch_course")

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    @admin.display(description="Email", ordering="user__email")
    def student_email(self, obj):
        return obj.user.email

    @admin.display(description="%")
    def percent(self, obj):
        if not obj.total_points:
            return "-"
        return f"{obj.score * 100 / obj.total_points:.1f}"


@admin.register(CtfMaterial)
class CtfMaterialAdmin(admin.ModelAdmin):
    """Uploaded from Console -> Exams. The file itself is served only through
    signed URLs, so no link to it is shown here."""

    list_display = ("exam", "path", "size", "uploaded_by", "updated_at")
    list_filter = ("exam",)
    fields = ("exam", "path", "original_name", "content_type", "size", "sha256", "uploaded_by", "created_at", "updated_at")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

# Monthly OSINT CTF seasons (season_admin.py registers its own admins) and
# Django admin -> Examination (questions, the combined gradebook).
from . import examination_admin, season_admin  # noqa: E402,F401
