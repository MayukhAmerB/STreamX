from django import forms
from django.contrib import admin, messages
from django.http import HttpResponseRedirect
from django.urls import reverse
from django.utils import timezone
from django.utils.html import format_html
from datetime import timedelta
from urllib.parse import urlparse

from config.url_utils import get_media_public_url

from .models import OwncastChatIdentity, RealtimeConfiguration, RealtimeSession, RealtimeSessionRecording
from .services import (
    OwncastAdminError,
    OwncastConfigError,
    delete_recording_assets,
    owncast_set_chat_user_enabled,
    owncast_set_chat_user_moderator,
    release_expired_owncast_chat_timeouts,
    resolve_obs_stream_server_url,
    sync_owncast_chat_identities_from_recent_messages,
)


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


@admin.register(OwncastChatIdentity)
class OwncastChatIdentityAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "owncast_display_name",
        "owncast_user_id",
        "platform_email",
        "platform_full_name",
        "platform_role",
        "last_session",
        "owncast_is_moderator",
        "owncast_disabled_at",
        "owncast_timeout_until",
        "bridge_used_at",
        "launch_ip",
        "created_at",
    )
    actions = (
        "sync_recent_owncast_chat_handles",
        "ban_selected_owncast_chat_users",
        "unban_selected_owncast_chat_users",
        "timeout_selected_owncast_chat_users_10m",
        "grant_selected_owncast_moderators",
        "revoke_selected_owncast_moderators",
        "release_expired_owncast_timeouts",
    )
    exclude = ("access_token_secret",)
    list_filter = (
        "platform_role",
        "owncast_authenticated",
        "owncast_is_moderator",
        "owncast_disabled_at",
        "owncast_timeout_until",
        "bridge_used_at",
        "created_at",
        "session",
    )
    list_select_related = ("session", "user")
    search_fields = (
        "owncast_display_name",
        "owncast_user_id",
        "platform_email",
        "platform_full_name",
        "platform_display_name",
        "platform_user_id",
        "session__title",
        "launch_ip",
    )
    readonly_fields = (
        "session",
        "user",
        "platform_user_id",
        "platform_email",
        "platform_full_name",
        "platform_role",
        "platform_display_name",
        "owncast_user_id",
        "owncast_display_name",
        "owncast_display_color",
        "owncast_authenticated",
        "owncast_is_moderator",
        "owncast_disabled_at",
        "owncast_timeout_until",
        "access_token_hash",
        "launch_ip",
        "user_agent",
        "bridge_used_at",
        "created_at",
        "updated_at",
    )
    autocomplete_fields = ("session", "user")
    date_hierarchy = "created_at"

    def has_add_permission(self, request):
        return False

    @admin.display(description="Last session")
    def last_session(self, obj):
        return obj.session or "-"

    @admin.action(permissions=["change"], description="Sync recent Owncast chat handles")
    def sync_recent_owncast_chat_handles(self, request, queryset):
        try:
            result = sync_owncast_chat_identities_from_recent_messages()
        except (OwncastConfigError, OwncastAdminError) as exc:
            self.message_user(
                request,
                f"Owncast handle sync failed: {exc}",
                level=messages.ERROR,
            )
            return

        self.message_user(
            request,
            (
                "Owncast handle sync complete: "
                f"{result['updated_identities']} updated, "
                f"{result['matched_identities']} matched, "
                f"{result['scanned_users']} Owncast users scanned."
            ),
            level=messages.SUCCESS,
        )

    def _moderate_selected_users(self, request, queryset, *, actor, success_message):
        eligible_rows = [row for row in queryset if str(row.owncast_user_id or "").strip()]
        updated = 0
        errors = []
        for identity in eligible_rows:
            try:
                actor(identity)
                updated += 1
            except (OwncastConfigError, OwncastAdminError) as exc:
                errors.append(f"{identity.owncast_display_name}: {exc}")

        if errors:
            self.message_user(
                request,
                f"{success_message}: {updated} updated, {len(errors)} failed. First error: {errors[0]}",
                level=messages.ERROR,
            )
            return
        self.message_user(request, f"{success_message}: {updated} updated.", level=messages.SUCCESS)

    @admin.action(permissions=["change"], description="Ban selected Owncast chat users")
    def ban_selected_owncast_chat_users(self, request, queryset):
        now = timezone.now()

        def actor(identity):
            owncast_set_chat_user_enabled(owncast_user_id=identity.owncast_user_id, enabled=False)
            identity.owncast_disabled_at = now
            identity.owncast_timeout_until = None
            identity.save(update_fields=["owncast_disabled_at", "owncast_timeout_until", "updated_at"])

        self._moderate_selected_users(request, queryset, actor=actor, success_message="Owncast ban applied")

    @admin.action(permissions=["change"], description="Unban selected Owncast chat users")
    def unban_selected_owncast_chat_users(self, request, queryset):
        def actor(identity):
            owncast_set_chat_user_enabled(owncast_user_id=identity.owncast_user_id, enabled=True)
            identity.owncast_disabled_at = None
            identity.owncast_timeout_until = None
            identity.save(update_fields=["owncast_disabled_at", "owncast_timeout_until", "updated_at"])

        self._moderate_selected_users(request, queryset, actor=actor, success_message="Owncast unban applied")

    @admin.action(permissions=["change"], description="Timeout selected Owncast chat users for 10 minutes")
    def timeout_selected_owncast_chat_users_10m(self, request, queryset):
        now = timezone.now()
        timeout_until = now + timedelta(minutes=10)

        def actor(identity):
            owncast_set_chat_user_enabled(owncast_user_id=identity.owncast_user_id, enabled=False)
            identity.owncast_disabled_at = now
            identity.owncast_timeout_until = timeout_until
            identity.save(update_fields=["owncast_disabled_at", "owncast_timeout_until", "updated_at"])

        self._moderate_selected_users(request, queryset, actor=actor, success_message="Owncast timeout applied")

    @admin.action(permissions=["change"], description="Grant Owncast moderator status")
    def grant_selected_owncast_moderators(self, request, queryset):
        def actor(identity):
            owncast_set_chat_user_moderator(owncast_user_id=identity.owncast_user_id, is_moderator=True)
            identity.owncast_is_moderator = True
            identity.save(update_fields=["owncast_is_moderator", "updated_at"])

        self._moderate_selected_users(request, queryset, actor=actor, success_message="Owncast moderator granted")

    @admin.action(permissions=["change"], description="Revoke Owncast moderator status")
    def revoke_selected_owncast_moderators(self, request, queryset):
        def actor(identity):
            owncast_set_chat_user_moderator(owncast_user_id=identity.owncast_user_id, is_moderator=False)
            identity.owncast_is_moderator = False
            identity.save(update_fields=["owncast_is_moderator", "updated_at"])

        self._moderate_selected_users(request, queryset, actor=actor, success_message="Owncast moderator revoked")

    @admin.action(permissions=["change"], description="Release expired Owncast chat timeouts")
    def release_expired_owncast_timeouts(self, request, queryset):
        try:
            result = release_expired_owncast_chat_timeouts()
        except (OwncastConfigError, OwncastAdminError) as exc:
            self.message_user(request, f"Owncast timeout release failed: {exc}", level=messages.ERROR)
            return
        level = messages.ERROR if result["errors"] else messages.SUCCESS
        self.message_user(
            request,
            (
                "Owncast timeout release complete: "
                f"{result['released']} released, "
                f"{len(result['errors'])} failed, "
                f"{result['checked']} checked."
            ),
            level=level,
        )

    def has_view_permission(self, request, obj=None):
        return request.user.has_perm("realtime.view_owncastchatidentity")

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


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
