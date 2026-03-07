from django import forms
from django.contrib import admin
from django.http import HttpResponseRedirect
from django.urls import reverse
from django.utils.html import format_html

from config.url_utils import get_media_public_url

from .models import RealtimeConfiguration, RealtimeSession, RealtimeSessionRecording
from .services import delete_recording_assets


class RealtimeConfigurationAdminForm(forms.ModelForm):
    BROADCAST_MODE_CURRENT = "broadcast_current"
    BROADCAST_MODE_PREMIUM_HD = "broadcast_premium_hd"
    MEETING_MODE_CURRENT = "meeting_current"
    MEETING_MODE_PREMIUM_HD = "meeting_premium_hd"

    broadcast_quality_mode = forms.ChoiceField(
        label="Broadcast Quality Preset",
        required=False,
        initial=BROADCAST_MODE_CURRENT,
        widget=forms.RadioSelect,
        choices=(
            (
                BROADCAST_MODE_CURRENT,
                "Default profile (keeps your current bitrate/resolution, e.g. existing 480p setup)",
            ),
            (
                BROADCAST_MODE_PREMIUM_HD,
                "Premium broadcast profile (1920x1080 @ 30fps, 3800 kbps)",
            ),
        ),
        help_text=(
            "Select Premium broadcast profile to apply 1080p defaults automatically. "
            "Leave on Default profile to use the current manual values."
        ),
    )
    meeting_camera_quality_mode = forms.ChoiceField(
        label="Meeting Camera Quality Preset",
        required=False,
        initial=MEETING_MODE_CURRENT,
        widget=forms.RadioSelect,
        choices=(
            (
                MEETING_MODE_CURRENT,
                "Default meeting profile (use current meeting camera values)",
            ),
            (
                MEETING_MODE_PREMIUM_HD,
                "Premium meeting profile (Google Meet-like HD: camera 1920x1080 @ 30fps, 3500 kbps + screen share 1920x1080 @ 30fps, 6000 kbps)",
            ),
        ),
        help_text=(
            "This preset controls both camera and screen-share quality for meetings. "
            "If broadcast profile is still on default low values, premium mode also upgrades broadcast host quality. "
            "For active participants, toggle camera/screen-share off/on or rejoin to apply."
        ),
    )

    class Meta:
        model = RealtimeConfiguration
        fields = "__all__"

    @staticmethod
    def _is_high_broadcast_profile(instance):
        return (
            (instance.broadcast_capture_width or 0) >= 1920
            and (instance.broadcast_capture_height or 0) >= 1080
            and (instance.broadcast_capture_fps or 0) >= 30
            and (instance.broadcast_max_video_bitrate_kbps or 0) >= 3200
        )

    @staticmethod
    def _is_high_meeting_profile(instance):
        return (
            (instance.meeting_camera_capture_width or 0) >= 1920
            and (instance.meeting_camera_capture_height or 0) >= 1080
            and (instance.meeting_camera_capture_fps or 0) >= 30
            and (instance.meeting_camera_max_video_bitrate_kbps or 0) >= 3200
            and (instance.meeting_screen_capture_width or 0) >= 1920
            and (instance.meeting_screen_capture_height or 0) >= 1080
            and (instance.meeting_screen_capture_fps or 0) >= 30
            and (instance.meeting_screen_max_video_bitrate_kbps or 0) >= 4500
        )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance and self.instance.pk and self._is_high_broadcast_profile(self.instance):
            self.fields["broadcast_quality_mode"].initial = self.BROADCAST_MODE_PREMIUM_HD
        else:
            self.fields["broadcast_quality_mode"].initial = self.BROADCAST_MODE_CURRENT
        if self.instance and self.instance.pk and self._is_high_meeting_profile(self.instance):
            self.fields["meeting_camera_quality_mode"].initial = self.MEETING_MODE_PREMIUM_HD
        else:
            self.fields["meeting_camera_quality_mode"].initial = self.MEETING_MODE_CURRENT
        self.fields["broadcast_quality_mode"].help_text = (
            "Select Premium broadcast profile to apply 1080p defaults automatically. "
            "This affects only Broadcast Host Studio sessions. "
            "For a live host studio, reconnect camera to apply changes."
        )
        self.fields["meeting_camera_capture_width"].help_text = (
            "Meeting profile updates apply on participant rejoin or after re-enabling camera."
        )
        self.fields["meeting_camera_capture_height"].help_text = (
            "Meeting profile updates apply on participant rejoin or after re-enabling camera."
        )
        self.fields["meeting_camera_capture_fps"].help_text = (
            "Meeting profile updates apply on participant rejoin or after re-enabling camera."
        )
        self.fields["meeting_camera_max_video_bitrate_kbps"].help_text = (
            "Meeting profile updates apply on participant rejoin or after re-enabling camera."
        )
        self.fields["meeting_screen_capture_width"].help_text = (
            "Meeting screen-share profile updates apply after re-enabling screen share."
        )
        self.fields["meeting_screen_capture_height"].help_text = (
            "Meeting screen-share profile updates apply after re-enabling screen share."
        )
        self.fields["meeting_screen_capture_fps"].help_text = (
            "Meeting screen-share profile updates apply after re-enabling screen share."
        )
        self.fields["meeting_screen_max_video_bitrate_kbps"].help_text = (
            "Meeting screen-share profile updates apply after re-enabling screen share."
        )

    def save(self, commit=True):
        instance = super().save(commit=False)
        selected_broadcast_mode = self.cleaned_data.get(
            "broadcast_quality_mode",
            self.BROADCAST_MODE_CURRENT,
        )
        if selected_broadcast_mode == self.BROADCAST_MODE_PREMIUM_HD:
            instance.broadcast_capture_width = 1920
            instance.broadcast_capture_height = 1080
            instance.broadcast_capture_fps = 30
            instance.broadcast_max_video_bitrate_kbps = 3800
        selected_meeting_mode = self.cleaned_data.get(
            "meeting_camera_quality_mode",
            self.MEETING_MODE_CURRENT,
        )
        if selected_meeting_mode == self.MEETING_MODE_PREMIUM_HD:
            instance.meeting_camera_capture_width = 1920
            instance.meeting_camera_capture_height = 1080
            instance.meeting_camera_capture_fps = 30
            instance.meeting_camera_max_video_bitrate_kbps = 3500
            instance.meeting_screen_capture_width = 1920
            instance.meeting_screen_capture_height = 1080
            instance.meeting_screen_capture_fps = 30
            instance.meeting_screen_max_video_bitrate_kbps = 6000
            # Keep broadcast quality aligned with premium meeting profile unless
            # admin has explicitly selected a custom broadcast mode.
            if (
                selected_broadcast_mode == self.BROADCAST_MODE_CURRENT
                and not self._is_high_broadcast_profile(instance)
            ):
                instance.broadcast_capture_width = 1920
                instance.broadcast_capture_height = 1080
                instance.broadcast_capture_fps = 30
                instance.broadcast_max_video_bitrate_kbps = 3800
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
        "linked_live_class",
        "host",
        "meeting_capacity",
        "max_audience",
        "created_at",
    )
    list_filter = ("session_type", "status", "stream_status", "linked_live_class", "created_at")
    search_fields = (
        "title",
        "room_name",
        "livekit_room_name",
        "host__email",
        "host__full_name",
        "linked_live_class__title",
        "linked_live_class__linked_course__title",
    )
    autocomplete_fields = ("host", "linked_live_class")
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
            "Meeting Camera Profile (Primary)",
            {
                "fields": (
                    "meeting_camera_quality_mode",
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
            "Broadcast Profile (Host Studio)",
            {
                "fields": (
                    "broadcast_quality_mode",
                    "broadcast_capture_width",
                    "broadcast_capture_height",
                    "broadcast_capture_fps",
                    "broadcast_max_video_bitrate_kbps",
                ),
                "classes": ("collapse",),
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

    def render_change_form(self, request, context, add=False, change=False, form_url="", obj=None):
        context["show_save_and_continue"] = False
        context["show_save_and_add_another"] = False
        return super().render_change_form(request, context, add, change, form_url, obj)

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


@admin.register(RealtimeSessionRecording)
class RealtimeSessionRecordingAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "session",
        "recording_type",
        "status",
        "started_by",
        "livekit_egress_id",
        "recording_player",
        "started_at",
        "ended_at",
        "created_at",
    )
    list_filter = ("recording_type", "status", "created_at", "started_at", "ended_at")
    list_display_links = ("id", "session")
    search_fields = (
        "session__title",
        "session__room_name",
        "session__livekit_room_name",
        "livekit_egress_id",
        "started_by__email",
        "video_file",
        "output_file_path",
        "output_download_url",
    )
    readonly_fields = (
        "session",
        "recording_type",
        "status",
        "started_by",
        "livekit_egress_id",
        "output_file_path",
        "output_download_url",
        "video_file",
        "recording_player",
        "error",
        "livekit_payload",
        "started_at",
        "ended_at",
        "created_at",
        "updated_at",
    )
    autocomplete_fields = ("session", "started_by")

    def has_add_permission(self, request):
        return False

    def delete_model(self, request, obj):
        delete_recording_assets(obj)
        super().delete_model(request, obj)

    def delete_queryset(self, request, queryset):
        for recording in queryset.iterator():
            delete_recording_assets(recording)
        super().delete_queryset(request, queryset)

    class Media:
        js = ("admin/js/recordings_changelist_row_click.js",)

    @admin.display(description="Playback")
    def recording_player(self, obj):
        playback_url = ""
        if obj.output_download_url:
            playback_url = obj.output_download_url
        elif getattr(obj, "video_file", None):
            playback_url = get_media_public_url(obj.video_file.url)
        elif obj.output_file_path and obj.pk:
            playback_url = reverse(
                "realtime-session-recording-download",
                kwargs={"recording_id": obj.pk},
            )
        if not playback_url:
            return "-"
        return format_html(
            '<video controls preload="metadata" src="{}" style="max-width: 420px; width: 100%; border-radius: 8px;"></video><br>'
            '<a href="{}" target="_blank" rel="noopener">Open recording</a>',
            playback_url,
            playback_url,
        )
