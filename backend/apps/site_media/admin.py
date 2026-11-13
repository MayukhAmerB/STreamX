from django.contrib import admin
from django.http import HttpResponseRedirect
from django.urls import reverse
from django.utils.html import format_html

from .models import YouTubeChannel
from .youtube import parse_video_id, watch_url


@admin.register(YouTubeChannel)
class YouTubeChannelAdmin(admin.ModelAdmin):
    """One row: the changelist opens the settings form directly."""

    fieldsets = (
        ("Channel", {"fields": ("channel_title", "channel_id", "handle", "channel_url")}),
        (
            "Website section",
            {"fields": ("section_enabled", "section_title", "section_subtitle", "latest_count", "prefer_live")},
        ),
        ("Featured video", {"fields": ("featured_video_url", "featured_video_preview")}),
        ("Status", {"fields": ("updated_at",)}),
    )
    readonly_fields = ("featured_video_preview", "updated_at")

    @admin.display(description="Featured video ID")
    def featured_video_preview(self, obj):
        video_id = parse_video_id(getattr(obj, "featured_video_url", ""))
        if not video_id:
            return "Latest upload (no video pinned)"
        return format_html('<a href="{}" target="_blank" rel="noopener noreferrer">{}</a>', watch_url(video_id), video_id)

    def has_add_permission(self, request):
        return super().has_add_permission(request) and not YouTubeChannel.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False

    def changelist_view(self, request, extra_context=None):
        obj = YouTubeChannel.objects.filter(pk=1).first()
        if obj is not None:
            return HttpResponseRedirect(reverse("admin:site_media_youtubechannel_change", args=(obj.pk,)))
        if self.has_add_permission(request):
            return HttpResponseRedirect(reverse("admin:site_media_youtubechannel_add"))
        return super().changelist_view(request, extra_context)
