import json

from django import forms
from django.contrib import admin, messages
from django.db.models import Count
from django.urls import reverse
from django.utils.html import format_html
from django.utils.translation import ngettext

from .models import (
    Course,
    Enrollment,
    Lecture,
    LiveClass,
    LiveClassEnrollment,
    PublicEnrollmentLead,
    Section,
)
from .cache_utils import bump_course_list_cache_version
from .services import VideoTranscodeError, transcode_lecture_to_hls


def _parse_admin_list_field(value):
    raw = str(value or "").strip()
    if not raw:
        return []

    parsed_items = None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, list):
        parsed_items = parsed
    elif isinstance(parsed, str):
        parsed_items = [parsed]

    if parsed_items is None:
        if "\n" in raw:
            parsed_items = raw.splitlines()
        elif "," in raw:
            parsed_items = raw.split(",")
        else:
            parsed_items = [raw]

    cleaned = []
    for item in parsed_items:
        text = str(item or "").strip()
        text = text.lstrip("-* ").strip()
        if text:
            cleaned.append(text)
    return cleaned


class CourseAdminForm(forms.ModelForm):
    what_you_will_learn = forms.CharField(
        required=False,
        label="What You Will Cover",
        help_text="Enter one highlight per line. Example: Web Pentesting track",
        widget=forms.Textarea(
            attrs={
                "rows": 4,
                "placeholder": "Web Pentesting track\nBeginner level\nLaunching soon",
            }
        ),
    )
    expected_outcomes = forms.CharField(
        required=False,
        label="Expected Outcomes",
        help_text="Enter one outcome per line. These render as the outcome cards.",
        widget=forms.Textarea(
            attrs={
                "rows": 5,
                "placeholder": (
                    "Build web pentesting workflow habits.\n"
                    "Follow a beginner progression with structured modules."
                ),
            }
        ),
    )

    class Meta:
        model = Course
        fields = "__all__"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        instance = getattr(self, "instance", None)
        if instance and instance.pk:
            self.fields["what_you_will_learn"].initial = "\n".join(instance.what_you_will_learn or [])
            self.fields["expected_outcomes"].initial = "\n".join(instance.expected_outcomes or [])

        textarea_rows = {
            "description": 3,
            "about_the_course": 4,
            "course_overview": 4,
            "enrollment_message": 3,
        }
        for field_name, rows in textarea_rows.items():
            field = self.fields.get(field_name)
            if field:
                field.widget.attrs.setdefault("rows", rows)
                field.widget.attrs.setdefault("placeholder", "")

        self.fields["title"].help_text = "Frontend: Hero title"
        self.fields["description"].label = "Short Description"
        self.fields["description"].help_text = "Frontend: Hero subtitle under title"
        self.fields["about_the_course"].label = "About This Course"
        self.fields["about_the_course"].help_text = (
            "Frontend container: About This Course card (left side of hero section)."
        )
        self.fields["course_overview"].label = "Course Overview"
        self.fields["course_overview"].help_text = (
            "Frontend container: Course Overview overlay card on thumbnail."
        )
        self.fields["thumbnail_file"].help_text = (
            "Upload image file (recommended). Uploaded file is used first on frontend and admin preview."
        )
        self.fields["thumbnail"].help_text = (
            "Optional public image URL fallback if no uploaded thumbnail file is available."
        )
        self.fields["enrollment_message"].label = "Enrollment Note"
        self.fields["enrollment_message"].help_text = (
            "Frontend container: Enrollment panel note text (right panel)."
        )
        self.fields["snapshot_category"].label = "Snapshot Category"
        self.fields["snapshot_level"].label = "Snapshot Level"
        self.fields["snapshot_instructor"].label = "Snapshot Instructor"
        self.fields["snapshot_category"].help_text = "Frontend container: Course Snapshot > Category"
        self.fields["snapshot_level"].help_text = "Frontend container: Course Snapshot > Level"
        self.fields["snapshot_instructor"].help_text = "Frontend container: Course Snapshot > Instructor"

        self.fields["about_the_course"].widget.attrs.update(
            {
                "placeholder": (
                    "Coming soon: a beginner-friendly web application pentesting track with fundamentals, "
                    "setup, and testing mindset."
                )
            }
        )
        self.fields["course_overview"].widget.attrs.update(
            {
                "placeholder": (
                    "Coming soon: beginner-friendly web application pentesting track with fundamentals, "
                    "setup, and testing mindset."
                )
            }
        )
        self.fields["enrollment_message"].widget.attrs.update(
            {
                "placeholder": (
                    "This track is not live yet. We will open enrollment once the curriculum release is ready."
                )
            }
        )

    def clean_what_you_will_learn(self):
        return _parse_admin_list_field(self.cleaned_data.get("what_you_will_learn"))

    def clean_expected_outcomes(self):
        return _parse_admin_list_field(self.cleaned_data.get("expected_outcomes"))


