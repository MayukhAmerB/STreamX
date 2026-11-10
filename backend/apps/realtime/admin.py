from django import forms
from django.contrib import admin, messages
from django.core.exceptions import PermissionDenied
from django.http import HttpResponseNotAllowed, HttpResponseRedirect
from django.urls import path, reverse
from django.utils import timezone
from django.utils.html import format_html
from datetime import timedelta
from pathlib import Path

from django.conf import settings

from .models import (
    OwncastChatIdentity,
    RealtimeConfiguration,
    RealtimeSession,
    RealtimeSessionRecording,
    ServerResourceProfile,
)
from .recording import admin as class_recording_admin  # noqa: F401  (registers ClassRecordingAdmin)
from apps.courses.models import Section
from .services import (
    OwncastAdminError,
    OwncastConfigError,
    delete_recording_assets,
    owncast_set_chat_user_enabled,
    owncast_set_chat_user_moderator,
    release_expired_owncast_chat_timeouts,
    resolve_obs_stream_server_url,
    resolve_recording_local_path,
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
        "target_module",
        "host",
        "meeting_capacity",
        "max_audience",
        "created_at",
    )
    list_filter = ("session_type", "status", "stream_status", "linked_live_class", "created_at")
    list_select_related = ("linked_live_class", "target_module", "host")
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
                    "target_module",
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

    def get_form(self, request, obj=None, change=False, **kwargs):
        form = super().get_form(request, obj, change=change, **kwargs)
        field = form.base_fields.get("target_module")
        if field is not None:
            queryset = Section.objects.select_related("course").order_by("course__title", "order", "id")
            course_id = obj.resolve_course_id() if obj is not None else None
            if course_id:
                queryset = queryset.filter(course_id=course_id)
            field.queryset = queryset
            field.help_text = (
                "Module of this session's course that receives the class recording as a lecture. "
                "On a new session every module is listed as 'Course - Module'; saving rejects a module "
                "from another course."
            )
        return form

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


class RecordingCourseFilter(admin.SimpleListFilter):
    title = "course"
    parameter_name = "course"

    def lookups(self, request, model_admin):
        from apps.courses.models import Course

        courses = Course.objects.filter(realtime_sessions__recordings__isnull=False).distinct().order_by("title")
        return [(str(course.pk), course.title) for course in courses]

    def queryset(self, request, queryset):
        value = self.value()
        return queryset.filter(session__linked_course_id=value) if value and value.isdigit() else queryset


def egress_local_path(recording, *, search=False):
    """Local file of a LiveKit/browser recording (None if unknown).

    ``search`` also tries the slower resolver (it may walk the recordings
    volume); list columns use the direct mapping only.
    """
    name = str(getattr(getattr(recording, "video_file", None), "name", "") or "")
    if name:
        return Path(settings.MEDIA_ROOT) / name
    output = str(recording.output_file_path or "").strip()
    if not output:
        return None
    if search:
        return resolve_recording_local_path(output)
    normalized = output.replace("\\", "/")
    prefix = str(getattr(settings, "LIVEKIT_RECORDING_FILEPATH_PREFIX", "/recordings") or "/recordings").rstrip("/")
    root = Path(str(getattr(settings, "LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT", "/recordings") or "/recordings"))
    if prefix and normalized.startswith(prefix + "/"):
        return root / normalized[len(prefix) + 1 :]
    candidate = Path(normalized)
    return candidate if candidate.is_absolute() else root / normalized.lstrip("/")


RECORDING_STATUS_CHIPS = {
    RealtimeSessionRecording.STATUS_STARTING: ("active", "time"),
    RealtimeSessionRecording.STATUS_RECORDING: ("active", "video"),
    RealtimeSessionRecording.STATUS_STOPPING: ("active", "time"),
    RealtimeSessionRecording.STATUS_COMPLETED: ("success", "checkmark"),
    RealtimeSessionRecording.STATUS_FAILED: ("error", "error"),
}


