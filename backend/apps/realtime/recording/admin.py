"""Admin for class recordings: every recording (live, finished, imported) in one list.

List: course, module, class, date, source, duration, size, state, lecture.
Change page: a staff-only player (``<id>/media/``) and download, and the
actions publish/unpublish lecture, move to another module of the course,
retry, delete recording files (confirmation page), publish an imported
recording to a module, and replace with the OBS file. "Scan for existing
recordings" lists videos already on the server as imported recordings.

Every custom view is wrapped in ``admin_site.admin_view`` (active staff only)
and additionally checks the model's view/change permission.
"""

from datetime import timedelta
from pathlib import Path

from django import forms
from django.contrib import admin, messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.db.models import Q
from django.http import HttpResponseRedirect
from django.shortcuts import get_object_or_404
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils import timezone
from django.utils.formats import date_format
from django.utils.html import format_html, format_html_join
from django.utils.safestring import mark_safe

from apps.courses.models import Course, Section

from . import importer, replacement, services
from .media import staff_file_response
from .models import ClassRecording

R = ClassRecording

SOURCE_LABELS = {
    R.SOURCE_SERVER: "Server capture",
    R.SOURCE_OBS_UPLOAD: "OBS upload",
    R.SOURCE_LIVEKIT_EGRESS: "Host Studio",
    R.SOURCE_IMPORTED: "Imported",
}
# state -> (css modifier, icon, label)
STATE_BADGES = {
    R.STATE_IMPORTED: ("neutral", "document", "Imported (unassigned)"),
    R.STATE_RECORDING: ("active", "video", "Recording"),
    R.STATE_FINALIZING: ("active", "time", "Finalizing"),
    R.STATE_PROCESSING: ("active", "renew", "Processing"),
    R.STATE_PUBLISHED: ("success", "checkmark", "Published"),
    R.STATE_FAILED: ("error", "error", "Failed"),
}


def _human_bytes(value):
    if not value:
        return "-"
    size = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f} {unit}" if unit in {"B", "KB"} else f"{size:.1f} {unit}"
        size /= 1024
    return "-"


def _duration(seconds):
    if not seconds:
        return "-"
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}"


def status_chip(modifier, icon, label):
    return format_html(
        '<span class="enterprise-status enterprise-status--{} class-recording-chip">'
        '<svg class="enterprise-icon" aria-hidden="true"><use href="#icon-{}"></use></svg>{}</span>',
        modifier,
        icon,
        label,
    )


def recording_course(obj):
    if obj.lecture_id and obj.lecture is not None:
        return obj.lecture.section.course
    if obj.module_id and obj.module is not None:
        return obj.module.course
    if obj.session_id and obj.session is not None:
        return obj.session.linked_course
    return None


def recording_module(obj):
    if obj.lecture_id and obj.lecture is not None:
        return obj.lecture.section
    return obj.module


def recording_title(obj):
    if obj.session_id and obj.session is not None:
        return obj.session.title
    name = Path(obj.source_path or obj.work_dir or "").name
    return name or f"Recording #{obj.pk}"


def lecture_chip(lecture):
    if lecture is None:
        return "-"
    url = reverse("admin:courses_lecture_change", args=[lecture.pk])
    if lecture.is_published:
        chip = status_chip("success", "checkmark", "Published")
    elif lecture.stream_status == lecture.STREAM_READY:
        chip = status_chip("warning", "warning", "Unpublished")
    else:
        chip = status_chip("neutral", "time", f"Unpublished, {lecture.get_stream_status_display().lower()}")
    return format_html('<a href="{}">#{} {}</a><br>{}', url, lecture.pk, lecture.title, chip)


# ------------------------------------------------------------------ filters


