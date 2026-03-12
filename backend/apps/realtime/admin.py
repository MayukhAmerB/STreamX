from django import forms
from django.contrib import admin
from django.http import HttpResponseRedirect
from django.urls import reverse
from django.utils.html import format_html
from urllib.parse import urlparse

from config.url_utils import get_media_public_url

from .models import RealtimeConfiguration, RealtimeSession, RealtimeSessionRecording
from .services import delete_recording_assets, resolve_obs_stream_server_url


class RealtimeConfigurationAdminForm(forms.ModelForm):
    BROADCAST_MODE_LOW = RealtimeConfiguration.BROADCAST_QUALITY_MODE_LOW
    BROADCAST_MODE_PREMIUM_HD = RealtimeConfiguration.BROADCAST_QUALITY_MODE_PREMIUM_HD
    BROADCAST_MODE_ADAPTIVE = RealtimeConfiguration.BROADCAST_QUALITY_MODE_ADAPTIVE
    MEETING_MODE_LOW = RealtimeConfiguration.MEETING_QUALITY_MODE_LOW
    MEETING_MODE_PREMIUM_HD = RealtimeConfiguration.MEETING_QUALITY_MODE_PREMIUM_HD
    MEETING_MODE_ADAPTIVE = RealtimeConfiguration.MEETING_QUALITY_MODE_ADAPTIVE

    broadcast_quality_mode = forms.ChoiceField(
        label="Broadcast Quality Preset",
        required=False,
        initial=BROADCAST_MODE_LOW,
        widget=forms.RadioSelect,
        choices=(
            (
                BROADCAST_MODE_LOW,
                "Low profile (640x360 @ 20fps, 650 kbps)",
            ),
            (
                BROADCAST_MODE_PREMIUM_HD,
                "Premium broadcast profile (1920x1080 @ 30fps, 3800 kbps)",
            ),
            (
                BROADCAST_MODE_ADAPTIVE,
                "Adaptive profile (starts at 720p, drops to 480p/360p based on audience load)",
            ),
        ),
        help_text=(
            "Choose the broadcast quality profile for Host Studio publishing."
        ),
    )
    meeting_quality_mode = forms.ChoiceField(
        label="Meeting Quality Preset",
        required=False,
        initial=MEETING_MODE_LOW,
        widget=forms.RadioSelect,
        choices=(
            (
                MEETING_MODE_LOW,
                "Low profile (camera 854x480 @ 20fps, 850 kbps + screen share 854x480 @ 12fps, 1400 kbps)",
            ),
            (
                MEETING_MODE_PREMIUM_HD,
                "Premium meeting profile (Google Meet-like HD: camera 1920x1080 @ 30fps, 3500 kbps + screen share 1920x1080 @ 30fps, 6000 kbps)",
            ),
            (
                MEETING_MODE_ADAPTIVE,
                "Adaptive profile (starts at 1280x720; automatically drops to 854x480 as participant load increases)",
            ),
        ),
        help_text=(
            "This preset controls both camera and screen-share quality for meetings. "
            "If broadcast profile is still on default low values, premium mode can also upgrade broadcast host quality. "
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
        if self.instance and self.instance.pk:
            current_broadcast_mode = str(
                getattr(self.instance, "broadcast_quality_mode", "") or ""
            ).strip().lower()
            if current_broadcast_mode in {
                self.BROADCAST_MODE_LOW,
                self.BROADCAST_MODE_PREMIUM_HD,
                self.BROADCAST_MODE_ADAPTIVE,
            }:
                self.fields["broadcast_quality_mode"].initial = current_broadcast_mode
            elif self._is_high_broadcast_profile(self.instance):
                self.fields["broadcast_quality_mode"].initial = self.BROADCAST_MODE_PREMIUM_HD
            else:
                self.fields["broadcast_quality_mode"].initial = self.BROADCAST_MODE_LOW
        else:
            self.fields["broadcast_quality_mode"].initial = self.BROADCAST_MODE_LOW
        if self.instance and self.instance.pk:
            current_meeting_mode = str(
                getattr(self.instance, "meeting_quality_mode", "") or ""
            ).strip().lower()
            if current_meeting_mode in {
                self.MEETING_MODE_LOW,
                self.MEETING_MODE_PREMIUM_HD,
                self.MEETING_MODE_ADAPTIVE,
            }:
                self.fields["meeting_quality_mode"].initial = current_meeting_mode
            elif self._is_high_meeting_profile(self.instance):
                self.fields["meeting_quality_mode"].initial = self.MEETING_MODE_PREMIUM_HD
            else:
                self.fields["meeting_quality_mode"].initial = self.MEETING_MODE_LOW
        else:
            self.fields["meeting_quality_mode"].initial = self.MEETING_MODE_LOW
        self.fields["broadcast_quality_mode"].help_text = (
            "This affects only Broadcast Host Studio sessions. "
            "For a live host studio, reconnect camera to apply changes immediately."
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
            self.BROADCAST_MODE_LOW,
        )
        if selected_broadcast_mode not in {
            self.BROADCAST_MODE_LOW,
            self.BROADCAST_MODE_PREMIUM_HD,
            self.BROADCAST_MODE_ADAPTIVE,
        }:
            selected_broadcast_mode = self.BROADCAST_MODE_LOW
        instance.broadcast_quality_mode = selected_broadcast_mode
        if selected_broadcast_mode == self.BROADCAST_MODE_PREMIUM_HD:
            instance.apply_broadcast_profile(RealtimeConfiguration.premium_broadcast_profile())
        elif selected_broadcast_mode == self.BROADCAST_MODE_ADAPTIVE:
            # Save adaptive baseline; final profile is resolved per host token by audience load.
            instance.apply_broadcast_profile(RealtimeConfiguration.adaptive_base_broadcast_profile())
        else:
            instance.apply_broadcast_profile(RealtimeConfiguration.low_broadcast_profile())

        selected_meeting_mode = self.cleaned_data.get("meeting_quality_mode", self.MEETING_MODE_LOW)
        if selected_meeting_mode not in {
            self.MEETING_MODE_LOW,
            self.MEETING_MODE_PREMIUM_HD,
            self.MEETING_MODE_ADAPTIVE,
        }:
            selected_meeting_mode = self.MEETING_MODE_LOW
        instance.meeting_quality_mode = selected_meeting_mode
        if selected_meeting_mode == self.MEETING_MODE_PREMIUM_HD:
            instance.apply_meeting_profile(RealtimeConfiguration.premium_meeting_profile())
        elif selected_meeting_mode == self.MEETING_MODE_ADAPTIVE:
            # Save adaptive baseline; final profile is resolved per join from participant load.
            instance.apply_meeting_profile(RealtimeConfiguration.adaptive_base_meeting_profile())
        else:
            instance.apply_meeting_profile(RealtimeConfiguration.low_meeting_profile())
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
        "stream_service",
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
        "obs_stream_server_url_display",
        "obs_stream_target_url_display",
    )
    fieldsets = (
        (
            "Session",
            {
                "fields": (
                    "title",
                    "slug",
                    "description",
                    "session_type",
                    "status",
                    "host",
                    "linked_live_class",
                    "linked_course",
                )
            },
        ),
        (
            "Capacity & Stage Control",
            {
                "fields": (
                    "meeting_capacity",
                    "max_audience",
                    "allow_overflow_broadcast",
                    "presenter_user_ids",
                    "speaker_user_ids",
                )
            },
        ),
        (
            "Broadcast Delivery",
            {
                "fields": (
                    "stream_service",
                    "stream_embed_url",
                    "chat_embed_url",
                    "rtmp_target_url",
                    "obs_stream_key",
                    "obs_stream_server_url_display",
                    "obs_stream_target_url_display",
                )
            },
        ),
        (
            "Runtime",
            {
                "fields": (
                    "room_name",
                    "livekit_room_name",
                    "stream_status",
                    "livekit_egress_id",
                    "livekit_egress_error",
                    "started_at",
                    "ended_at",
                    "created_at",
                    "updated_at",
                )
            },
        ),
    )

    @admin.display(description="OBS Server URL")
    def obs_stream_server_url_display(self, obj):
        return resolve_obs_stream_server_url(session=obj)

    @admin.display(description="OBS Stream Target")
    def obs_stream_target_url_display(self, obj):
        if obj.stream_service != RealtimeSession.STREAM_SERVICE_OBS:
            return "-"
        return obj.resolve_stream_target_url()


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
                    "meeting_quality_mode",
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
        "admin_actions",
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
    actions = ("delete_selected_recordings",)

    def has_add_permission(self, request):
        return False

    def delete_model(self, request, obj):
        delete_recording_assets(obj)
        super().delete_model(request, obj)

    def delete_queryset(self, request, queryset):
        for recording in queryset.iterator():
            delete_recording_assets(recording)
        super().delete_queryset(request, queryset)

    @admin.action(
        description="Delete selected recordings (and remove linked recording files)",
        permissions=("change",),
    )
    def delete_selected_recordings(self, request, queryset):
        self.delete_queryset(request, queryset)

    @admin.display(description="Actions")
    def admin_actions(self, obj):
        if not getattr(obj, "pk", None):
            return "-"
        delete_url = reverse("admin:realtime_realtimesessionrecording_delete", args=[obj.pk])
        return format_html('<a href="{}">Delete</a>', delete_url)

    class Media:
        js = ("admin/js/recordings_changelist_row_click.js",)

    @admin.display(description="Recording File")
    def recording_player(self, obj):
        download_url = ""
        if obj.output_download_url:
            download_url = obj.output_download_url
        elif getattr(obj, "video_file", None):
            download_url = get_media_public_url(obj.video_file.url)
        elif obj.output_file_path and obj.pk:
            download_url = reverse(
                "realtime-session-recording-download",
                kwargs={"recording_id": obj.pk},
            )
        if not download_url:
            return "-"

        filename = ""
        if getattr(obj, "video_file", None) and getattr(obj.video_file, "name", ""):
            filename = str(obj.video_file.name).replace("\\", "/").split("/")[-1]
        if not filename and obj.output_file_path:
            filename = str(obj.output_file_path).replace("\\", "/").split("/")[-1]
        if not filename and obj.output_download_url:
            parsed_path = urlparse(obj.output_download_url).path
            filename = parsed_path.rstrip("/").split("/")[-1]
        if not filename:
            filename = f"recording-{obj.pk or 'file'}.webm"

        return format_html(
            '<a href="{}" target="_blank" rel="noopener" download>{}</a>',
            download_url,
            filename,
        )
