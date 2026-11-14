from django.contrib import admin, messages
from django.utils import timezone

from .models import HOSTABLE_LICENCES, OsintChallenge, OsintChallengeProgress, OsintPath


@admin.register(OsintPath)
class OsintPathAdmin(admin.ModelAdmin):
    list_display = ("title", "key", "order", "is_published")
    list_editable = ("order", "is_published")
    search_fields = ("title", "key")
    prepopulated_fields = {"key": ("title",)}


@admin.register(OsintChallenge)
class OsintChallengeAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "platform",
        "difficulty",
        "access_tier",
        "hosting",
        "licence",
        "source_is_free",
        "path",
        "path_order",
        "xp",
        "is_published",
        "link_status",
    )
    list_filter = ("access_tier", "hosting", "difficulty", "platform", "licence", "is_published", "path")
    search_fields = ("title", "platform", "url", "slug", "attribution")
    prepopulated_fields = {"slug": ("title",)}
    readonly_fields = ("link_checked_at", "link_status", "created_at", "updated_at")
    actions = ("publish", "unpublish")
    fieldsets = (
        (None, {"fields": ("title", "slug", "summary", "platform", "url", "is_published")}),
        ("Where it sits", {"fields": ("access_tier", "difficulty", "skills", "estimated_minutes", "xp", "path", "path_order")}),
        (
            "Source, licence and attribution",
            {
                "description": (
                    "Link out by default and never copy another platform's text, images or answers. "
                    "Only " + ", ".join(HOSTABLE_LICENCES) + " challenges may be hosted, with attribution."
                ),
                "fields": ("source_is_free", "hosting", "licence", "licence_url", "attribution", "source_repository", "flag_sha256"),
            },
        ),
        ("Link check", {"fields": ("link_checked_at", "link_status", "created_at", "updated_at")}),
    )

    @admin.action(description="Publish selected challenges")
    def publish(self, request, queryset):
        updated = queryset.update(is_published=True, updated_at=timezone.now())
        self.message_user(request, f"{updated} challenge(s) published.", messages.SUCCESS)

    @admin.action(description="Unpublish selected challenges")
    def unpublish(self, request, queryset):
        updated = queryset.update(is_published=False, updated_at=timezone.now())
        self.message_user(request, f"{updated} challenge(s) unpublished.", messages.SUCCESS)


@admin.register(OsintChallengeProgress)
class OsintChallengeProgressAdmin(admin.ModelAdmin):
    list_display = ("user", "challenge", "method", "completed_at")
    list_filter = ("method",)
    search_fields = ("user__email", "challenge__title")
    raw_id_fields = ("user", "challenge")
    readonly_fields = ("completed_at",)