class LectureInlineForm(forms.ModelForm):
    remove_uploaded_video = forms.BooleanField(
        required=False,
        label="Remove uploaded video",
        help_text="Clear the current video file without deleting the lecture row.",
    )

    class Meta:
        model = Lecture
        fields = "__all__"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        has_existing_file = bool(getattr(self.instance, "pk", None) and self.instance.video_file)
        if not has_existing_file:
            self.fields["remove_uploaded_video"].widget = forms.HiddenInput()

    def clean(self):
        cleaned_data = super().clean()
        remove_uploaded_video = cleaned_data.get("remove_uploaded_video", False)

        if remove_uploaded_video:
            if "video_file" in self.changed_data and cleaned_data.get("video_file"):
                self.add_error(
                    "remove_uploaded_video",
                    "Use either a new upload or remove, not both in the same save.",
                )
            # For FileField in ModelForm, False explicitly clears existing file.
            cleaned_data["video_file"] = False

        return cleaned_data

    def save(self, commit=True):
        remove_uploaded_video = self.cleaned_data.get("remove_uploaded_video", False)
        old_video_name = None
        old_video_storage = None

        if remove_uploaded_video and getattr(self.instance, "video_file", None):
            old_video_name = self.instance.video_file.name
            old_video_storage = self.instance.video_file.storage

            # Reset stream artifacts tied to uploaded file so stale stream metadata is not reused.
            self.instance.stream_manifest_key = ""
            self.instance.stream_duration_seconds = None
            self.instance.stream_error = ""

        instance = super().save(commit=commit)

        if commit and old_video_name and old_video_storage:
            try:
                old_video_storage.delete(old_video_name)
            except Exception:
                pass

        return instance


class LectureInline(admin.TabularInline):
    model = Lecture
    form = LectureInlineForm
    extra = 1
    fields = (
        "order",
        "title",
        "video_file",
        "remove_uploaded_video",
        "video_key",
        "is_preview",
        "stream_status",
    )
    readonly_fields = ("stream_status",)
    ordering = ("order", "id")
    show_change_link = True
    verbose_name = "Video Lecture"
    verbose_name_plural = "Video Lectures (upload video files here for each module)"


