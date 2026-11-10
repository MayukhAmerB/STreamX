"""Admin visibility for class recordings: states, sizes, retry and OBS replacement."""

from datetime import timedelta

from django import forms
from django.contrib import admin, messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.http import HttpResponseRedirect
from django.shortcuts import get_object_or_404
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils import timezone
from django.utils.formats import date_format
from django.utils.html import format_html

from . import replacement, services
from .models import ClassRecording


def _human_bytes(value):
    if not value:
        return "-"
    size = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f} {unit}" if unit in {"B", "KB"} else f"{size:.1f} {unit}"
        size /= 1024
    return "-"


class ObsUploadAdminForm(forms.Form):
    video_file = forms.FileField(
        label="OBS recording",
        help_text=(
            "The file OBS saved on the instructor's computer (MP4/MOV, or OBS's default MKV, FLV or TS, "
            "which the stream recorder converts to MP4 first). Up to 5 GB. It replaces the lecture video; the "
            "lecture, its likes, comments and views are kept, and the video is re-transcoded."
        ),
    )


@admin.register(ClassRecording)
class ClassRecordingAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "session",
        "source",
        "state",
        "module",
        "lecture_link",
        "captured_size",
        "file_size",
        "duration_display",
        "recorder_status",
        "error_preview",
        "row_actions",
        "created_at",
    )
    list_display_links = ("id",)
    list_filter = ("state", "source", "created_at")
    search_fields = ("session__title", "module__title", "lecture__title", "error")
    list_select_related = ("session", "module", "lecture")
    readonly_fields = [field.name for field in ClassRecording._meta.fields] + ["lecture_link", "row_actions"]
    actions = ("retry_selected",)
    list_per_page = 50

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        # Read-only detail page; changes go through retry/replace only.
        return super().has_change_permission(request, obj) if obj is None else False

    def has_view_permission(self, request, obj=None):
        return super().has_view_permission(request, obj) or super().has_change_permission(request, obj)

    @admin.display(description="Lecture")
    def lecture_link(self, obj):
        if not obj.lecture_id:
            return "-"
        url = reverse("admin:courses_lecture_change", args=[obj.lecture_id])
        published = "published" if obj.lecture.is_published else obj.lecture.stream_status
        return format_html('<a href="{}">#{} {}</a> ({})', url, obj.lecture_id, obj.lecture.title, published)

    @admin.display(description="Captured", ordering="captured_bytes")
    def captured_size(self, obj):
        return _human_bytes(obj.captured_bytes)

    @admin.display(description="File size", ordering="file_size_bytes")
    def file_size(self, obj):
        return _human_bytes(obj.file_size_bytes)

    @admin.display(description="Duration", ordering="duration_seconds")
    def duration_display(self, obj):
        if not obj.duration_seconds:
            return "-"
        minutes, seconds = divmod(int(obj.duration_seconds), 60)
        hours, minutes = divmod(minutes, 60)
        return f"{hours}:{minutes:02d}:{seconds:02d}"

    @admin.display(description="Recorder")
    def recorder_status(self, obj):
        if obj.state != ClassRecording.STATE_RECORDING:
            return "-"
        if not obj.recorder_heartbeat_at:
            return "waiting for recorder"
        if timezone.now() - obj.recorder_heartbeat_at > timedelta(seconds=60):
            return format_html(
                '<span class="enterprise-status enterprise-status--error">'
                '<svg class="enterprise-icon" aria-hidden="true"><use href="#icon-error"></use></svg>'
                'Offline since {}</span>',
                date_format(timezone.localtime(obj.recorder_heartbeat_at), "DATETIME_FORMAT"),
            )
        return f"{obj.part_count} part(s)"

    @admin.display(description="Error")
    def error_preview(self, obj):
        text = obj.error or ""
        return text if len(text) <= 90 else f"{text[:87]}..."

    @admin.display(description="Actions")
    def row_actions(self, obj):
        if not obj.pk or not obj.session_id:
            return "-"
        url = reverse("admin:realtime_classrecording_obs_upload", args=[obj.pk])
        label = "Replace with OBS recording" if obj.lecture_id else "Upload OBS recording"
        return format_html('<a href="{}">{}</a>', url, label)

    @admin.action(description="Retry selected failed recordings", permissions=("change",))
    def retry_selected(self, request, queryset):
        queued = 0
        for recording in queryset.select_related("session", "lecture"):
            if services.can_retry(recording) and services.retry(recording, request=request):
                queued += 1
        skipped = queryset.count() - queued
        self.message_user(request, f"{queued} recording(s) queued for retry; {skipped} skipped (not failed).", messages.INFO)

    def get_urls(self):
        custom = [
            path(
                "<int:recording_id>/obs-upload/",
                self.admin_site.admin_view(self.obs_upload_view),
                name="realtime_classrecording_obs_upload",
            ),
        ]
        return custom + super().get_urls()

    def obs_upload_view(self, request, recording_id):
        recording = get_object_or_404(
            ClassRecording.objects.select_related("session", "lecture", "module"), pk=recording_id
        )
        if not super().has_change_permission(request, recording) or recording.session is None:
            raise PermissionDenied
        form = ObsUploadAdminForm(request.POST or None, request.FILES or None)
        if request.method == "POST" and form.is_valid():
            try:
                created = replacement.replace_with_obs_upload(
                    session=recording.session,
                    uploaded_file=form.cleaned_data["video_file"],
                    user=request.user,
                    recording=recording if recording.lecture_id else None,
                    request=request,
                )
            except ValidationError as exc:
                for message in exc.messages:
                    form.add_error(None, message)
            else:
                self.log_change(request, recording, f"Replaced with OBS upload (class recording #{created.pk}).")
                if created.state == ClassRecording.STATE_FINALIZING:
                    messages.success(
                        request,
                        "OBS recording uploaded. The stream recorder converts it to MP4, then the lecture is "
                        "re-transcoded.",
                    )
                else:
                    messages.success(request, "OBS recording uploaded. The lecture is being re-transcoded.")
                return HttpResponseRedirect(reverse("admin:realtime_classrecording_changelist"))
        context = {
            **self.admin_site.each_context(request),
            "opts": self.model._meta,
            "title": "Replace with OBS recording",
            "recording": recording,
            "form": form,
        }
        return TemplateResponse(request, "realtime/admin/class_recording_obs_upload.html", context)