class CourseFilter(admin.SimpleListFilter):
    title = "course"
    parameter_name = "course"

    def lookups(self, request, model_admin):
        courses = (
            Course.objects.filter(
                Q(sections__class_recordings__isnull=False)
                | Q(sections__lectures__class_recordings__isnull=False)
                | Q(realtime_sessions__class_recordings__isnull=False)
            )
            .distinct()
            .order_by("title")
        )
        return [(str(course.pk), course.title) for course in courses]

    def queryset(self, request, queryset):
        value = self.value()
        if not value or not value.isdigit():
            return queryset
        return queryset.filter(
            Q(lecture__section__course_id=value)
            | Q(lecture__isnull=True, module__course_id=value)
            | Q(lecture__isnull=True, module__isnull=True, session__linked_course_id=value)
        )


class ModuleFilter(admin.SimpleListFilter):
    title = "module"
    parameter_name = "module"

    def lookups(self, request, model_admin):
        modules = Section.objects.filter(
            Q(class_recordings__isnull=False) | Q(lectures__class_recordings__isnull=False)
        ).select_related("course")
        course = str(request.GET.get(CourseFilter.parameter_name) or "")
        if course.isdigit():
            modules = modules.filter(course_id=int(course))
        modules = modules.distinct().order_by("course__title", "order", "id")
        return [(str(module.pk), f"{module.course.title} - {module.title}") for module in modules]

    def queryset(self, request, queryset):
        value = self.value()
        if not value or not value.isdigit():
            return queryset
        return queryset.filter(Q(lecture__section_id=value) | Q(lecture__isnull=True, module_id=value))


class SourceFilter(admin.SimpleListFilter):
    title = "source"
    parameter_name = "source"

    def lookups(self, request, model_admin):
        return list(SOURCE_LABELS.items())

    def queryset(self, request, queryset):
        return queryset.filter(source=self.value()) if self.value() in SOURCE_LABELS else queryset


class StateFilter(admin.SimpleListFilter):
    title = "state"
    parameter_name = "state"

    def lookups(self, request, model_admin):
        return [(key, badge[2]) for key, badge in STATE_BADGES.items()]

    def queryset(self, request, queryset):
        return queryset.filter(state=self.value()) if self.value() in STATE_BADGES else queryset


# -------------------------------------------------------------------- forms


def module_choices(course_id=None):
    modules = Section.objects.select_related("course").order_by("course__title", "order", "id")
    if course_id:
        modules = modules.filter(course_id=course_id)
    grouped = {}
    for module in modules:
        grouped.setdefault(module.course.title, []).append((module.pk, module.title))
    return [("", "---------")] + [(course, items) for course, items in grouped.items()]


