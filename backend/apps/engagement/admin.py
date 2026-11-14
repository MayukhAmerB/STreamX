"""Django admin for engagement.

The XP ledger, summaries, activity days, attendance, achievements and the
audit log are read-only: XP changes only through ``services`` (append-only
ledger). Admin actions (revoke XP, revoke a badge or an achievement) call the
same audited services and refuse while the ``engagement`` switch is off.
"""

from django import forms
from django.contrib import admin, messages
from django.utils import timezone

from apps.core.errors import DomainError

from . import badges as badge_catalogue
from . import certificates, services
from .models import (
    Achievement,
    ActivityDay,
    BadgeAward,
    Certificate,
    CertificateRevision,
    EngagementAuditLog,
    EngagementSettings,
    EngagementSummary,
    LiveAttendance,
    XpEvent,
)

ADMIN_REASON = "Revoked from the Django admin."


class ReadOnlyAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(XpEvent)
class XpEventAdmin(ReadOnlyAdmin):
    list_display = ("id", "user", "kind", "points", "source_type", "source_id", "occurred_at", "created_at")
    list_filter = ("kind", "source_type", ("created_at", admin.DateFieldListFilter))
    search_fields = ("user__email", "user__full_name", "idempotency_key", "source_id")
    raw_id_fields = ("user",)
    date_hierarchy = "created_at"
    list_select_related = ("user",)
    show_full_result_count = False
    actions = ["revoke_selected"]

    def has_change_permission(self, request, obj=None):
        # The changelist action needs a "change" right; the form stays read-only.
        return obj is None and request.user.has_perm("engagement.change_xpevent")

    def get_readonly_fields(self, request, obj=None):
        return [field.name for field in self.model._meta.fields]

    @admin.action(description="Revoke selected XP events (adds a correcting entry)")
    def revoke_selected(self, request, queryset):
        done = 0
        try:
            for event in queryset.exclude(kind="revoke")[:500]:
                services.staff_revoke_xp(actor=request.user, event_id=event.pk, reason=ADMIN_REASON, request=request)
                done += 1
        except DomainError as exc:
            self.message_user(request, exc.message, level=messages.ERROR)
            return
        self.message_user(request, f"Revoked {done} XP event(s).", level=messages.SUCCESS)


@admin.register(EngagementSummary)
class EngagementSummaryAdmin(ReadOnlyAdmin):
    list_display = ("user", "total_xp", "level", "weekly_xp", "week_start", "current_streak", "best_streak", "badges_count", "last_activity_at")
    list_filter = ("level", "week_start")
    search_fields = ("user__email", "user__full_name")
    raw_id_fields = ("user",)
    ordering = ("-total_xp",)
    list_select_related = ("user",)
    show_full_result_count = False


@admin.register(ActivityDay)
class ActivityDayAdmin(ReadOnlyAdmin):
    list_display = ("user", "day", "xp", "is_study_day", "watch_seconds", "backfill_watch_seconds", "live_seconds", "watch_xp_awarded")
    list_filter = ("is_study_day", ("day", admin.DateFieldListFilter))
    search_fields = ("user__email",)
    raw_id_fields = ("user",)
    date_hierarchy = "day"
    list_select_related = ("user",)
    show_full_result_count = False


@admin.register(LiveAttendance)
class LiveAttendanceAdmin(ReadOnlyAdmin):
    list_display = ("session_id", "user", "seconds", "on_air_seconds", "first_seen_at", "last_seen_at", "finalized_at")
    list_filter = (("finalized_at", admin.EmptyFieldListFilter),)
    search_fields = ("user__email", "=session_id")
    raw_id_fields = ("user",)
    list_select_related = ("user",)


class BadgeKeyFilter(admin.SimpleListFilter):
    title = "badge"
    parameter_name = "badge"

    def lookups(self, request, model_admin):
        return [(badge.key, badge.title) for badge in badge_catalogue.CATALOGUE]

    def queryset(self, request, queryset):
        return queryset.filter(badge_key=self.value()) if self.value() else queryset


