from __future__ import annotations

from django.contrib import admin, messages

from apps.core.errors import DomainError
from apps.users.identity_admin import IDENTITY_LIST_DISPLAY, StudentIdentityAdminMixin

from . import hall_of_fame, services
from .grading import AnswerKeyMismatch
from .models import (
    CertificateDelivery,
    CertificationAudit,
    CertificationDecision,
    CertificationPreferences,
    ExamCertificationPolicy,
    HallOfFameAudit,
    HallOfFameEntry,
)


def _run(modeladmin, request, queryset, func, done: str):
    ok = 0
    for obj in queryset:
        try:
            func(obj)
            ok += 1
        except (DomainError, AnswerKeyMismatch) as exc:
            modeladmin.message_user(request, f"{obj}: {getattr(exc, 'message', None) or exc}", level=messages.WARNING)
    if ok:
        modeladmin.message_user(request, f"{done}: {ok}.", level=messages.SUCCESS)


@admin.register(ExamCertificationPolicy)
class ExamCertificationPolicyAdmin(admin.ModelAdmin):
    list_display = ("exam", "is_enabled", "pass_mark_percent", "certificate_type", "auto_hall_of_fame", "auto_deliver", "updated_at")
    list_filter = ("is_enabled", "certificate_type")
    search_fields = ("exam__slug", "exam__title")
    autocomplete_fields = ()
    raw_id_fields = ("exam",)
    readonly_fields = ("created_at", "updated_at", "updated_by")
    actions = ["regrade_now"]

    def save_model(self, request, obj, form, change):
        obj.updated_by = request.user
        super().save_model(request, obj, form, change)

    @admin.action(description="Re-grade now (re-check every answer against the current answer key)")
    def regrade_now(self, request, queryset):
        def run(policy):
            stats = services.regrade_exam(policy.exam, actor=request.user, reason="Re-graded from admin")
            self.message_user(request, f"{policy.exam.slug}: {stats}")

        _run(self, request, queryset, run, "Exams re-graded")


class CertificateDeliveryInline(admin.TabularInline):
    model = CertificateDelivery
    extra = 0
    can_delete = False
    fields = ("channel", "status", "skip_reason", "round", "attempts", "destination_hint", "provider_message_id", "sent_at", "last_error")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False


class CertificationAuditInline(admin.TabularInline):
    model = CertificationAudit
    extra = 0
    can_delete = False
    fields = ("created_at", "action", "outcome_before", "outcome_after", "percent_before", "percent_after", "reason", "actor_email")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(CertificationDecision)
class CertificationDecisionAdmin(StudentIdentityAdminMixin, admin.ModelAdmin):
    # Admin -> Examination: roll number, real name, handle, stats first (owner rule).
    identity_record_attr = "participation"
    list_display = (
        *IDENTITY_LIST_DISPLAY,
        "student_email",
        "exam",
        "outcome",
        "score",
        "total_points",
        "percent",
        "band",
        "review_state",
        "certificate",
        "decided_at",
    )
    list_filter = ("outcome", "review_state", "band", "exam")
    list_select_related = ("user", "exam", "participation", "certificate")
    # Roll numbers (AL-SYD-00042) are matched by StudentIdentityAdminMixin.
    search_fields = (
        "user__email",
        "user__full_name",
        "user__student_profile__handle",
        "exam__slug",
        "certificate__reference",
    )
    readonly_fields = [field.name for field in CertificationDecision._meta.fields]
    inlines = [CertificateDeliveryInline, CertificationAuditInline]
    actions = ["confirm_revocation", "dismiss_revocation"]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.display(description="Email", ordering="user__email")
    def student_email(self, obj):
        return obj.user.email

    @admin.action(description="Confirm revocation (re-grade fails): revoke the certificate")
    def confirm_revocation(self, request, queryset):
        _run(self, request, queryset, lambda d: services.confirm_revocation(
            d, actor=request.user, reason="Confirmed in admin after re-grade", request=request), "Revocations confirmed")

    @admin.action(description="Dismiss revocation (keep the pass)")
    def dismiss_revocation(self, request, queryset):
        _run(self, request, queryset, lambda d: services.dismiss_revocation(
            d, actor=request.user, reason="Dismissed in admin after re-grade"), "Revocations dismissed")


@admin.register(CertificateDelivery)
class CertificateDeliveryAdmin(admin.ModelAdmin):
    list_display = ("idempotency_key", "channel", "status", "skip_reason", "round", "attempts", "sent_at", "queued_at")
    list_filter = ("channel", "status", "skip_reason")
    search_fields = ("idempotency_key", "user__email", "provider_message_id")
    readonly_fields = [field.name for field in CertificateDelivery._meta.fields]
    actions = ["resend"]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.action(description="Resend (new round; consent is checked again)")
    def resend(self, request, queryset):
        _run(self, request, queryset, lambda d: services.resend(d, actor=request.user, reason="Resent from admin"), "Queued again")


@admin.register(CertificationPreferences)
class CertificationPreferencesAdmin(admin.ModelAdmin):
    list_display = ("user", "delivery_channel", "whatsapp_opt_out", "hall_of_fame_listed", "updated_at")
    list_filter = ("delivery_channel", "whatsapp_opt_out", "hall_of_fame_listed")
    search_fields = ("user__email",)
    raw_id_fields = ("user",)