@admin.register(RealtimeSessionRecording)
class RealtimeSessionRecordingAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "session",
        "course_display",
        "module_display",
        "recording_type",
        "source_display",
        "status_display",
        "size_display",
        "duration_display",
        "lecture_display",
        "recording_player",
        "admin_actions",
        "started_at",
    )
    list_filter = (RecordingCourseFilter, "recording_type", "status", "created_at", "started_at", "ended_at")
    list_display_links = ("id", "session")
    list_select_related = (
        "session",
        "session__linked_course",
        "class_recording",
        "class_recording__module",
        "class_recording__lecture",
    )
    search_fields = (
        "session__title",
        "session__room_name",
        "session__livekit_room_name",
        "session__linked_course__title",
        "livekit_egress_id",
        "started_by__email",
        "video_file",
        "output_file_path",
        "output_download_url",
    )
    readonly_fields = (
        "player_panel",
        "session",
        "course_display",
        "module_display",
        "recording_type",
        "source_display",
        "status_display",
        "started_by",
        "livekit_egress_id",
        "output_file_path",
        "output_download_url",
        "video_file",
        "size_display",
        "lecture_display",
        "error",
        "livekit_payload",
        "started_at",
        "ended_at",
        "created_at",
        "updated_at",
    )
    autocomplete_fields = ("session", "started_by")
    actions = ("delete_selected_recordings",)

    class Media:
        js = ("admin/js/recordings_changelist_row_click.js",)
        css = {"all": ("admin/css/class_recordings.css",)}

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

    @staticmethod
    def _class_recording(obj):
        try:
            return obj.class_recording
        except Exception:  # RelatedObjectDoesNotExist: no class recording was built from it
            return None

    @admin.display(description="Course")
    def course_display(self, obj):
        course = getattr(obj.session, "linked_course", None)
        return course.title if course is not None else "-"

    @admin.display(description="Module")
    def module_display(self, obj):
        class_recording = self._class_recording(obj)
        module = getattr(class_recording, "module", None) if class_recording else None
        return module.title if module is not None else "-"

    @admin.display(description="Source")
    def source_display(self, obj):
        payload = obj.livekit_payload if isinstance(obj.livekit_payload, dict) else {}
        if obj.video_file or str(payload.get("source") or "").lower() == "browser_fallback":
            return "Host Studio (browser recording)"
        return "Host Studio (LiveKit egress)"

    @admin.display(description="Status", ordering="status")
    def status_display(self, obj):
        modifier, icon = RECORDING_STATUS_CHIPS.get(obj.status, ("neutral", "information"))
        return format_html(
            '<span class="enterprise-status enterprise-status--{}">'
            '<svg class="enterprise-icon" aria-hidden="true"><use href="#icon-{}"></use></svg>{}</span>',
            modifier,
            icon,
            obj.get_status_display(),
        )

    @admin.display(description="Size")
    def size_display(self, obj):
        path = egress_local_path(obj)
        try:
            size = path.stat().st_size if path is not None and path.is_file() else 0
        except OSError:
            size = 0
        if not size:
            return "-"
        for unit in ("B", "KB", "MB", "GB", "TB"):
            if size < 1024 or unit == "TB":
                return f"{size:.0f} {unit}" if unit in {"B", "KB"} else f"{size:.1f} {unit}"
            size /= 1024
        return "-"

    @admin.display(description="Duration")
    def duration_display(self, obj):
        class_recording = self._class_recording(obj)
        seconds = getattr(class_recording, "duration_seconds", None) if class_recording else None
        if not seconds:
            return "-"
        minutes, secs = divmod(int(seconds), 60)
        hours, minutes = divmod(minutes, 60)
        return f"{hours}:{minutes:02d}:{secs:02d}"

    @admin.display(description="Lecture")
    def lecture_display(self, obj):
        from .recording.admin import lecture_chip

        class_recording = self._class_recording(obj)
        if class_recording is None:
            return "Not published to a module"
        link = format_html(
            '<a href="{}">class recording #{}</a>',
            reverse("admin:realtime_classrecording_change", args=[class_recording.pk]),
            class_recording.pk,
        )
        lecture = class_recording.lecture if class_recording.lecture_id else None
        return format_html("{}<br>{}", lecture_chip(lecture), link) if lecture else link

    @admin.display(description="Actions")
    def admin_actions(self, obj):
        if not getattr(obj, "pk", None):
            return "-"
        delete_url = reverse("admin:realtime_realtimesessionrecording_delete", args=[obj.pk])
        return format_html('<a href="{}">Delete</a>', delete_url)

    def _media_url(self, obj):
        return reverse("admin:realtime_realtimesessionrecording_media", args=[obj.pk])

    @admin.display(description="Recording File")
    def recording_player(self, obj):
        path = egress_local_path(obj)
        if path is None:
            if obj.output_download_url:
                return format_html('<a href="{}" target="_blank" rel="noopener">External file</a>',
                                   obj.output_download_url)
            return "-"
        return format_html('<a href="{}?download=1" download>{}</a>', self._media_url(obj), path.name)

    @admin.display(description="Video")
    def player_panel(self, obj):
        if not getattr(obj, "pk", None):
            return "-"
        path = egress_local_path(obj, search=True)
        if path is None or not path.is_file():
            if obj.output_download_url:
                return format_html('<a href="{}" target="_blank" rel="noopener">External file</a>',
                                   obj.output_download_url)
            return "No video file on the server for this recording."
        url = self._media_url(obj)
        player = ""
        if path.suffix.lower() in {".mp4", ".m4v", ".mov", ".webm"}:
            player = format_html(
                '<video class="class-recording-player" controls preload="metadata" src="{}"></video>', url
            )
        return format_html(
            '<div class="class-recording-panel">{}<p><a class="button" href="{}?download=1" download>Download {}</a>'
            "</p></div>",
            player,
            url,
            path.name,
        )

    def get_urls(self):
        custom = [
            path(
                "<int:recording_id>/media/",
                self.admin_site.admin_view(self.media_view),
                name="realtime_realtimesessionrecording_media",
            ),
        ]
        return custom + super().get_urls()

    def media_view(self, request, recording_id):
        from django.shortcuts import get_object_or_404

        from .recording.media import staff_file_response

        recording = get_object_or_404(RealtimeSessionRecording, pk=recording_id)
        if not self.has_view_permission(request, recording):
            raise PermissionDenied
        return staff_file_response(
            request, egress_local_path(recording, search=True), download=request.GET.get("download") == "1"
        )


