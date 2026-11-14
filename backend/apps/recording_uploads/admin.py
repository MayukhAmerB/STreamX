from django.contrib import admin, messages

from . import services, tokens
from .models import RecordingUpload, RecordingUploadToken


@admin.register(RecordingUpload)
class RecordingUploadAdmin(admin.ModelAdmin):
    list_display = (
        "filename",
        "session",
        "owner",
        "status",
        "action",
        "received_count",
        "chunk_count",
        "lecture",
        "reverted_at",
        "created_at",
    )
    list_filter = ("status", "action")
    search_fields = ("filename", "owner__email", "session__title")
    raw_id_fields = ("owner", "session", "token", "recording", "replaced_recording", "lecture", "reverted_by")
    actions = ("switch_to_previous_video", "switch_to_uploaded_video")
    readonly_fields = [field.name for field in RecordingUpload._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def _switch(self, request, queryset, *, restore_upload):
        done = 0
        for upload in queryset:
            try:
                services.switch_video(upload, user=request.user, restore_upload=restore_upload)
                done += 1
            except services.UploadError as exc:
                self.message_user(request, f"{upload.filename}: {exc.message}", level=messages.WARNING)
        if done:
            self.message_user(request, f"Switched {done} lecture video(s). The stream is being rebuilt.")

    @admin.action(description="Switch back to the replaced video (auto-recording)")
    def switch_to_previous_video(self, request, queryset):
        self._switch(request, queryset, restore_upload=False)

    @admin.action(description="Switch to the uploaded video again")
    def switch_to_uploaded_video(self, request, queryset):
        self._switch(request, queryset, restore_upload=True)


@admin.register(RecordingUploadToken)
class RecordingUploadTokenAdmin(admin.ModelAdmin):
    list_display = ("name", "prefix", "owner", "created_at", "last_used_at", "expires_at", "revoked_at")
    list_filter = ("revoked_at",)
    search_fields = ("name", "prefix", "owner__email")
    raw_id_fields = ("owner",)
    readonly_fields = ("prefix", "token_hash", "created_at", "last_used_at", "last_used_ip")
    actions = ("revoke",)

    def has_add_permission(self, request):
        return False  # created in the Console, where the token is shown once

    @admin.action(description="Revoke selected tokens")
    def revoke(self, request, queryset):
        for token in queryset:
            tokens.revoke_token(token)
        self.message_user(request, f"Revoked {queryset.count()} token(s).")