@admin.register(BadgeAward)
class BadgeAwardAdmin(ReadOnlyAdmin):
    list_display = ("user", "badge_title", "tier", "awarded_at", "revoked_at", "note")
    list_filter = (BadgeKeyFilter, ("revoked_at", admin.EmptyFieldListFilter))
    search_fields = ("user__email", "user__full_name", "badge_key")
    raw_id_fields = ("user",)
    list_select_related = ("user",)
    actions = ["revoke_selected"]

    def has_change_permission(self, request, obj=None):
        return obj is None and request.user.has_perm("engagement.change_badgeaward")

    @admin.display(description="Badge")
    def badge_title(self, obj):
        badge = badge_catalogue.get(obj.badge_key)
        return badge.title if badge else obj.badge_key

    @admin.display(description="Tier")
    def tier(self, obj):
        badge = badge_catalogue.get(obj.badge_key)
        return badge.tier if badge else ""

    @admin.action(description="Revoke selected badges")
    def revoke_selected(self, request, queryset):
        done = 0
        try:
            for row in queryset.filter(revoked_at__isnull=True)[:500]:
                services.staff_set_badge(
                    actor=request.user, user_id=row.user_id, badge_key=row.badge_key, award_it=False,
                    reason=ADMIN_REASON, request=request,
                )
                done += 1
        except DomainError as exc:
            self.message_user(request, exc.message, level=messages.ERROR)
            return
        self.message_user(request, f"Revoked {done} badge(s).", level=messages.SUCCESS)


@admin.register(Achievement)
class AchievementAdmin(ReadOnlyAdmin):
    list_display = ("title", "user", "kind", "key", "earned_at", "revoked_at", "slug")
    list_filter = ("kind", ("revoked_at", admin.EmptyFieldListFilter))
    search_fields = ("user__email", "user__full_name", "title", "=slug")
    raw_id_fields = ("user",)
    list_select_related = ("user",)
    actions = ["revoke_selected"]

    def has_change_permission(self, request, obj=None):
        return obj is None and request.user.has_perm("engagement.change_achievement")

    @admin.action(description="Revoke selected achievements (verification shows 'revoked')")
    def revoke_selected(self, request, queryset):
        if not services.is_enabled():
            self.message_user(request, "Engagement is switched off.", level=messages.ERROR)
            return
        from .models import EngagementAuditLog as Log

        now = timezone.now()
        rows = list(queryset.filter(revoked_at__isnull=True)[:500])
        for row in rows:
            Achievement.objects.filter(pk=row.pk).update(revoked_at=now)
            Log.objects.create(
                actor=request.user, actor_email=request.user.email, target_user_id=row.user_id,
                action=Log.ACTION_REVOKE_ACHIEVEMENT, reason=f"{ADMIN_REASON} ({row.slug})",
            )
        self.message_user(request, f"Revoked {len(rows)} achievement(s).", level=messages.SUCCESS)


@admin.register(EngagementSettings)
class EngagementSettingsAdmin(admin.ModelAdmin):
    list_display = ("user", "leaderboard_display", "updated_at")
    list_filter = ("leaderboard_display",)
    search_fields = ("user__email", "user__full_name")
    raw_id_fields = ("user",)
    list_select_related = ("user",)

    def save_model(self, request, obj, form, change):
        services.update_settings(obj.user, leaderboard_display=obj.leaderboard_display)


@admin.register(EngagementAuditLog)
class EngagementAuditLogAdmin(ReadOnlyAdmin):
    list_display = ("created_at", "action", "target_user", "points", "badge_key", "actor_email", "reason")
    list_filter = ("action", ("created_at", admin.DateFieldListFilter))
    search_fields = ("target_user__email", "actor_email", "reason", "badge_key")
    raw_id_fields = ("target_user", "actor", "xp_event")
    list_select_related = ("target_user",)


# --- certificates --------------------------------------------------------------------------------------
class CertificateRevisionInline(admin.TabularInline):
    model = CertificateRevision
    extra = 0
    can_delete = False
    fields = ("created_at", "action", "revision", "name_before", "name_after", "reason", "actor_email")
    readonly_fields = fields
    ordering = ("created_at", "id")

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False


class CertificateNameForm(forms.ModelForm):
    """Only the printed name can be changed, always with a reason (re-issue: same reference, revision + 1)."""

    correction_reason = forms.CharField(
        max_length=300, required=False, label="Reason for the correction",
        help_text="Required when you change the name. Saved in the certificate's audit trail.",
    )

    class Meta:
        model = Certificate
        fields = ["recipient_name"]

    def clean(self):
        data = super().clean()
        if "recipient_name" in self.changed_data:
            try:
                data["recipient_name"] = certificates.validate_name(data.get("recipient_name"))
                data["correction_reason"] = certificates._reason(data.get("correction_reason"))
            except DomainError as exc:
                for field, problems in (exc.details or {}).items():
                    target = "correction_reason" if field == "reason" else field
                    self.add_error(target if target in self.fields else None, problems)
        return data


