from django.contrib import admin, messages

from .models import IdempotencyKey, OutboxEvent
from .outbox import retry_events


@admin.register(OutboxEvent)
class OutboxEventAdmin(admin.ModelAdmin):
    list_display = ("id", "event_type", "status", "attempts", "max_attempts", "available_at", "created_at", "short_error")
    list_filter = ("status", "event_type")
    search_fields = ("event_type", "dedupe_key", "request_id", "last_error")
    ordering = ("-created_at", "-id")
    date_hierarchy = "created_at"
    actions = ["retry_selected"]
    readonly_fields = (
        "event_type",
        "payload",
        "dedupe_key",
        "status",
        "attempts",
        "max_attempts",
        "available_at",
        "locked_at",
        "locked_by",
        "last_error",
        "request_id",
        "created_at",
        "delivered_at",
    )

    @admin.display(description="Last error")
    def short_error(self, obj):
        text = str(obj.last_error or "")
        return text if len(text) <= 80 else f"{text[:77]}..."

    @admin.action(description="Retry selected events now (dead letters and pending)", permissions=["retry"])
    def retry_selected(self, request, queryset):
        count = retry_events(queryset)
        self.message_user(
            request,
            f"{count} event(s) queued for immediate delivery. Delivered/processing events are left untouched.",
            messages.SUCCESS if count else messages.WARNING,
        )

    def has_retry_permission(self, request):
        return request.user.has_perm("core.change_outboxevent")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        # Rows are immutable records; the retry action is the only mutation.
        return False


@admin.register(IdempotencyKey)
class IdempotencyKeyAdmin(admin.ModelAdmin):
    list_display = ("id", "scope", "status", "response_status", "created_at", "expires_at")
    list_filter = ("status", "scope")
    search_fields = ("scope",)
    ordering = ("-created_at",)
    readonly_fields = [field.name for field in IdempotencyKey._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