@admin.register(Course)
class CourseAdmin(admin.ModelAdmin):
    form = CourseAdminForm
    list_display = (
        "id",
        "title",
        "category",
        "level",
        "launch_status",
        "price",
        "is_published",
        "instructor",
        "section_count",
        "lecture_count",
        "admin_actions",
        "updated_at",
    )
    list_display_links = ("id", "title")
    list_filter = ("category", "level", "launch_status", "is_published", "created_at", "updated_at")
    search_fields = ("title", "slug", "description", "instructor__email", "instructor__full_name")
    list_editable = ("launch_status", "price", "is_published", "instructor")
    readonly_fields = (
        "slug",
        "frontend_container_guide",
        "enrollment_container_source",
        "thumbnail_preview",
        "instructor_admin_link",
        "section_count_display",
        "lecture_count_display",
        "module_admin_link",
        "created_at",
        "updated_at",
    )
    autocomplete_fields = ("instructor",)
    save_on_top = True
    list_per_page = 25
    actions = ("mark_live", "mark_coming_soon", "publish_courses", "unpublish_courses")
    fieldsets = (
        (
            "Frontend Container Map (Read First)",
            {
                "description": "Use the sections below to keep admin inputs aligned with frontend cards/containers.",
                "fields": ("frontend_container_guide",),
            },
        ),
        (
            "Container 1: Hero Header",
            {
                "fields": (
                    "category",
                    "level",
                    "launch_status",
                    "title",
                    "description",
                    "slug",
                )
            },
        ),
        (
            "Container 2: Hero Left Cards",
            {
                "fields": (
                    "price",
                    "about_the_course",
                )
            },
        ),
        (
            "Container 3: Hero Right Media Card",
            {
                "fields": (
                    "thumbnail",
                    "thumbnail_file",
                    "thumbnail_preview",
                    "course_overview",
                )
            },
        ),
        (
            "Container 4: What You Will Cover (Chip Row)",
            {
                "description": (
                    "Enter one item per line. Each line becomes one frontend chip."
                ),
                "fields": (
                    "what_you_will_learn",
                ),
            },
        ),
        (
            "Container 5: Expected Outcomes (Outcome Cards)",
            {
                "description": "Enter one item per line. Each line becomes one outcome card.",
                "fields": (
                    "expected_outcomes",
                ),
            },
        ),
        (
            "Container 6: Enrollment Panel (Right Side)",
            {
                "fields": (
                    "enrollment_message",
                    "enrollment_container_source",
                ),
            },
        ),
        (
            "Container 7: Course Snapshot Card",
            {
                "fields": (
                    "snapshot_category",
                    "snapshot_level",
                    "snapshot_instructor",
                    "instructor",
                    "instructor_admin_link",
                ),
            },
        ),
        (
            "Container 8: Course Roadmap (Modules/Lectures)",
            {
                "description": (
                    "Roadmap content is controlled from Modules page. Keep module-edit workflow unchanged."
                ),
                "fields": ("section_count_display", "lecture_count_display", "module_admin_link"),
            },
        ),
        ("Publishing", {"fields": ("is_published",)}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )

    def get_queryset(self, request):
        queryset = super().get_queryset(request)
        return queryset.select_related("instructor").annotate(
            _section_count=Count("sections", distinct=True),
            _lecture_count=Count("sections__lectures", distinct=True),
        )

    def get_changeform_initial_data(self, request):
        initial = super().get_changeform_initial_data(request)
        initial.setdefault("is_published", True)
        initial.setdefault("launch_status", Course.STATUS_LIVE)
        return initial

    @admin.display(ordering="_section_count", description="Modules")
    def section_count(self, obj):
        return getattr(obj, "_section_count", None) or obj.sections.count()

    @admin.display(ordering="_lecture_count", description="Lectures")
    def lecture_count(self, obj):
        return getattr(obj, "_lecture_count", None) or Lecture.objects.filter(section__course=obj).count()

    @admin.display(description="Module Count")
    def section_count_display(self, obj):
        if not obj.pk:
            return "Save the course first to view module and lecture counts."
        return self.section_count(obj)

    @admin.display(description="Lecture Count")
    def lecture_count_display(self, obj):
        if not obj.pk:
            return "Save the course first to view module and lecture counts."
        return self.lecture_count(obj)

    @admin.display(description="Thumbnail Preview")
    def thumbnail_preview(self, obj):
        if getattr(obj, "_has_accessible_thumbnail_file", None) and obj._has_accessible_thumbnail_file():
            preview_url = reverse("course-thumbnail", args=[obj.pk]) if obj.pk else obj.thumbnail_file.url
            return format_html(
                '<img src="{}" alt="{}" style="max-width: 360px; border-radius: 10px; border: 1px solid #ddd;" />',
                preview_url,
                obj.title,
            )
        if not getattr(obj, "thumbnail", ""):
            if getattr(obj, "thumbnail_file", None) and getattr(obj.thumbnail_file, "name", ""):
                return "Uploaded thumbnail file path exists in DB but file is missing on storage."
            return "No thumbnail URL"
        return format_html(
            '<img src="{}" alt="{}" style="max-width: 360px; border-radius: 10px; border: 1px solid #ddd;" />',
            obj.thumbnail,
            obj.title,
        )

    @admin.display(description="Edit Instructor Profile")
    def instructor_admin_link(self, obj):
        if not getattr(obj, "instructor_id", None):
            return "Select an instructor to edit profile details."
        url = reverse("admin:users_user_change", args=[obj.instructor_id])
        label = obj.instructor.full_name or obj.instructor.email
        return format_html('<a href="{}">Open instructor: {}</a>', url, label)

    @admin.display(description="Module Control Page")
    def module_admin_link(self, obj):
        if not obj.pk:
            return "Save the course first, then add modules from the Modules page."
        url = reverse("admin:courses_section_changelist")
        return format_html(
            '<a href="{}?course__id__exact={}">Open Modules for this course (and add module videos)</a>',
            url,
            obj.pk,
        )

    @admin.display(description="Actions")
    def admin_actions(self, obj):
        edit_url = reverse("admin:courses_course_change", args=[obj.pk])
        delete_url = reverse("admin:courses_course_delete", args=[obj.pk])
        return format_html('<a href="{}">Edit</a> | <a href="{}">Delete</a>', edit_url, delete_url)

    @admin.display(description="Frontend Container Mapping")
    def frontend_container_guide(self, obj):
        return format_html(
            """
            <div style="line-height:1.5;">
              <div><strong>1. Hero Header:</strong> category, level, launch status, title, short description</div>
              <div><strong>2. Hero Left Cards:</strong> price + About This Course</div>
              <div><strong>3. Hero Right Media Card:</strong> thumbnail + Course Overview overlay</div>
              <div><strong>4. What You Will Cover:</strong> one line = one chip</div>
              <div><strong>5. Expected Outcomes:</strong> one line = one outcome card</div>
              <div><strong>6. Enrollment Panel:</strong> Enrollment note + launch/price source</div>
              <div><strong>7. Course Snapshot:</strong> snapshot category/level/instructor</div>
              <div><strong>8. Course Roadmap:</strong> modules/lectures from Modules page</div>
            </div>
            """
        )

    @admin.display(description="Enrollment Status & Price Source")
    def enrollment_container_source(self, obj):
        launch_value = getattr(obj, "launch_status", None) or "coming_soon"
        launch_label = dict(Course.LAUNCH_STATUS_CHOICES).get(launch_value, launch_value)
        price_value = getattr(obj, "price", None)
        return format_html(
            "This panel uses launch status <strong>{}</strong> and price <strong>{}</strong> from Container 1/2.",
            launch_label,
            price_value if price_value is not None else "-",
        )

    @admin.action(description="Mark selected courses as Live")
    def mark_live(self, request, queryset):
        queryset.update(launch_status=Course.STATUS_LIVE)
        bump_course_list_cache_version()

    @admin.action(description="Mark selected courses as Coming Soon")
    def mark_coming_soon(self, request, queryset):
        queryset.update(launch_status=Course.STATUS_COMING_SOON)
        bump_course_list_cache_version()

    @admin.action(description="Publish selected courses")
    def publish_courses(self, request, queryset):
        queryset.update(is_published=True)
        bump_course_list_cache_version()

    @admin.action(description="Unpublish selected courses")
    def unpublish_courses(self, request, queryset):
        queryset.update(is_published=False)
        bump_course_list_cache_version()


@admin.register(Section)
class ModuleAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "manage_videos_link",
        "course",
        "title",
        "order",
        "video_count",
    )
    list_display_links = ("id",)
    list_editable = ("title", "order")
    list_filter = ("course", "course__category", "course__level", "course__launch_status", "course__is_published")
    search_fields = ("title", "description", "course__title", "course__description")
    autocomplete_fields = ("course",)
    inlines = [LectureInline]
    ordering = ("course", "order", "id")
    list_per_page = 50
    save_on_top = True
    actions = ("generate_hls_streams",)
    fields = (
        "course",
        "title",
        "description",
        "order",
    )
    readonly_fields = ()

    class Media:
        js = ("admin/js/courses_upload_progress.js",)
        css = {"all": ("admin/css/courses_upload_progress.css",)}

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("course").annotate(
            _video_count=Count("lectures", distinct=True)
        )

    @admin.display(ordering="_video_count", description="Videos")
    def video_count(self, obj):
        return getattr(obj, "_video_count", None) or obj.lectures.count()

    @admin.display(description="Manage Videos")
    def manage_videos_link(self, obj):
        url = reverse("admin:courses_section_change", args=[obj.pk])
        return format_html('<a href="{}">Open Module</a>', url)

    @admin.action(description="Generate HLS streams for uploaded videos in selected modules")
    def generate_hls_streams(self, request, queryset):
        modules = queryset.prefetch_related("lectures", "course")
        transcoded = 0
        skipped = 0
        failed = 0

        for module in modules:
            for lecture in module.lectures.all():
                if not lecture.video_file:
                    skipped += 1
                    continue
                try:
                    transcode_lecture_to_hls(lecture)
                    transcoded += 1
                except VideoTranscodeError:
                    failed += 1

        if transcoded:
            self.message_user(
                request,
                ngettext(
                    "%d lecture was transcoded to HLS.",
                    "%d lectures were transcoded to HLS.",
                    transcoded,
                )
                % transcoded,
                level=messages.SUCCESS,
            )
        if skipped:
            self.message_user(
                request,
                ngettext(
                    "%d lecture was skipped (no uploaded video file).",
                    "%d lectures were skipped (no uploaded video file).",
                    skipped,
                )
                % skipped,
                level=messages.WARNING,
            )
        if failed:
            self.message_user(
                request,
                ngettext(
                    "%d lecture failed to transcode. Check stream status/error in the module form.",
                    "%d lectures failed to transcode. Check stream status/error in the module form.",
                    failed,
                )
                % failed,
                level=messages.ERROR,
            )