class ModuleChoiceForm(forms.Form):
    module = forms.TypedChoiceField(coerce=int, label="Module")

    def __init__(self, *args, course_id=None, initial_module=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["module"].choices = module_choices(course_id)
        if initial_module is not None:
            self.fields["module"].initial = initial_module.pk

    def clean_module(self):
        module = Section.objects.select_related("course").filter(pk=self.cleaned_data["module"]).first()
        if module is None:
            raise ValidationError("Choose a module.")
        return module


class DeleteFilesForm(forms.Form):
    kinds = forms.MultipleChoiceField(widget=forms.CheckboxSelectMultiple, label="Delete")
    confirm_published = forms.BooleanField(
        required=False,
        label="Yes, delete the video of this PUBLISHED lecture. Students keep the stream that was already "
        "built, but it can never be re-processed, played here or downloaded again.",
    )

    def __init__(self, *args, files=(), **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["kinds"].choices = [
            (item.kind, f"{item.label}: {item.path} ({_human_bytes(item.size)})") for item in files if item.exists
        ]
        self.fields["kinds"].initial = [item.kind for item in files if item.exists and item.kind != "lecture_video"]


class ObsUploadAdminForm(forms.Form):
    video_file = forms.FileField(
        label="OBS recording",
        help_text=(
            "The file OBS saved on the instructor's computer (MP4/MOV, or OBS's default MKV, FLV or TS, "
            "which the stream recorder converts to MP4 first). Up to 5 GB. It replaces the lecture video; the "
            "lecture, its likes, comments and views are kept, and the video is re-transcoded."
        ),
    )


# -------------------------------------------------------------------- admin


@admin.register(ClassRecording)
class ClassRecordingAdmin(admin.ModelAdmin):
    change_list_template = "realtime/admin/class_recording_change_list.html"
    list_display = (
        "id",
        "class_display",
        "course_module_display",
        "source_display",
        "state_display",
        "duration_display",
        "size_display",
        "lecture_display",
        "row_actions",
    )
    list_display_links = ("id", "class_display")
    list_filter = (CourseFilter, ModuleFilter, SourceFilter, StateFilter, ("started_at", admin.DateFieldListFilter))
    search_fields = (
        "session__title",
        "module__title",
        "module__course__title",
        "session__linked_course__title",
        "lecture__title",
        "source_path",
        "work_dir",
        "error",
    )
    list_select_related = (
        "session",
        "session__linked_course",
        "module",
        "module__course",
        "lecture",
        "lecture__section",
        "lecture__section__course",
    )
    ordering = ("-created_at", "-id")
    date_hierarchy = None
    actions = ("publish_lectures", "unpublish_lectures", "retry_selected")
    list_per_page = 50
    fieldsets = (
        (None, {"fields": ("player_panel",)}),
        (
            "Class",
            {
                "fields": (
                    "class_display",
                    "course_display",
                    "module_display",
                    "session",
                    "source_display",
                    "state_display",
                    "lecture_display",
                    "date_display",
                )
            },
        ),
        (
            "Files",
            {"fields": ("files_panel", "duration_display", "size_display", "part_count", "attempts", "files_deleted_at")},
        ),
        (
            "Timeline",
            {
                "classes": ("collapse",),
                "fields": (
                    "started_at",
                    "stop_requested_at",
                    "finalized_at",
                    "published_at",
                    "recorder_heartbeat_at",
                    "created_at",
                    "updated_at",
                ),
            },
        ),
        ("Error", {"fields": ("error",)}),
    )
    readonly_fields = (
        "player_panel",
        "class_display",
        "course_display",
        "module_display",
        "session",
        "source_display",
        "state_display",
        "lecture_display",
        "date_display",
        "files_panel",
        "duration_display",
        "size_display",
        "part_count",
        "attempts",
        "files_deleted_at",
        "started_at",
        "stop_requested_at",
        "finalized_at",
        "published_at",
        "recorder_heartbeat_at",
        "created_at",
        "updated_at",
        "error",
    )

    class Media:
        css = {"all": ("admin/css/class_recordings.css",)}

    # ------------------------------------------------------- permissions
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        # Read-only detail page; changes go through the action views only.
        return super().has_change_permission(request, obj) if obj is None else False

    def has_view_permission(self, request, obj=None):
        return super().has_view_permission(request, obj) or super().has_change_permission(request, obj)

    def _can_change(self, request, obj=None):
        return super().has_change_permission(request, obj)

    # ----------------------------------------------------------- columns
    @admin.display(description="Class", ordering="session__title")
    def class_display(self, obj):
        when = obj.started_at or obj.created_at
        stamp = date_format(timezone.localtime(when), "DATETIME_FORMAT") if when else ""
        return format_html('<strong>{}</strong><br><span class="class-recording-muted">{}</span>',
                           recording_title(obj), stamp)

    @admin.display(description="Date", ordering="started_at")
    def date_display(self, obj):
        when = obj.started_at or obj.created_at
        return date_format(timezone.localtime(when), "DATETIME_FORMAT") if when else "-"

    @admin.display(description="Course")
    def course_display(self, obj):
        course = recording_course(obj)
        return course.title if course is not None else "-"

    @admin.display(description="Course / module")
    def course_module_display(self, obj):
        course = recording_course(obj)
        return format_html(
            '{}<br><span class="class-recording-muted">{}</span>',
            self.module_display(obj),
            course.title if course is not None else "no course",
        )

    @admin.display(description="Module")
    def module_display(self, obj):
        module = recording_module(obj)
        if module is None:
            return status_chip("warning", "warning", "Unassigned") if obj.source == R.SOURCE_IMPORTED else "-"
        return module.title

    @admin.display(description="Source", ordering="source")
    def source_display(self, obj):
        return SOURCE_LABELS.get(obj.source, obj.get_source_display())

    @admin.display(description="State", ordering="state")
    def state_display(self, obj):
        modifier, icon, label = STATE_BADGES.get(obj.state, ("neutral", "information", obj.get_state_display()))
        chip = status_chip(modifier, icon, label)
        note = ""
        if obj.state == R.STATE_RECORDING:
            if not obj.recorder_heartbeat_at:
                note = "waiting for recorder"
            elif timezone.now() - obj.recorder_heartbeat_at > timedelta(seconds=60):
                note = "recorder offline since " + date_format(
                    timezone.localtime(obj.recorder_heartbeat_at), "DATETIME_FORMAT"
                )
            else:
                note = f"{obj.part_count} part(s), {_human_bytes(obj.captured_bytes)}"
        elif obj.state == R.STATE_FAILED and obj.error:
            note = obj.error if len(obj.error) <= 90 else f"{obj.error[:87]}..."
        if obj.delete_requested_at:
            note = (note + " " if note else "") + "(file deletion queued for the recorder)"
        if note:
            return format_html('{}<br><span class="class-recording-muted">{}</span>', chip, note)
        return chip

    @admin.display(description="Duration", ordering="duration_seconds")
    def duration_display(self, obj):
        return _duration(obj.duration_seconds)

    @admin.display(description="Size", ordering="file_size_bytes")
    def size_display(self, obj):
        return _human_bytes(obj.file_size_bytes or obj.captured_bytes or obj.source_size_bytes)

    @admin.display(description="Lecture")
    def lecture_display(self, obj):
        return lecture_chip(obj.lecture if obj.lecture_id else None)

    @admin.display(description="Actions")
    def row_actions(self, obj):
        links = self._action_links(obj, compact=True)
        return format_html_join(mark_safe(" &middot; "), '<a href="{}">{}</a>', links) if links else "-"

    def _action_links(self, obj, *, compact=False):
        if not obj.pk:
            return []
        links = []

        def url(name):
            return reverse(f"admin:realtime_classrecording_{name}", args=[obj.pk])

        if services.can_publish_to_module(obj):
            links.append((url("assign"), "Publish to module"))
        lecture = obj.lecture if obj.lecture_id else None
        if lecture is not None:
            if lecture.is_published:
                links.append((url("unpublish"), "Unpublish lecture"))
            elif lecture.stream_status == lecture.STREAM_READY:
                links.append((url("publish"), "Publish lecture"))
        if services.can_retry(obj):
            links.append((url("retry"), "Retry"))
        if compact:
            return links
        if obj.state != R.STATE_FINALIZING and (obj.lecture_id or obj.module_id or obj.session_id):
            links.append((url("move"), "Move to another module"))
        if obj.session_id:
            label = "Replace with OBS recording" if obj.lecture_id else "Upload OBS recording"
            links.append((url("obs_upload"), label))
        if obj.state not in R.ACTIVE_STATES and any(item.exists for item in services.recording_files(obj)):
            links.append((url("delete_files"), "Delete recording files"))
        return links

    @admin.display(description="Video")
    def player_panel(self, obj):
        path, playable = services.playable_file(obj)
        media_url = reverse("admin:realtime_classrecording_media", args=[obj.pk])
        if path is None:
            body = format_html(
                '<p class="class-recording-muted">No playable video file on the server for this recording{}.</p>',
                " yet" if obj.state in (R.STATE_RECORDING, R.STATE_FINALIZING) else "",
            )
        elif playable:
            body = format_html(
                '<video class="class-recording-player" controls preload="metadata" src="{}"></video>'
                '<p><a class="button" href="{}?download=1" download>Download {} ({})</a></p>',
                media_url,
                media_url,
                path.name,
                _human_bytes(services._size(path)),
            )
        else:
            body = format_html(
                '<p class="class-recording-muted">{} files do not play in browsers.</p>'
                '<p><a class="button" href="{}?download=1" download>Download {} ({})</a></p>',
                path.suffix.lstrip(".").upper() or "These",
                media_url,
                path.name,
                _human_bytes(services._size(path)),
            )
        actions = format_html_join(
            "", '<a class="button class-recording-action" href="{}">{}</a>', self._action_links(obj)
        )
        return format_html('<div class="class-recording-panel">{}<div class="class-recording-actions">{}</div></div>',
                           body, actions)

    @admin.display(description="Files on the server")
    def files_panel(self, obj):
        files = services.recording_files(obj)
        if not files:
            return "-"
        rows = format_html_join(
            "",
            "<li><strong>{}</strong>: <code>{}</code> ({})</li>",
            (
                (item.label, item.path, _human_bytes(item.size) if item.exists else "missing")
                for item in files
            ),
        )
        return format_html('<ul class="class-recording-files">{}</ul>', rows)

    # ------------------------------------------------------ bulk actions
    def _bulk_publish(self, request, queryset, published):
        changed, refused = 0, []
        for recording in queryset.select_related("lecture"):
            try:
                if services.set_lecture_published(recording, published, request=request):
                    changed += 1
            except ValidationError as exc:
                refused.append(f"#{recording.pk}: {' '.join(exc.messages)}")
        verb = "published" if published else "unpublished"
        self.message_user(request, f"{changed} lecture(s) {verb}.", messages.SUCCESS if changed else messages.INFO)
        for line in refused[:10]:
            self.message_user(request, line, messages.WARNING)

    @admin.action(description="Publish the lectures of the selected recordings", permissions=("change",))
    def publish_lectures(self, request, queryset):
        self._bulk_publish(request, queryset, True)

    @admin.action(description="Unpublish the lectures of the selected recordings", permissions=("change",))
    def unpublish_lectures(self, request, queryset):
        self._bulk_publish(request, queryset, False)

    @admin.action(description="Retry selected failed recordings", permissions=("change",))
    def retry_selected(self, request, queryset):
        queued = 0
        for recording in queryset.select_related("session", "lecture", "module"):
            if services.can_retry(recording) and services.retry(recording, request=request):
                queued += 1
        skipped = queryset.count() - queued
        self.message_user(request, f"{queued} recording(s) queued for retry; {skipped} skipped (not failed).", messages.INFO)

    # -------------------------------------------------------------- urls
    def get_urls(self):
        def view(func, route, name):
            return path(route, self.admin_site.admin_view(func), name=f"realtime_classrecording_{name}")

        custom = [
            view(self.scan_view, "scan/", "scan"),
            view(self.media_view, "<int:recording_id>/media/", "media"),
            view(self.obs_upload_view, "<int:recording_id>/obs-upload/", "obs_upload"),
            view(self.publish_view, "<int:recording_id>/publish/", "publish"),
            view(self.unpublish_view, "<int:recording_id>/unpublish/", "unpublish"),
            view(self.retry_view, "<int:recording_id>/retry/", "retry"),
            view(self.move_view, "<int:recording_id>/move/", "move"),
            view(self.assign_view, "<int:recording_id>/assign/", "assign"),
            view(self.delete_files_view, "<int:recording_id>/delete-files/", "delete_files"),
        ]
        return custom + super().get_urls()

    def _get(self, request, recording_id, *, change=True):
        recording = get_object_or_404(
            R.objects.select_related(
                "session", "session__linked_course", "module", "module__course", "lecture", "lecture__section__course"
            ),
            pk=recording_id,
        )
        allowed = self._can_change(request, recording) if change else self.has_view_permission(request, recording)
        if not allowed:
            raise PermissionDenied
        return recording

    def _change_url(self, recording):
        return reverse("admin:realtime_classrecording_change", args=[recording.pk])

    def _render_action(self, request, recording, *, title, intro, submit, form=None, danger=False, warning=""):
        context = {
            **self.admin_site.each_context(request),
            "opts": self.model._meta,
            "title": title,
            "recording": recording,
            "recording_title": recording_title(recording) if recording is not None else "",
            "course": recording_course(recording) if recording is not None else None,
            "module": recording_module(recording) if recording is not None else None,
            "intro": intro,
            "warning": warning,
            "form": form,
            "submit_label": submit,
            "danger": danger,
            "cancel_url": self._change_url(recording) if recording is not None
            else reverse("admin:realtime_classrecording_changelist"),
        }
        return TemplateResponse(request, "realtime/admin/class_recording_action.html", context)

    def _done(self, request, recording, message, level=messages.SUCCESS):
        self.message_user(request, message, level)
        return HttpResponseRedirect(self._change_url(recording))

    # ------------------------------------------------------------- views
    def media_view(self, request, recording_id):
        recording = self._get(request, recording_id, change=False)
        path, _playable = services.playable_file(recording)
        return staff_file_response(request, path, download=request.GET.get("download") == "1")

    def _publish_toggle(self, request, recording_id, published):
        recording = self._get(request, recording_id)
        lecture = recording.lecture if recording.lecture_id else None
        if request.method == "POST":
            try:
                changed = services.set_lecture_published(recording, published, request=request)
            except ValidationError as exc:
                return self._done(request, recording, " ".join(exc.messages), messages.ERROR)
            verb = "published" if published else "unpublished"
            if changed:
                self.log_change(request, recording, f"Lecture #{recording.lecture_id} {verb}.")
            return self._done(request, recording, f"Lecture {verb}." if changed else f"The lecture was already {verb}.")
        if published:
            intro = (f'Publish lecture "{lecture.title}"? Enrolled students can watch it and are notified once.'
                     if lecture else "This recording has no lecture.")
        else:
            intro = (f'Unpublish lecture "{lecture.title}"? Students no longer see it; nothing is deleted.'
                     if lecture else "This recording has no lecture.")
        return self._render_action(
            request, recording, title="Publish lecture" if published else "Unpublish lecture",
            intro=intro, submit="Publish" if published else "Unpublish",
        )

    def publish_view(self, request, recording_id):
        return self._publish_toggle(request, recording_id, True)

    def unpublish_view(self, request, recording_id):
        return self._publish_toggle(request, recording_id, False)

    def retry_view(self, request, recording_id):
        recording = self._get(request, recording_id)
        if request.method == "POST":
            if services.can_retry(recording) and services.retry(recording, request=request):
                self.log_change(request, recording, "Queued for retry.")
                return self._done(request, recording, "Queued for retry; the stream recorder picks it up shortly.")
            return self._done(request, recording, f"Not retried: the recording is {recording.get_state_display()}.",
                              messages.WARNING)
        return self._render_action(
            request, recording, title="Retry recording",
            intro=f"Retry this {recording.get_state_display().lower()} recording? Last error: {recording.error or '-'}",
            submit="Retry",
        )

    def move_view(self, request, recording_id):
        recording = self._get(request, recording_id)
        course_id = services.recording_course_id(recording)
        form = ModuleChoiceForm(request.POST or None, course_id=course_id, initial_module=recording_module(recording))
        if request.method == "POST" and form.is_valid():
            try:
                services.move_to_module(recording, form.cleaned_data["module"], request=request)
            except ValidationError as exc:
                form.add_error(None, exc)
            else:
                module = form.cleaned_data["module"]
                self.log_change(request, recording, f"Moved to module #{module.pk}.")
                return self._done(request, recording, f'Moved to module "{module.title}".')
        intro = ("Move this recording and its lecture to another module of the same course. The lecture keeps "
                 "its video, likes, comments and views and goes to the end of the new module.")
        return self._render_action(request, recording, title="Move to another module", intro=intro,
                                   submit="Move", form=form)

    def assign_view(self, request, recording_id):
        recording = self._get(request, recording_id)
        initial = recording.module or (recording.session.target_module if recording.session_id else None)
        form = ModuleChoiceForm(request.POST or None, initial_module=initial)
        if request.method == "POST" and form.is_valid():
            module = form.cleaned_data["module"]
            try:
                services.publish_to_module(recording, module, request=request)
            except ValidationError as exc:
                form.add_error(None, exc)
            else:
                self.log_change(request, recording, f"Publishing to module #{module.pk}.")
                return self._done(
                    request, recording,
                    f'Queued: the stream recorder adds it to "{module.course.title} - {module.title}" as an '
                    "unpublished lecture; it is published once its stream is built.",
                )
        intro = ("Choose the course module this recording belongs to. A lecture is created at the end of the "
                 "module with the module's description, the video stream is built, and the lecture is published "
                 "when it is ready. The original file stays where it is (it is linked or copied).")
        return self._render_action(request, recording, title="Publish to module", intro=intro,
                                   submit="Publish to module", form=form)

    def delete_files_view(self, request, recording_id):
        recording = self._get(request, recording_id)
        files = services.recording_files(recording)
        form = DeleteFilesForm(request.POST or None, files=files)
        lecture = recording.lecture if recording.lecture_id else None
        if request.method == "POST" and form.is_valid():
            try:
                result = services.delete_recording_files(
                    recording,
                    kinds=form.cleaned_data["kinds"],
                    confirm_published=form.cleaned_data["confirm_published"],
                    request=request,
                )
            except ValidationError as exc:
                form.add_error(None, exc)
            else:
                parts = []
                if result.deleted:
                    parts.append(f"Deleted {len(result.deleted)} item(s), {_human_bytes(result.deleted_bytes)}.")
                if result.deferred:
                    parts.append(f"{len(result.deferred)} item(s) on the recordings volume are deleted by the "
                                 "stream recorder within a few seconds.")
                self.log_change(request, recording, "Deleted recording files: " + ", ".join(
                    str(item.path) for item in result.deleted + result.deferred))
                return self._done(request, recording, " ".join(parts) or "Nothing to delete.")
        warning = ""
        if lecture is not None and lecture.is_published:
            warning = (f'Lecture "{lecture.title}" is published. Its video is only deleted if you tick the '
                       "confirmation below.")
        intro = "Choose the files to delete permanently. This cannot be undone."
        return self._render_action(request, recording, title="Delete recording files", intro=intro,
                                   submit="Delete files", form=form, danger=True, warning=warning)

    def scan_view(self, request):
        if not self._can_change(request):
            raise PermissionDenied
        if request.method == "POST":
            report = importer.scan_existing_recordings(limit=200, probe_budget_seconds=20)
            self.message_user(request, report.summary(), messages.SUCCESS if not report.truncated else messages.WARNING)
            url = reverse("admin:realtime_classrecording_changelist")
            if report.created:
                url += f"?state={R.STATE_IMPORTED}"
            return HttpResponseRedirect(url)
        roots = importer.scan_roots()
        intro = format_html(
            "Look for video files already on the server that no lecture or class recording uses, and list them "
            "here as <strong>Imported (unassigned)</strong> with their size and duration. Nothing is moved or "
            "deleted. Then open one and use <em>Publish to module</em>. Files changed in the last 10 minutes are "
            "skipped (they may still be written); re-running the scan never lists a file twice.<ul>{}</ul>",
            format_html_join("", "<li>{}: <code>{}</code></li>", ((root.label, root.path) for root in roots)),
        )
        return self._render_action(request, None, title="Scan for existing recordings", intro=intro,
                                   submit="Scan now")

    def obs_upload_view(self, request, recording_id):
        recording = get_object_or_404(R.objects.select_related("session", "lecture", "module"), pk=recording_id)
        if not self._can_change(request, recording) or recording.session is None:
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
                if created.state == R.STATE_FINALIZING:
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
