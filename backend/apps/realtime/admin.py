from django import forms
from django.contrib import admin
from django.http import HttpResponseRedirect
from django.urls import reverse

from .models import RealtimeConfiguration, RealtimeSession


class RealtimeConfigurationAdminForm(forms.ModelForm):
    MODE_CURRENT = "current"
    MODE_HIGH_720P = "high_720p"

    broadcast_quality_mode = forms.ChoiceField(
        label="Broadcast Quality Preset",
        required=False,
        initial=MODE_CURRENT,
        widget=forms.RadioSelect,
        choices=(
            (
                MODE_CURRENT,
                "Default profile (keeps your current bitrate/resolution, e.g. existing 480p setup)",
            ),
            (MODE_HIGH_720P, "High bitrate profile (1280x720 @ 24fps, 2200 kbps)"),
        ),
        help_text=(
            "Select High bitrate profile to apply 720p defaults automatically. "
            "Leave on Default profile to use the current manual values."
        ),
    )

    class Meta:
        model = RealtimeConfiguration
        fields = "__all__"

    @staticmethod
    def _is_high_profile(instance):
        return (
            (instance.broadcast_capture_width or 0) >= 1280
            and (instance.broadcast_capture_height or 0) >= 720
            and (instance.broadcast_max_video_bitrate_kbps or 0) >= 1800
        )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance and self.instance.pk and self._is_high_profile(self.instance):
            self.fields["broadcast_quality_mode"].initial = self.MODE_HIGH_720P
        else:
            self.fields["broadcast_quality_mode"].initial = self.MODE_CURRENT

    def save(self, commit=True):
        instance = super().save(commit=False)
        selected_mode = self.cleaned_data.get("broadcast_quality_mode", self.MODE_CURRENT)
        if selected_mode == self.MODE_HIGH_720P:
            instance.broadcast_capture_width = 1280
            instance.broadcast_capture_height = 720
            instance.broadcast_capture_fps = 24
            instance.broadcast_max_video_bitrate_kbps = 2200
        if commit:
            instance.save()
            self.save_m2m()
        return instance


@admin.register(RealtimeSession)
class RealtimeSessionAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "title",
        "session_type",
        "status",
        "stream_status",
        "host",
        "meeting_capacity",
        "max_audience",
        "created_at",
    )
    list_filter = ("session_type", "status", "stream_status", "created_at")
    search_fields = ("title", "room_name", "livekit_room_name", "host__email", "host__full_name")
    readonly_fields = (
        "slug",
        "created_at",
        "updated_at",
        "started_at",
        "ended_at",
        "livekit_egress_id",
        "livekit_egress_error",
    )


@admin.register(RealtimeConfiguration)
class RealtimeConfigurationAdmin(admin.ModelAdmin):
    form = RealtimeConfigurationAdminForm
    list_display = (
        "broadcast_profile_summary",
        "meeting_camera_profile_summary",
        "meeting_screen_profile_summary",
        "updated_at",
    )
    readonly_fields = ("created_at", "updated_at")
    fieldsets = (
        (
            "Broadcast Profile (Host Studio)",
            {
                "fields": (
                    "broadcast_quality_mode",
                    "broadcast_capture_width",
                    "broadcast_capture_height",
                    "broadcast_capture_fps",
                    "broadcast_max_video_bitrate_kbps",
                )
            },
        ),
        (
            "Meeting Camera Profile",
            {
                "fields": (
                    "meeting_camera_capture_width",
                    "meeting_camera_capture_height",
                    "meeting_camera_capture_fps",
                    "meeting_camera_max_video_bitrate_kbps",
                )
            },
        ),
        (
            "Meeting Screen Share Profile",
            {
                "fields": (
                    "meeting_screen_capture_width",
                    "meeting_screen_capture_height",
                    "meeting_screen_capture_fps",
                    "meeting_screen_max_video_bitrate_kbps",
                )
            },
        ),
        (
            "Audit",
            {
                "fields": ("created_at", "updated_at"),
            },
        ),
    )

    def has_add_permission(self, request):
        if RealtimeConfiguration.objects.exists():
            return False
        return super().has_add_permission(request)

    def has_delete_permission(self, request, obj=None):
        return False

    def changelist_view(self, request, extra_context=None):
        singleton = RealtimeConfiguration.objects.order_by("pk").first()
        if singleton:
            return HttpResponseRedirect(
                reverse("admin:realtime_realtimeconfiguration_change", args=[singleton.pk])
            )
        return super().changelist_view(request, extra_context=extra_context)

    @admin.display(description="Broadcast Profile")
    def broadcast_profile_summary(self, obj):
        return (
            f"{obj.broadcast_capture_width}x{obj.broadcast_capture_height} @ "
            f"{obj.broadcast_capture_fps}fps / {obj.broadcast_max_video_bitrate_kbps} kbps"
        )

    @admin.display(description="Meeting Camera Profile")
    def meeting_camera_profile_summary(self, obj):
        return (
            f"{obj.meeting_camera_capture_width}x{obj.meeting_camera_capture_height} @ "
            f"{obj.meeting_camera_capture_fps}fps / {obj.meeting_camera_max_video_bitrate_kbps} kbps"
        )

    @admin.display(description="Meeting Screen Profile")
    def meeting_screen_profile_summary(self, obj):
        return (
            f"{obj.meeting_screen_capture_width}x{obj.meeting_screen_capture_height} @ "
            f"{obj.meeting_screen_capture_fps}fps / {obj.meeting_screen_max_video_bitrate_kbps} kbps"
        )
