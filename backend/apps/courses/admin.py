from django.contrib import admin, messages
from django.db.models import Count
from django.urls import reverse
from django.utils.html import format_html
from django.utils.translation import ngettext

from .models import Course, Enrollment, Lecture, LiveClass, LiveClassEnrollment, Section
from .services import VideoTranscodeError, transcode_lecture_to_hls


class LectureInline(admin.TabularInline):
    model = Lecture
    extra = 1
    fields = ("order", "title", "video_file", "video_key", "is_preview", "stream_status")
    readonly_fields = ("stream_status",)
    ordering = ("order", "id")
    show_change_link = True
    verbose_name = "Video Lecture"
    verbose_name_plural = "Video Lectures (upload video files here for each module)"


@admin.register(Course)
class CourseAdmin(admin.ModelAdmin):
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
        "updated_at",
    )
    list_filter = ("category", "level", "launch_status", "is_published", "created_at", "updated_at")
    search_fields = ("title", "slug", "description", "instructor__email", "instructor__full_name")
    list_editable = ("launch_status", "price", "is_published", "instructor")
    readonly_fields = (
        "slug",
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
            "Course Basics",
            {
                "fields": (
                    "title",
                    "slug",
                    "description",
                    "thumbnail",
                    "thumbnail_file",
                    "thumbnail_preview",
                )
            },
        ),
        (
            "Catalog & Pricing",
            {
                "fields": (
                    "category",
                    "level",
                    "launch_status",
                    "price",
                    "is_published",
                    "instructor",
                    "instructor_admin_link",
                )
            },
        ),
        (
            "Curriculum Management",
            {
                "description": (
                    "Course creation and course details are managed here. Use the separate Modules page "
                    "to add module names, module descriptions, and module video lectures."
                ),
                "fields": ("section_count_display", "lecture_count_display", "module_admin_link"),
            },
        ),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )

    def get_queryset(self, request):
        queryset = super().get_queryset(request)
        return queryset.select_related("instructor").annotate(
            _section_count=Count("sections", distinct=True),
            _lecture_count=Count("sections__lectures", distinct=True),
        )

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
        if getattr(obj, "thumbnail_file", None):
            return format_html(
                '<img src="{}" alt="{}" style="max-width: 360px; border-radius: 10px; border: 1px solid #ddd;" />',
                obj.thumbnail_file.url,
                obj.title,
            )
        if not getattr(obj, "thumbnail", ""):
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

    @admin.action(description="Mark selected courses as Live")
    def mark_live(self, request, queryset):
        queryset.update(launch_status=Course.STATUS_LIVE)

    @admin.action(description="Mark selected courses as Coming Soon")
    def mark_coming_soon(self, request, queryset):
        queryset.update(launch_status=Course.STATUS_COMING_SOON)

    @admin.action(description="Publish selected courses")
    def publish_courses(self, request, queryset):
        queryset.update(is_published=True)

    @admin.action(description="Unpublish selected courses")
    def unpublish_courses(self, request, queryset):
        queryset.update(is_published=False)


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
    list_display = ("id", "user", "course", "payment_status", "enrolled_at")
    list_filter = ("payment_status", "course__category", "course__level")
    search_fields = ("user__email", "course__title")
    list_editable = ("payment_status",)
    raw_id_fields = ("user", "course")
    readonly_fields = ("enrolled_at",)
    list_per_page = 50
    actions = ("approve_enrollment_requests", "reject_enrollment_requests")

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


@admin.register(LiveClassEnrollment)
class LiveClassEnrollmentAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "live_class",
        "status",
        "user",
        "user_full_name",
        "user_email",
        "created_at",
    )
    list_filter = ("status", "live_class", "live_class__level", "live_class__month_number", "created_at")
    search_fields = ("user__email", "user__full_name", "live_class__title")
    list_editable = ("status",)
    autocomplete_fields = ("user", "live_class")
    readonly_fields = ("created_at",)
    actions = ("approve_enrollment_requests", "reject_enrollment_requests")

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("user", "live_class")

    @admin.display(description="User Name")
    def user_full_name(self, obj):
        return obj.user.full_name

    @admin.display(description="User Email")
    def user_email(self, obj):
        return obj.user.email

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


admin.site.site_header = "Al syed Initiative Admin"
admin.site.site_title = "Al syed Initiative Admin"
admin.site.index_title = "Course, Modules, and Enrollment Management"

