"""Django admin for student profiles: the moderation queue.

* "Profile reports" is the queue: open reports first, with actions to hide
  the reported profile (resolves every open report on it) or dismiss.
* "Student profiles": hide / restore actions; the content is read-only here
  (owners edit their own profile; moderators only hide or restore). The
  published bio is previewed through ``richtext.render_html`` (escaped, then
  allowlist-sanitised), never as stored HTML.
* "Profile audit log" is read-only.
* "Profile settings" holds the admin rules (real names allowed, gallery size).

Every action goes through ``services`` so it is audited like the API.
"""

from django.contrib import admin, messages
from django.utils.html import format_html
from django.utils.safestring import mark_safe

from apps.core.errors import DomainError

from . import richtext, services
from .models import ProfileAuditLog, ProfileImage, ProfileReport, ProfileSiteSettings, StudentProfile

ADMIN_HIDE_REASON = "Hidden by a moderator after a report."


def _published_bio_html(profile: StudentProfile) -> str:
    for block in (profile.published or {}).get("blocks") or []:
        if isinstance(block, dict) and block.get("type") == "bio":
            return richtext.render_html(block.get("doc"))
    return ""


class ProfileImageInline(admin.TabularInline):
    model = ProfileImage
    extra = 0
    can_delete = False
    fields = ("id", "kind", "width", "height", "size_bytes", "scanner", "created_at")
    readonly_fields = fields
    show_change_link = False

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(StudentProfile)
class StudentProfileAdmin(admin.ModelAdmin):
    list_display = ("handle", "user", "status", "visibility", "published_at", "updated_at")
    list_filter = ("status", "visibility", ("published_at", admin.EmptyFieldListFilter))
    search_fields = ("handle", "user__email")
    raw_id_fields = ("user", "hidden_by")
    list_select_related = ("user",)
    inlines = [ProfileImageInline]
    actions = ["hide_selected", "restore_selected"]
    readonly_fields = (
        "user", "handle", "handle_changed_at", "draft_version", "published_version", "published_at", "visibility",
        "show_real_name", "status", "hidden_reason", "hidden_at", "hidden_by", "published_bio_preview", "published",
        "draft", "created_at", "updated_at",
    )
    fieldsets = (
        (None, {"fields": ("user", "handle", "handle_changed_at", "visibility", "show_real_name")}),
        ("Moderation", {"fields": ("status", "hidden_reason", "hidden_at", "hidden_by")}),
        ("Published", {"fields": ("published_at", "published_version", "published_bio_preview", "published")}),
        ("Draft", {"classes": ("collapse",), "fields": ("draft_version", "draft")}),
        ("Dates", {"fields": ("created_at", "updated_at")}),
    )

    def has_add_permission(self, request):
        return False

    @admin.display(description="Published bio (sanitised preview)")
    def published_bio_preview(self, obj):
        html = _published_bio_html(obj)
        # render_html escapes every text node and passes the result through the allowlist sanitiser.
        return mark_safe(html) if html else "—"  # noqa: S308 - sanitised by richtext.render_html

    @admin.action(description="Hide selected profiles (moderation)")
    def hide_selected(self, request, queryset):
        done = 0
        for profile in queryset:
            try:
                services.hide_profile(profile, actor=request.user, reason=ADMIN_HIDE_REASON, request=request)
                done += 1
            except DomainError as exc:
                self.message_user(request, f"@{profile.handle}: {exc.message}", messages.ERROR)
        if done:
            self.message_user(request, f"Hid {done} profile(s).", messages.SUCCESS)

    @admin.action(description="Restore selected profiles")
    def restore_selected(self, request, queryset):
        done = 0
        for profile in queryset.filter(status=StudentProfile.STATUS_HIDDEN):
            services.restore_profile(profile, actor=request.user, note="Restored from the Django admin.", request=request)
            done += 1
        self.message_user(request, f"Restored {done} profile(s).", messages.SUCCESS)


@admin.register(ProfileReport)
class ProfileReportAdmin(admin.ModelAdmin):
    list_display = ("created_at", "profile_link", "reason", "status", "reporter")
    list_filter = ("status", "reason")
    search_fields = ("profile__handle", "reporter__email", "details")
    raw_id_fields = ("profile", "reporter", "resolved_by")
    list_select_related = ("profile", "reporter")
    actions = ["hide_reported_profiles", "dismiss_selected"]
    readonly_fields = (
        "profile", "reporter", "reason", "details", "status", "created_at", "resolved_at", "resolved_by", "resolution_note",
    )

    def has_add_permission(self, request):
        return False

    def get_queryset(self, request):
        return super().get_queryset(request).order_by("status", "-created_at")

    @admin.display(description="Profile")
    def profile_link(self, obj):
        return format_html("@{} ({})", obj.profile.handle, obj.profile.get_status_display())

    @admin.action(description="Hide the reported profiles")
    def hide_reported_profiles(self, request, queryset):
        handled = set()
        for report in queryset.select_related("profile"):
            if report.profile_id in handled:
                continue
            handled.add(report.profile_id)
            services.hide_profile(
                report.profile, actor=request.user, reason=f"{ADMIN_HIDE_REASON} ({report.get_reason_display()})", request=request
            )
        self.message_user(request, f"Hid {len(handled)} profile(s).", messages.SUCCESS)

    @admin.action(description="Dismiss selected reports")
    def dismiss_selected(self, request, queryset):
        count = 0
        for report in queryset.filter(status=ProfileReport.STATUS_OPEN).select_related("profile"):
            services.dismiss_report(report, actor=request.user, note="Dismissed from the Django admin.", request=request)
            count += 1
        self.message_user(request, f"Dismissed {count} report(s).", messages.SUCCESS)


@admin.register(ProfileAuditLog)
class ProfileAuditLogAdmin(admin.ModelAdmin):
    list_display = ("created_at", "handle", "action", "actor")
    list_filter = ("action",)
    search_fields = ("handle", "actor__email", "request_id")
    list_select_related = ("actor",)
    date_hierarchy = "created_at"
    show_full_result_count = False

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(ProfileSiteSettings)
class ProfileSiteSettingsAdmin(admin.ModelAdmin):
    list_display = ("__str__", "allow_real_names", "max_gallery_images", "updated_at")
    readonly_fields = ("updated_at", "updated_by")

    def has_add_permission(self, request):
        return not ProfileSiteSettings.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False

    def save_model(self, request, obj, form, change):
        obj.updated_by = request.user
        super().save_model(request, obj, form, change)


def _register_nav_groups():
    """Place the screens in the Al Syed Admin sidebar groups without editing apps.users."""
    try:
        from apps.users.templatetags.enterprise_admin import MODEL_JOBS
    except Exception:  # noqa: BLE001
        return
    for key, value in (
        ("profiles.profilereport", ("community", "Profile reports")),
        ("profiles.studentprofile", ("community", "Student profiles")),
        ("profiles.profilesitesettings", ("settings", "Profile rules")),
        ("profiles.profileauditlog", ("system", "Profile audit log")),
    ):
        MODEL_JOBS.setdefault(key, value)


_register_nav_groups()
