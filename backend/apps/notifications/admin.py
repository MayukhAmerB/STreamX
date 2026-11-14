import uuid

from django import forms
from django.contrib import admin
from django.contrib.auth import get_user_model

from .models import Notification, NotificationRecipient, WebPushSubscription
from .services import course_enrolled_user_ids, create_notification, live_class_recipient_user_ids

AUDIENCE_COURSE = "course"
AUDIENCE_LIVE_CLASS = "live_class"
AUDIENCE_EVERYONE = "everyone"
AUDIENCE_CHOICES = (
    (AUDIENCE_COURSE, "Students enrolled in a course"),
    (AUDIENCE_LIVE_CLASS, "Students of a live class"),
    (AUDIENCE_EVERYONE, "Every active account"),
)


def audience_user_ids(audience, *, course=None, live_class=None):
    if audience == AUDIENCE_COURSE:
        return course_enrolled_user_ids(course)
    if audience == AUDIENCE_LIVE_CLASS:
        return live_class_recipient_user_ids(live_class)
    if audience == AUDIENCE_EVERYONE:
        return list(get_user_model().objects.filter(is_active=True).values_list("pk", flat=True))
    return []


class AnnouncementForm(forms.ModelForm):
    """Add form: an announcement always reaches someone (UI plan §4.8).

    Adding a Notification row on its own creates no recipients, so nobody
    would ever see it. The add form asks who it is for, and saving fans it out
    through ``notifications.services.create_notification`` (recipients and web
    push), the same path the platform's automatic notifications use.
    """

    audience = forms.ChoiceField(choices=AUDIENCE_CHOICES, initial=AUDIENCE_COURSE, help_text="Who receives it in their notifications.")

    class Meta:
        model = Notification
        fields = ("audience", "title", "body", "action_url", "course", "live_class")

    def clean(self):
        cleaned = super().clean()
        audience = cleaned.get("audience")
        if audience == AUDIENCE_COURSE and not cleaned.get("course"):
            self.add_error("course", "Choose the course whose students should receive this.")
        if audience == AUDIENCE_LIVE_CLASS and not cleaned.get("live_class"):
            self.add_error("live_class", "Choose the live class whose students should receive this.")
        if not self.errors:
            recipients = audience_user_ids(audience, course=cleaned.get("course"), live_class=cleaned.get("live_class"))
            if not recipients:
                raise forms.ValidationError("Nobody would receive this yet: the audience you chose has no active students.")
            self.recipient_ids = recipients
        return cleaned


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ("title", "kind", "course", "live_class", "recipient_count", "created_at")
    list_filter = ("kind", "created_at")
    search_fields = ("title", "body", "event_key", "course__title", "live_class__title")
    readonly_fields = ("created_at",)
    ordering = ("-created_at", "-id")
    autocomplete_fields = ()

    def get_form(self, request, obj=None, change=False, **kwargs):
        if obj is None:
            kwargs["form"] = AnnouncementForm
        return super().get_form(request, obj, change=change, **kwargs)

    def get_fieldsets(self, request, obj=None):
        if obj is None:
            return (
                (None, {"fields": ("audience", "course", "live_class")}),
                ("Message", {"fields": ("title", "body", "action_url")}),
            )
        return super().get_fieldsets(request, obj)

    def get_queryset(self, request):
        from django.db.models import Count

        return super().get_queryset(request).select_related("course", "live_class").annotate(_recipients=Count("recipients"))

    @admin.display(description="Recipients", ordering="_recipients")
    def recipient_count(self, obj):
        return getattr(obj, "_recipients", None)

    def save_model(self, request, obj, form, change):
        if change:
            return super().save_model(request, obj, form, change)
        notification = create_notification(
            kind=Notification.KIND_ANNOUNCEMENT,
            title=form.cleaned_data["title"],
            body=form.cleaned_data["body"],
            recipients=getattr(form, "recipient_ids", []),
            event_key=f"announcement:{uuid.uuid4().hex}",
            action_url=form.cleaned_data.get("action_url") or "",
            course=form.cleaned_data.get("course"),
            live_class=form.cleaned_data.get("live_class"),
            created_by=request.user,
        )
        # The admin's add response needs the saved row.
        obj.pk = notification.pk
        obj.event_key = notification.event_key
        obj.kind = notification.kind
        obj._state.adding = False


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
