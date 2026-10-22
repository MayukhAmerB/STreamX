from config.url_utils import get_media_public_url
from django.contrib import admin
from django.utils.html import format_html

from .models import (
    FirFilingGuide,
    LawsSection,
    LawTopic,
    NationalDeskSettings,
    TrackerOverview,
    TrackerUpdate,
)


def _audio_tag(file_field):
    if file_field and getattr(file_field, "name", ""):
        try:
            url = get_media_public_url(file_field.url)
        except ValueError:
            return "—"
        return format_html(
            '<audio controls preload="none" src="{}" style="max-width:320px"></audio>', url
        )
    return "—"


def _image_tag(file_field):
    if file_field and getattr(file_field, "name", ""):
        try:
            url = get_media_public_url(file_field.url)
        except ValueError:
            return "—"
        return format_html(
            '<img src="{}" alt="" style="max-height:160px;border-radius:8px" />', url
        )
    return "—"


class SingletonAdmin(admin.ModelAdmin):
    """Admin for single-row configuration models: no add (once created) and no delete."""

    def has_add_permission(self, request):
        if not super().has_add_permission(request):
            return False
        return not self.model.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(NationalDeskSettings)
class NationalDeskSettingsAdmin(SingletonAdmin):
    list_display = ("__str__", "is_published", "instagram_enabled", "updated_at")
    readonly_fields = ("updated_at",)
    fieldsets = (
        ("Visibility", {"fields": ("is_published",)}),
        ("Instagram", {"fields": ("instagram_enabled", "instagram_url")}),
        ("Meta", {"fields": ("updated_at",)}),
    )


@admin.register(FirFilingGuide)
class FirFilingGuideAdmin(SingletonAdmin):
    list_display = ("title", "section_label", "is_active", "updated_at")
    readonly_fields = ("hero_preview", "audio_preview", "updated_at")
    fieldsets = (
        ("Header", {"fields": ("badge_label", "section_label", "title", "subtitle")}),
        ("Hero image", {"fields": ("hero_image", "hero_preview")}),
        (
            "Audio guide",
            {"fields": ("audio_kicker", "audio_title", "audio_duration", "audio_file", "audio_preview")},
        ),
        ("Visibility", {"fields": ("is_active",)}),
        ("Meta", {"fields": ("updated_at",)}),
    )

    @admin.display(description="Hero preview")
    def hero_preview(self, obj):
        return _image_tag(obj.hero_image)

    @admin.display(description="Audio preview")
    def audio_preview(self, obj):
        return _audio_tag(obj.audio_file)


@admin.register(LawsSection)
class LawsSectionAdmin(SingletonAdmin):
    list_display = ("title", "section_label", "is_active", "updated_at")
    readonly_fields = ("hero_preview", "updated_at")
    fieldsets = (
        ("Header", {"fields": ("section_label", "title", "subtitle")}),
        ("Hero image", {"fields": ("hero_image", "hero_preview")}),
        ("Stay Updated call to action", {"fields": ("cta_kicker", "cta_title", "cta_body")}),
        ("Visibility", {"fields": ("is_active",)}),
        ("Meta", {"fields": ("updated_at",)}),
    )

    @admin.display(description="Hero preview")
    def hero_preview(self, obj):
        return _image_tag(obj.hero_image)


@admin.register(LawTopic)
class LawTopicAdmin(admin.ModelAdmin):
    list_display = ("title", "icon_key", "audio_duration", "has_audio", "sort_order", "is_active", "updated_at")
    list_editable = ("sort_order", "is_active")
    list_filter = ("is_active", "icon_key")
    search_fields = ("title", "body")
    readonly_fields = ("audio_preview", "created_at", "updated_at")
    ordering = ("sort_order", "pk")
    fields = (
        "icon_key",
        "title",
        "body",
        "audio_duration",
        "audio_file",
        "audio_preview",
        "sort_order",
        "is_active",
        "created_at",
        "updated_at",
    )

    @admin.display(description="Audio", boolean=True)
    def has_audio(self, obj):
        return bool(obj.audio_file and getattr(obj.audio_file, "name", ""))

    @admin.display(description="Audio preview")
    def audio_preview(self, obj):
        return _audio_tag(obj.audio_file)


@admin.register(TrackerOverview)
class TrackerOverviewAdmin(SingletonAdmin):
    list_display = ("title", "total_filed", "in_progress", "completed", "planned", "is_active", "updated_at")
    readonly_fields = ("hero_preview", "updated_at")
    fieldsets = (
        ("Header", {"fields": ("section_label", "title", "subtitle", "tagline")}),
        ("Hero image", {"fields": ("hero_image", "hero_preview")}),
        ("Stat counters", {"fields": ("total_filed", "in_progress", "completed", "planned")}),
        (
            "Full tracker call to action",
            {"fields": ("updates_cta_kicker", "updates_cta_body", "full_tracker_url")},
        ),
        ("Visibility", {"fields": ("is_active",)}),
        ("Meta", {"fields": ("updated_at",)}),
    )

    @admin.display(description="Hero preview")
    def hero_preview(self, obj):
        return _image_tag(obj.hero_image)


@admin.register(TrackerUpdate)
class TrackerUpdateAdmin(admin.ModelAdmin):
    list_display = ("city", "region", "status", "status_note", "event_date", "sort_order", "is_active", "updated_at")
    list_editable = ("sort_order", "is_active")
    list_filter = ("status", "is_active", "region")
    search_fields = ("city", "region", "status_note")
    date_hierarchy = "event_date"
    ordering = ("sort_order", "-event_date", "-pk")
    readonly_fields = ("created_at", "updated_at")
    fields = (
        "city",
        "region",
        "status",
        "status_note",
        "event_date",
        "sort_order",
        "is_active",
        "created_at",
        "updated_at",
    )