@admin.register(Enrollment)
class EnrollmentAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "requester_username",
        "requester_email",
        "requester_phone",
        "course",
        "payment_status",
        "enrolled_at",
    )
    list_filter = ("payment_status", "course__category", "course__level")
    search_fields = ("user__email", "user__full_name", "user__phone_number", "course__title")
    list_editable = ("payment_status",)
    raw_id_fields = ("user", "course")
    readonly_fields = ("requester_username", "requester_email", "requester_phone", "enrolled_at")
    list_per_page = 50
    actions = ("approve_enrollment_requests", "reject_enrollment_requests")

    fields = ("requester_username", "requester_email", "requester_phone", "user", "course", "payment_status", "enrolled_at")

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("user", "course")

    @admin.display(description="Username")
    def requester_username(self, obj):
        value = obj.user.full_name or obj.user.email
        return format_html(
            '<span style="display:inline-block;padding:4px 8px;border-radius:999px;border:1px solid #3b4a3d;background:#111912;color:#e8f1df;font-weight:600;">{}</span>',
            value,
        )

    @admin.display(description="Email")
    def requester_email(self, obj):
        return format_html(
            '<span style="display:inline-block;padding:4px 8px;border-radius:999px;border:1px solid #3b4a3d;background:#111912;color:#e8f1df;font-weight:600;">{}</span>',
            obj.user.email,
        )

    @admin.display(description="Phone")
    def requester_phone(self, obj):
        phone = obj.user.phone_number or "Not provided"
        return format_html(
            '<span style="display:inline-block;padding:4px 8px;border-radius:999px;border:1px solid #3b4a3d;background:#111912;color:#f0f6e8;font-weight:600;">{}</span>',
            phone,
        )

    def get_model_perms(self, request):
        # Managed from Users admin via inlines to keep enrollment control centralized.
        return {}

    @admin.action(description="Approve selected enrollment requests")
    def approve_enrollment_requests(self, request, queryset):
        updated = queryset.exclude(payment_status=Enrollment.STATUS_PAID).update(
            payment_status=Enrollment.STATUS_PAID
        )
        self.message_user(
            request,
            ngettext(
                "%d enrollment request approved.",
                "%d enrollment requests approved.",
                updated,
            )
            % updated,
            level=messages.SUCCESS,
        )

    @admin.action(description="Reject selected enrollment requests")
    def reject_enrollment_requests(self, request, queryset):
        updated = queryset.exclude(payment_status=Enrollment.STATUS_FAILED).update(
            payment_status=Enrollment.STATUS_FAILED
        )
        self.message_user(
            request,
            ngettext(
                "%d enrollment request rejected.",
                "%d enrollment requests rejected.",
                updated,
            )
            % updated,
            level=messages.WARNING,
        )


