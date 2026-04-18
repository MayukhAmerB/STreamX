from django.contrib import admin

from .models import Notification, NotificationRecipient, WebPushSubscription


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ("title", "kind", "course", "live_class", "created_at")
    list_filter = ("kind", "created_at")
    search_fields = ("title", "body", "event_key", "course__title", "live_class__title")
    readonly_fields = ("created_at",)
    ordering = ("-created_at", "-id")


@admin.register(NotificationRecipient)
class NotificationRecipientAdmin(admin.ModelAdmin):
    list_display = ("user", "notification", "read_at", "pushed_at", "created_at")
    list_filter = ("read_at", "pushed_at", "created_at", "notification__kind")
    search_fields = ("user__email", "user__full_name", "notification__title")
    readonly_fields = ("created_at",)
    ordering = ("-created_at", "-id")


@admin.register(WebPushSubscription)
class WebPushSubscriptionAdmin(admin.ModelAdmin):
    list_display = ("user", "is_active", "last_seen_at", "created_at")
    list_filter = ("is_active", "last_seen_at", "created_at")
    search_fields = ("user__email", "user__full_name", "endpoint")
    readonly_fields = ("created_at", "updated_at", "last_seen_at")
    ordering = ("-last_seen_at", "-id")