@admin.register(ServerResourceProfile)
class ServerResourceProfileAdmin(admin.ModelAdmin):
    fields = ("profile", "status", "applied_profile", "applied_at", "agent_last_seen_at", "agent_last_error", "updated_by", "updated_at")
    readonly_fields = ("status", "applied_profile", "applied_at", "agent_last_seen_at", "agent_last_error", "updated_by", "updated_at")
    radio_fields = {"profile": admin.HORIZONTAL}

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_urls(self):
        custom = [
            path(
                "switch/",
                self.admin_site.admin_view(self.switch_view),
                name="realtime_serverresourceprofile_switch",
            ),
        ]
        return custom + super().get_urls()

    def changelist_view(self, request, extra_context=None):
        singleton = ServerResourceProfile.get_solo()
        return HttpResponseRedirect(reverse("admin:realtime_serverresourceprofile_change", args=[singleton.pk]))

    @admin.display(description="Status")
    def status(self, obj):
        return obj.status_label()

    def save_model(self, request, obj, form, change):
        obj.updated_by = request.user
        super().save_model(request, obj, form, change)

    def switch_view(self, request):
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        if not self.has_change_permission(request):
            raise PermissionDenied
        requested = str(request.POST.get("profile") or "").strip()
        if requested not in dict(ServerResourceProfile.PROFILE_CHOICES):
            messages.error(request, "Unknown server profile.")
            return HttpResponseRedirect(reverse("admin:index"))
        profile = ServerResourceProfile.get_solo()
        if profile.profile != requested:
            previous = profile.profile
            profile.profile = requested
            profile.updated_by = request.user
            profile.save(update_fields=["profile", "updated_by", "updated_at"])
            self.log_change(request, profile, f"Server profile {previous} -> {requested}")
            label = dict(ServerResourceProfile.PROFILE_CHOICES)[requested]
            if profile.agent_online():
                messages.success(request, f"Switching to the {label} profile. It applies within about 15 seconds.")
            else:
                messages.warning(
                    request,
                    f"{label} profile saved, but the host agent is offline. It will apply when the agent reconnects.",
                )
        return HttpResponseRedirect(reverse("admin:index"))