@admin.register(LiveClass)
class LiveClassAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "title",
        "price",
        "month_number",
        "level",
        "schedule_days",
        "class_duration_minutes",
        "is_active",
        "linked_course",
        "enrollment_count",
        "admin_actions",
    )
    list_filter = ("is_active", "level", "month_number")
    search_fields = ("title", "description", "linked_course__title")
    list_editable = ("price", "month_number", "is_active")
    autocomplete_fields = ("linked_course",)
    readonly_fields = ("slug", "enrollment_count_display", "created_at", "updated_at")
    fieldsets = (
        (
            "Live Class",
            {
                "fields": (
                    "title",
                    "slug",
                    "description",
                    "price",
                    "linked_course",
                    "level",
                    "month_number",
                )
            },
        ),
        ("Schedule", {"fields": ("schedule_days", "class_duration_minutes", "is_active")}),
        ("Enrollments", {"fields": ("enrollment_count_display",)}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("linked_course").annotate(
            _enrollment_count=Count("enrollments", distinct=True)
        )

    @admin.display(ordering="_enrollment_count", description="Enrollments")
    def enrollment_count(self, obj):
        return getattr(obj, "_enrollment_count", None) or obj.enrollments.count()

    @admin.display(description="Enrollment Count")
    def enrollment_count_display(self, obj):
        if not obj.pk:
            return "Save the live class first to view enrollments."
        return self.enrollment_count(obj)

    @admin.display(description="Actions")
    def admin_actions(self, obj):
        edit_url = reverse("admin:courses_liveclass_change", args=[obj.pk])
        delete_url = reverse("admin:courses_liveclass_delete", args=[obj.pk])
        return format_html('<a href="{}">Edit</a> | <a href="{}">Delete</a>', edit_url, delete_url)


@admin.register(LiveClassEnrollment)
class LiveClassEnrollmentAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "live_class",
        "status",
        "user_full_name",
        "user_email",
        "user_phone",
        "created_at",
    )
    list_filter = ("status", "live_class", "live_class__level", "live_class__month_number", "created_at")
    search_fields = ("user__email", "user__full_name", "user__phone_number", "live_class__title")
    list_editable = ("status",)
    autocomplete_fields = ("user", "live_class")
    readonly_fields = ("user_full_name", "user_email", "user_phone", "created_at")
    actions = ("approve_enrollment_requests", "reject_enrollment_requests")
    fields = ("user_full_name", "user_email", "user_phone", "user", "live_class", "status", "created_at")

    def get_model_perms(self, request):
        # Managed from Users admin via inlines to keep enrollment control centralized.
        return {}

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("user", "live_class")

    @admin.display(description="User Name")
    def user_full_name(self, obj):
        value = obj.user.full_name or obj.user.email
        return format_html(
            '<span style="display:inline-block;padding:4px 8px;border-radius:999px;border:1px solid #3b4a3d;background:#111912;color:#e8f1df;font-weight:600;">{}</span>',
            value,
        )

    @admin.display(description="User Email")
    def user_email(self, obj):
        return format_html(
            '<span style="display:inline-block;padding:4px 8px;border-radius:999px;border:1px solid #3b4a3d;background:#111912;color:#e8f1df;font-weight:600;">{}</span>',
            obj.user.email,
        )

    @admin.display(description="User Phone")
    def user_phone(self, obj):
        phone = obj.user.phone_number or "Not provided"
        return format_html(
            '<span style="display:inline-block;padding:4px 8px;border-radius:999px;border:1px solid #3b4a3d;background:#111912;color:#f0f6e8;font-weight:600;">{}</span>',
            phone,
        )

    @admin.action(description="Approve selected live-class enrollment requests")
    def approve_enrollment_requests(self, request, queryset):
        updated = queryset.exclude(status=LiveClassEnrollment.STATUS_APPROVED).update(
            status=LiveClassEnrollment.STATUS_APPROVED
        )
        self.message_user(
            request,
            ngettext(
                "%d live-class enrollment approved.",
                "%d live-class enrollments approved.",
                updated,
            )
            % updated,
            level=messages.SUCCESS,
        )

    @admin.action(description="Reject selected live-class enrollment requests")
    def reject_enrollment_requests(self, request, queryset):
        updated = queryset.exclude(status=LiveClassEnrollment.STATUS_REJECTED).update(
            status=LiveClassEnrollment.STATUS_REJECTED
        )
        self.message_user(
            request,
            ngettext(
                "%d live-class enrollment rejected.",
                "%d live-class enrollments rejected.",
                updated,
            )
            % updated,
            level=messages.WARNING,
        )


@admin.register(PublicEnrollmentLead)
class PublicEnrollmentLeadAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "status",
        "target_type",
        "target_name",
        "email",
        "phone_number",
        "whatsapp_number",
        "message_preview",
        "created_at",
    )
    list_display_links = ("id", "target_name", "email")
    list_editable = ("status",)
    list_filter = ("status", "created_at")
    search_fields = (
        "email",
        "phone_number",
        "whatsapp_number",
        "message",
        "course__title",
        "live_class__title",
    )
    readonly_fields = (
        "course",
        "live_class",
        "target_name",
        "email",
        "phone_number",
        "whatsapp_number",
        "message",
        "source_path",
        "created_at",
        "updated_at",
    )
    autocomplete_fields = ("course", "live_class")
    ordering = ("-created_at",)
    date_hierarchy = "created_at"
    list_per_page = 100
    fieldsets = (
        ("Enrollment Request", {"fields": ("status", "course", "live_class", "target_name")}),
        ("Contact", {"fields": ("email", "phone_number", "whatsapp_number")}),
        ("Message", {"fields": ("message", "source_path")}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )

    actions = ("mark_reviewed", "mark_contacted", "mark_converted")

    @admin.display(description="Target Type")
    def target_type(self, obj):
        if obj.course_id:
            return "Course"
        if obj.live_class_id:
            return "Live Class"
        return "-"

    @admin.display(description="Target")
    def target_name(self, obj):
        if obj.course_id:
            return obj.course.title
        if obj.live_class_id:
            return obj.live_class.title
        return "Target removed"

    @admin.display(description="Message")
    def message_preview(self, obj):
        text = (obj.message or "").strip()
        if len(text) <= 80:
            return text
        return f"{text[:80]}..."

    @admin.action(description="Mark selected leads as Reviewed")
    def mark_reviewed(self, request, queryset):
        updated = queryset.exclude(status=PublicEnrollmentLead.STATUS_REVIEWED).update(
            status=PublicEnrollmentLead.STATUS_REVIEWED
        )
        self.message_user(
            request,
            ngettext(
                "%d lead marked as reviewed.",
                "%d leads marked as reviewed.",
                updated,
            )
            % updated,
            level=messages.SUCCESS,
        )

    @admin.action(description="Mark selected leads as Contacted")
    def mark_contacted(self, request, queryset):
        updated = queryset.exclude(status=PublicEnrollmentLead.STATUS_CONTACTED).update(
            status=PublicEnrollmentLead.STATUS_CONTACTED
        )
        self.message_user(
            request,
            ngettext(
                "%d lead marked as contacted.",
                "%d leads marked as contacted.",
                updated,
            )
            % updated,
            level=messages.SUCCESS,
        )

    @admin.action(description="Mark selected leads as Converted")
    def mark_converted(self, request, queryset):
        updated = queryset.exclude(status=PublicEnrollmentLead.STATUS_CONVERTED).update(
            status=PublicEnrollmentLead.STATUS_CONVERTED
        )
        self.message_user(
            request,
            ngettext(
                "%d lead marked as converted.",
                "%d leads marked as converted.",
                updated,
            )
            % updated,
            level=messages.SUCCESS,
        )

    def has_add_permission(self, request):
        return False


admin.site.site_header = "Al syed Initiative Admin"
admin.site.site_title = "Al syed Initiative Admin"
admin.site.index_title = "Course, Modules, and Enrollment Management"

