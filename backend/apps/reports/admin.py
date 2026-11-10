"""Django admin for weekly reports.

Submissions, versions, files, grades and the audit log are read-only here:
marks change only through the grading API, which enforces optimistic
concurrency and writes the audit trail. Files are private, so the admin links
to its own staff-only download views instead of a storage URL.
"""

from django.contrib import admin, messages
from django.db.models import Count
from django.http import Http404
from django.urls import path, reverse
from django.utils.html import format_html, format_html_join

from apps.core.errors import DomainError

from . import services
from .models import (
    ReportAttachment,
    ReportCriterion,
    ReportFile,
    ReportGrade,
    ReportGradeAudit,
    ReportSubmission,
    ReportSubmissionVersion,
    ReportTask,
)
from .views import private_file_response


def _size(value):
    value = int(value or 0)
    if value >= 1024 * 1024:
        return f"{value / (1024 * 1024):.1f} MB"
    if value >= 1024:
        return f"{value / 1024:.0f} KB"
    return f"{value} B"


class _ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False


class _DownloadMixin:
    """Adds ``<pk>/download/`` (staff only, through admin_view)."""

    download_url_name = ""

    def get_urls(self):
        return [
            path(
                "<int:pk>/download/",
                self.admin_site.admin_view(self.download_view),
                name=self.download_url_name,
            ),
            *super().get_urls(),
        ]

    def download_view(self, request, pk):
        if not self.has_view_permission(request):
            raise Http404
        item = self.model.objects.filter(pk=pk).first()
        if item is None:
            raise Http404
        return self.file_response(item)


class ReportCriterionInline(admin.TabularInline):
    model = ReportCriterion
    extra = 0
    fields = ("order", "name", "max_marks", "description")


class ReportAttachmentInline(admin.TabularInline):
    model = ReportAttachment
    extra = 0
    can_delete = True
    fields = ("download", "size_label", "uploaded_by", "created_at")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False

    @admin.display(description="File")
    def download(self, obj):
        url = reverse("admin:reports_reportattachment_download", args=[obj.pk])
        return format_html('<a href="{}">{}</a>', url, obj.original_name)

    @admin.display(description="Size")
    def size_label(self, obj):
        return _size(obj.size)


@admin.register(ReportTask)
class ReportTaskAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "course",
        "week_number",
        "status",
        "due_at",
        "marks_visibility",
        "submission_count",
        "max_marks",
    )
    list_filter = ("status", "marks_visibility", "late_policy", "course")
    search_fields = ("title", "brief", "course__title")
    date_hierarchy = "due_at"
    autocomplete_fields = ("course",)
    raw_id_fields = ("section", "created_by")
    readonly_fields = ("published_at", "closed_at", "marks_released_at", "reminder_sent_at", "created_at", "updated_at")
    inlines = (ReportCriterionInline, ReportAttachmentInline)
    actions = ("publish_selected", "close_selected")
    fieldsets = (
        ("Target", {"fields": ("course", "section", "week_number", "title", "brief")}),
        ("Deadline", {"fields": ("opens_at", "due_at", "late_policy", "late_until", "late_penalty_percent_per_day")}),
        ("Marks", {"fields": ("max_marks", "marks_visibility")}),
        ("Files", {"fields": ("allowed_file_types", "max_files", "max_file_size_mb", "max_total_size_mb")}),
        (
            "State",
            {
                "fields": (
                    "status",
                    "published_at",
                    "closed_at",
                    "marks_released_at",
                    "reminder_sent_at",
                    "created_by",
                    "created_at",
                    "updated_at",
                )
            },
        ),
    )

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("course").annotate(_submissions=Count("submissions"))

    @admin.display(description="Submissions", ordering="_submissions")
    def submission_count(self, obj):
        return obj._submissions

    @admin.action(description="Publish selected tasks (notifies students)")
    def publish_selected(self, request, queryset):
        done = 0
        for task in queryset:
            try:
                services.publish_task(task=task, actor=request.user)
                done += 1
            except DomainError as exc:
                self.message_user(request, f"{task.title}: {exc.message}", messages.WARNING)
        if done:
            self.message_user(request, f"Published {done} task(s).", messages.SUCCESS)

    @admin.action(description="Close selected tasks (no more submissions)")
    def close_selected(self, request, queryset):
        done = 0
        for task in queryset:
            try:
                services.close_task(task=task)
                done += 1
            except DomainError as exc:
                self.message_user(request, f"{task.title}: {exc.message}", messages.WARNING)
        if done:
            self.message_user(request, f"Closed {done} task(s).", messages.SUCCESS)


@admin.register(ReportAttachment)
class ReportAttachmentAdmin(_DownloadMixin, _ReadOnlyAdmin):
    download_url_name = "reports_reportattachment_download"
    list_display = ("original_name", "task", "extension", "size_label", "uploaded_by", "created_at")
    list_filter = ("extension", "task__course")
    search_fields = ("original_name", "task__title")
    exclude = ("file",)
    readonly_fields = ("download", "task", "extension", "content_type", "size", "sha256", "uploaded_by", "created_at")

    @admin.display(description="File")
    def download(self, obj):
        url = reverse("admin:reports_reportattachment_download", args=[obj.pk])
        return format_html('<a href="{}">{}</a>', url, obj.original_name)

    @admin.display(description="Size", ordering="size")
    def size_label(self, obj):
        return _size(obj.size)

    def file_response(self, item):
        return private_file_response(
            item.file,
            filename=item.original_name,
            extension=item.extension,
            content_type=item.content_type,
            inline_requested=False,
        )