class HallOfFameAuditInline(admin.TabularInline):
    model = HallOfFameAudit
    extra = 0
    can_delete = False
    fields = ("created_at", "action", "reason", "actor_email")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False


class AwaitingHandleFilter(admin.SimpleListFilter):
    """Graduates hidden from the wall until they choose their own handle (only the automatic one so far)."""

    title = "public handle"
    parameter_name = "handle_state"

    def lookups(self, request, model_admin):
        return [("awaiting", "Waiting for the student to choose a handle"), ("public", "Shown on the wall")]

    def queryset(self, request, queryset):
        if self.value() == "awaiting":
            return queryset.filter(pk__in=hall_of_fame.awaiting_handle_queryset().values("pk"))
        if self.value() == "public":
            return queryset.filter(pk__in=hall_of_fame.public_queryset().values("pk"))
        return queryset


@admin.register(HallOfFameEntry)
class HallOfFameEntryAdmin(admin.ModelAdmin):
    list_display = ("__str__", "public_handle_shown", "legacy_name", "user", "batch_label", "achievement", "achieved_on",
                    "source", "is_hidden")
    list_filter = (AwaitingHandleFilter, "source", "is_hidden", "batch_label")
    search_fields = ("display_handle", "legacy_name", "user__email", "certificate__reference")
    raw_id_fields = ("user", "certificate", "decision", "hidden_by")
    readonly_fields = ("source", "seed_key", "percent", "hidden_at", "hidden_by", "created_at", "updated_at")
    inlines = [HallOfFameAuditInline]
    actions = ["hide", "restore", "use_curated_name_as_handle", "list_awaiting_handle"]

    @admin.display(description="Public handle")
    def public_handle_shown(self, obj):
        row = hall_of_fame._annotated(HallOfFameEntry.objects.filter(pk=obj.pk)).first()  # noqa: SLF001
        if row and row.public_handle:
            return row.public_handle
        if obj.user_id:
            return "— (not public until the student chooses a handle)"
        return "— (not public until mapped)"

    def save_model(self, request, obj, form, change):
        if obj.display_handle:
            obj.display_handle = hall_of_fame.validate_handle(obj.display_handle)
        super().save_model(request, obj, form, change)
        if change and "display_handle" in form.changed_data:
            hall_of_fame._audit(obj, HallOfFameAudit.ACTION_HANDLE_SET, actor=request.user,  # noqa: SLF001
                                reason=f"Handle set in admin: {obj.display_handle or '(cleared)'}")

    @admin.action(description="Hide from the public Hall of Fame")
    def hide(self, request, queryset):
        _run(self, request, queryset.filter(is_hidden=False),
             lambda e: hall_of_fame.set_hidden(e, hidden=True, actor=request.user, reason="Hidden by staff in admin"), "Hidden")

    @admin.action(description="Restore to the public Hall of Fame")
    def restore(self, request, queryset):
        _run(self, request, queryset.filter(is_hidden=True),
             lambda e: hall_of_fame.set_hidden(e, hidden=False, actor=request.user, reason="Restored by staff in admin"), "Restored")

    @admin.action(description="List graduates waiting to choose a handle (not shown on the wall yet)")
    def list_awaiting_handle(self, request, queryset):
        rows = list(hall_of_fame.awaiting_handle_queryset().filter(pk__in=queryset.values("pk"))[:200])
        if not rows:
            self.message_user(request, "Every selected graduate already has a chosen handle (or is hidden/opted out).",
                              level=messages.SUCCESS)
            return
        emails = ", ".join(sorted({row.user.email for row in rows if row.user_id and row.user.email}))
        self.message_user(
            request,
            f"{len(rows)} graduate(s) are not on the wall until they choose a handle on their profile: {emails}",
            level=messages.WARNING,
        )

    @admin.action(description="Use the curated name as the public display handle (only if it is a handle, not a real name)")
    def use_curated_name_as_handle(self, request, queryset):
        _run(self, request, queryset.exclude(legacy_name=""),
             lambda e: hall_of_fame.set_display_handle(e, handle=e.legacy_name, actor=request.user,
                                                       reason="Curated name confirmed as a public handle in admin"),
             "Handles set")


@admin.register(HallOfFameAudit)
class HallOfFameAuditAdmin(admin.ModelAdmin):
    list_display = ("created_at", "entry", "action", "reason", "actor_email")
    list_filter = ("action",)
    readonly_fields = [field.name for field in HallOfFameAudit._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False


def _register_nav_groups():
    """Place the certification screens in the Al Syed Admin sidebar groups."""
    try:
        from apps.users.templatetags.enterprise_admin import MODEL_JOBS
    except Exception:  # noqa: BLE001
        return
    for key, value in (
        ("certification.examcertificationpolicy", ("examination", "Certification policies")),
        ("certification.certificationdecision", ("examination", "Certification decisions")),
        ("certification.certificatedelivery", ("students", "Certificate deliveries")),
        ("certification.certificationpreferences", ("settings", "Certification preferences")),
        ("certification.halloffameentry", ("community", "Hall of Fame")),
        ("certification.halloffameaudit", ("system", "Hall of Fame audit log")),
    ):
        MODEL_JOBS.setdefault(key, value)


_register_nav_groups()