@admin.register(Certificate)
class CertificateAdmin(admin.ModelAdmin):
    form = CertificateNameForm
    list_display = ("reference", "recipient_name", "cert_type", "title", "issued_at", "revision", "status")
    list_filter = ("cert_type", ("revoked_at", admin.EmptyFieldListFilter))
    search_fields = ("=reference", "recipient_name", "user__email", "title")
    list_select_related = ("achievement",)
    show_full_result_count = False
    inlines = [CertificateRevisionInline]
    actions = ["revoke_selected", "reinstate_selected"]
    readonly_fields = (
        "reference", "status", "public_page", "cert_type", "user", "heading", "statement", "title", "programme",
        "issued_at", "revision", "revoked_at", "revoked_reason", "achievement",
    )
    fieldsets = (
        ("Certificate", {"fields": ("reference", "status", "public_page", "cert_type", "issued_at", "revision")}),
        ("Printed name (correct it here)", {"fields": ("recipient_name", "correction_reason")}),
        ("Wording (snapshot)", {"fields": ("heading", "statement", "title", "programme")}),
        ("Holder and source", {"fields": ("user", "achievement", "revoked_at", "revoked_reason")}),
    )

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.display(description="Status")
    def status(self, obj):
        return "Verified" if obj.is_valid else "Revoked"

    @admin.display(description="Public page")
    def public_page(self, obj):
        return certificates.public_url(obj.reference) if obj.reference else ""

    def save_model(self, request, obj, form, change):
        if not change or "recipient_name" not in form.changed_data:
            return
        try:
            certificates.correct_name(
                Certificate.objects.get(pk=obj.pk),
                recipient_name=form.cleaned_data["recipient_name"],
                actor=request.user,
                reason=form.cleaned_data["correction_reason"],
                request=request,
            )
        except DomainError as exc:
            self.message_user(request, exc.message, level=messages.ERROR)

    def save_related(self, request, form, formsets, change):
        return None  # the audit trail is append-only and written by the services

    def _bulk(self, request, queryset, action, verb):
        done = 0
        for row in queryset[:500]:
            try:
                action(row, actor=request.user, reason=f"{verb} from the Django admin.", request=request)
                done += 1
            except DomainError:
                continue
        self.message_user(request, f"{verb} {done} certificate(s).", level=messages.SUCCESS)

    @admin.action(description="Revoke selected certificates (verification shows 'Revoked')")
    def revoke_selected(self, request, queryset):
        self._bulk(request, queryset.filter(revoked_at__isnull=True), certificates.revoke, "Revoked")

    @admin.action(description="Reinstate selected certificates")
    def reinstate_selected(self, request, queryset):
        self._bulk(request, queryset.filter(revoked_at__isnull=False), certificates.reinstate, "Reinstated")


@admin.register(CertificateRevision)
class CertificateRevisionAdmin(ReadOnlyAdmin):
    list_display = ("created_at", "certificate", "action", "revision", "name_before", "name_after", "actor_email", "reason")
    list_filter = ("action", ("created_at", admin.DateFieldListFilter))
    search_fields = ("=certificate__reference", "actor_email", "name_before", "name_after")
    list_select_related = ("certificate",)
    raw_id_fields = ("certificate", "actor")


def _register_nav_groups():
    """Place the screens in the Al Syed Admin sidebar groups without editing apps.users."""
    try:
        from apps.users.templatetags.enterprise_admin import MODEL_JOBS
    except Exception:  # noqa: BLE001
        return
    for key, value in (
        ("engagement.engagementsummary", ("students", "Engagement (XP & levels)")),
        ("engagement.xpevent", ("students", "XP ledger")),
        ("engagement.badgeaward", ("students", "Badges awarded")),
        ("engagement.achievement", ("students", "Achievements & certificates")),
        ("engagement.certificate", ("students", "Certificates (reference numbers)")),
        ("engagement.certificaterevision", ("system", "Certificate audit trail")),
        ("engagement.engagementsettings", ("settings", "Leaderboard privacy")),
        ("engagement.engagementauditlog", ("system", "Engagement audit log")),
        ("engagement.activityday", ("system", "Engagement activity days")),
        ("engagement.liveattendance", ("system", "Live class attendance")),
    ):
        MODEL_JOBS.setdefault(key, value)


_register_nav_groups()