class ReportSubmissionVersionInline(admin.TabularInline):
    model = ReportSubmissionVersion
    extra = 0
    can_delete = False
    fields = ("number", "submitted_at", "is_late", "minutes_late", "is_revision", "file_links", "note")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False

    @admin.display(description="Files")
    def file_links(self, obj):
        return _file_links(obj.files.all())


class ReportGradeAuditInline(admin.TabularInline):
    model = ReportGradeAudit
    extra = 0
    can_delete = False
    fields = ("created_at", "actor", "action", "from_status", "to_status", "old_final_marks", "new_final_marks")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False


def _file_links(files):
    return format_html_join(
        format_html("<br>"),
        '<a href="{}">{}</a> ({})',
        (
            (reverse("admin:reports_reportfile_download", args=[item.pk]), item.original_name, _size(item.size))
            for item in files
        ),
    )


@admin.register(ReportSubmission)
class ReportSubmissionAdmin(_ReadOnlyAdmin):
    list_display = (
        "student",
        "task",
        "status",
        "submitted_at",
        "is_late",
        "minutes_late",
        "version_count",
        "final_marks",
    )
    list_filter = ("status", "is_late", "task__course", "task")
    search_fields = ("student__email", "student__full_name", "task__title")
    date_hierarchy = "submitted_at"
    readonly_fields = (
        "task",
        "student",
        "status",
        "current_version",
        "version_count",
        "first_submitted_at",
        "submitted_at",
        "is_late",
        "minutes_late",
        "revision",
        "late_digest_sent_at",
        "created_at",
        "updated_at",
    )
    inlines = (ReportSubmissionVersionInline, ReportGradeAuditInline)

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("student", "task", "grade")

    @admin.display(description="Final marks")
    def final_marks(self, obj):
        grade = getattr(obj, "grade", None)
        return grade.final_marks if grade else None


@admin.register(ReportSubmissionVersion)
class ReportSubmissionVersionAdmin(_ReadOnlyAdmin):
    list_display = ("submission", "number", "submitted_at", "is_late", "minutes_late", "is_revision")
    list_filter = ("is_late", "is_revision", "submission__task__course")
    search_fields = ("submission__student__email", "submission__student__full_name", "submission__task__title")
    exclude = ("files",)
    readonly_fields = (
        "submission",
        "number",
        "note",
        "file_links",
        "submitted_at",
        "is_late",
        "minutes_late",
        "is_revision",
        "submitted_by",
        "created_at",
    )

    @admin.display(description="Files")
    def file_links(self, obj):
        return _file_links(obj.files.all())


@admin.register(ReportFile)
class ReportFileAdmin(_DownloadMixin, _ReadOnlyAdmin):
    download_url_name = "reports_reportfile_download"
    list_display = ("original_name", "owner", "task", "extension", "size_label", "submitted", "created_at")
    list_filter = ("submitted", "extension", "task__course")
    search_fields = ("original_name", "owner__email", "owner__full_name", "task__title", "sha256")
    exclude = ("file",)
    readonly_fields = (
        "download",
        "task",
        "owner",
        "extension",
        "content_type",
        "size",
        "sha256",
        "submitted",
        "created_at",
    )

    @admin.display(description="File")
    def download(self, obj):
        url = reverse("admin:reports_reportfile_download", args=[obj.pk])
        return format_html('<a href="{}">{}</a>', url, obj.original_name)

    @admin.display(description="Size", ordering="size")
    def size_label(self, obj):
        return _size(obj.size)

    def file_response(self, item):
        return private_file_response(
            item.file,
            filename=item.original_name,
            extension=item.extension,
            content_type=item.content_type,
            inline_requested=False,
        )


@admin.register(ReportGrade)
class ReportGradeAdmin(_DownloadMixin, _ReadOnlyAdmin):
    download_url_name = "reports_reportgrade_download"
    list_display = ("submission", "raw_marks", "late_penalty", "final_marks", "graded_by", "graded_at")
    list_filter = ("graded_at", "submission__status", "submission__task__course")
    search_fields = ("submission__student__email", "submission__student__full_name", "submission__task__title")
    exclude = ("annotated_file",)
    readonly_fields = (
        "submission",
        "raw_marks",
        "late_penalty",
        "final_marks",
        "criteria_marks",
        "feedback",
        "revision_feedback",
        "annotated_link",
        "graded_version",
        "graded_by",
        "graded_at",
        "returned_at",
        "created_at",
        "updated_at",
    )

    @admin.display(description="Annotated file")
    def annotated_link(self, obj):
        if not obj.annotated_file:
            return "-"
        url = reverse("admin:reports_reportgrade_download", args=[obj.pk])
        return format_html('<a href="{}">{}</a>', url, obj.annotated_file_name)

    def file_response(self, item):
        if not item.annotated_file:
            raise Http404
        return private_file_response(
            item.annotated_file,
            filename=item.annotated_file_name,
            extension=item.annotated_extension,
            content_type=item.annotated_content_type,
            inline_requested=False,
        )


@admin.register(ReportGradeAudit)
class ReportGradeAuditAdmin(_ReadOnlyAdmin):
    list_display = (
        "created_at",
        "submission",
        "actor",
        "action",
        "from_status",
        "to_status",
        "old_final_marks",
        "new_final_marks",
    )
    list_filter = ("action", "created_at", "submission__task__course")
    search_fields = ("submission__student__email", "submission__task__title", "actor__email")
    date_hierarchy = "created_at"
    readonly_fields = (
        "submission",
        "actor",
        "action",
        "from_status",
        "to_status",
        "old_final_marks",
        "new_final_marks",
        "details",
        "created_at",
    )

    def has_delete_permission(self, request, obj=None):
        return False
