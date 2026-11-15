"""Billing admin: Products (+ prices), Prices, Plans (+ features, entitlements),
Entitlement keys, Purchases (read-only) and Entitlement grants (grant / revoke).

Nothing here caches an amount: a saved price applies on the very next checkout.
"""

from config.audit import log_security_event
from django.contrib import admin, messages
from django.utils import timezone
from django.utils.html import format_html

from . import services
from .models import EntitlementGrant, EntitlementKey, Plan, PlanEntitlement, PlanFeature, Price, Product, Purchase
from .registry import BUILTIN_KEYS


def _price_state(price):
    if price.superseded_by_id:
        return format_html('<span style="color:#6f6f6f">Archived v{}</span>', price.version)
    if price.is_available():
        return format_html('<strong style="color:#198038">&#9679; ACTIVE</strong> v{}', price.version)
    if price.is_active:
        return format_html('<span style="color:#8a3800">Scheduled / outside window</span>')
    return format_html('<span style="color:#6f6f6f">Inactive</span>')


class PriceInline(admin.TabularInline):
    model = Price
    extra = 0
    fields = ("state", "label", "amount", "currency", "billing_type", "interval", "interval_count", "access_days",
              "is_active", "valid_from", "valid_to", "sort_order", "is_highlighted")
    readonly_fields = ("state",)
    show_change_link = True
    ordering = ("superseded_by", "sort_order", "-version")

    @admin.display(description="State")
    def state(self, obj):
        return _price_state(obj) if obj.pk else "-"


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    list_display = ("name", "key", "is_active", "active_prices", "plan_count", "sort_order")
    list_editable = ("is_active", "sort_order")
    search_fields = ("name", "key")
    prepopulated_fields = {"key": ("name",)}
    inlines = [PriceInline]

    @admin.display(description="Active prices")
    def active_prices(self, obj):
        prices = [p for p in obj.prices.all() if p.is_available()]
        return ", ".join(f"{p.currency} {p.amount} ({p.describe_period()})" for p in prices) or "-"

    @admin.display(description="Plans")
    def plan_count(self, obj):
        return obj.plans.count()


@admin.register(Price)
class PriceAdmin(admin.ModelAdmin):
    list_display = ("__str__", "state", "amount", "billing_type", "access_days", "version", "is_active",
                    "is_highlighted", "sort_order")
    list_filter = ("billing_type", "is_active", "product")
    list_editable = ("amount", "is_active", "is_highlighted", "sort_order")
    readonly_fields = ("version", "superseded_by", "created_at", "updated_at")
    search_fields = ("product__name", "product__key", "label")

    @admin.display(description="State")
    def state(self, obj):
        return _price_state(obj)


class PlanFeatureInline(admin.TabularInline):
    model = PlanFeature
    extra = 1
    fields = ("text", "is_highlighted", "sort_order")


class PlanEntitlementInline(admin.TabularInline):
    model = PlanEntitlement
    extra = 1
    fields = ("key",)
    verbose_name = "Entitlement key"
    verbose_name_plural = "Entitlement keys (what this plan unlocks)"

    def get_formset(self, request, obj=None, **kwargs):
        formset = super().get_formset(request, obj, **kwargs)
        builtin = ", ".join(f"{spec.key}{':<id>' if spec.takes_argument else ''}" for spec in BUILTIN_KEYS.values())
        extra = ", ".join(str(row) for row in EntitlementKey.objects.filter(is_active=True))
        formset.form.base_fields["key"].help_text = f"Known keys: {builtin}{', ' + extra if extra else ''}."
        return formset


@admin.register(Plan)
class PlanAdmin(admin.ModelAdmin):
    list_display = ("name", "key", "product", "price_label", "is_active", "is_highlighted", "sort_order", "keys")
    list_editable = ("is_active", "is_highlighted", "sort_order")
    list_filter = ("is_active", "is_highlighted", "product", "price__billing_type")
    search_fields = ("name", "key", "product__name")
    prepopulated_fields = {"key": ("name",)}
    autocomplete_fields = ("product",)
    inlines = [PlanFeatureInline, PlanEntitlementInline]
    fields = ("product", "price", "name", "key", "description", "badge", "is_active", "is_highlighted", "sort_order")

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("product", "price").prefetch_related("entitlements")

    def formfield_for_foreignkey(self, db_field, request, **kwargs):
        if db_field.name == "price":
            kwargs["queryset"] = Price.objects.filter(superseded_by__isnull=True).select_related("product")
        return super().formfield_for_foreignkey(db_field, request, **kwargs)

    @admin.display(description="Price")
    def price_label(self, obj):
        return f"{obj.price.currency} {obj.price.amount} ({obj.price.describe_period()})"

    @admin.display(description="Unlocks")
    def keys(self, obj):
        return ", ".join(obj.entitlement_keys())


@admin.register(EntitlementKey)
class EntitlementKeyAdmin(admin.ModelAdmin):
    list_display = ("key", "label", "takes_argument", "is_active")
    list_editable = ("is_active",)
    search_fields = ("key", "label")


class GrantInline(admin.TabularInline):
    model = EntitlementGrant
    extra = 0
    can_delete = False
    fields = ("key", "starts_at", "ends_at", "revoked_at", "revoke_reason")
    readonly_fields = fields

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(Purchase)
class PurchaseAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "plan_name", "amount", "currency", "billing_type", "status", "period_start",
                    "period_end", "paid_at", "provider_order_id")
    list_filter = ("status", "billing_type", "plan__product")
    search_fields = ("user__email", "provider_order_id", "provider_payment_id", "reference")
    date_hierarchy = "created_at"
    inlines = [GrantInline]
    actions = ["mark_refunded"]

    def get_readonly_fields(self, request, obj=None):
        return [field.name for field in self.model._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.display(description="Plan")
    def plan_name(self, obj):
        return obj.plan_snapshot.get("name") or obj.plan_id

    @admin.action(description="Mark refunded (full) and revoke access")
    def mark_refunded(self, request, queryset):
        if not request.user.has_perm("billing.change_purchase"):
            self.message_user(request, "You do not have permission to refund.", messages.ERROR)
            return
        count = 0
        for purchase in queryset.filter(status=Purchase.STATUS_PAID):
            services.on_payment_refunded(purchase, by=request.user, reason=f"Refunded by {request.user.email}")
            log_security_event("billing.admin_refund", request=request, purchase_id=purchase.pk)
            count += 1
        self.message_user(request, f"{count} purchase(s) marked refunded; their access was revoked.")


@admin.register(EntitlementGrant)
class EntitlementGrantAdmin(admin.ModelAdmin):
    list_display = ("user", "key", "source", "starts_at", "ends_at", "state", "purchase", "granted_by", "revoked_by")
    list_filter = ("source", "key", ("revoked_at", admin.EmptyFieldListFilter))
    search_fields = ("user__email", "key", "note")
    autocomplete_fields = ("user",)
    actions = ["revoke_selected", "resend_hooks"]
    fields = ("user", "key", "starts_at", "ends_at", "note", "source", "purchase", "granted_by", "revoked_at",
              "revoked_by", "revoke_reason", "created_at")

    def get_readonly_fields(self, request, obj=None):
        audit = ["source", "purchase", "granted_by", "revoked_at", "revoked_by", "revoke_reason", "created_at"]
        if obj is not None:  # a grant is changed only by revoking it (audit trail)
            return ["user", "key", "starts_at", "ends_at", "note", *audit]
        return audit

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.display(description="State")
    def state(self, obj):
        if obj.revoked_at:
            return "Revoked"
        now = timezone.now()
        if obj.starts_at > now:
            return "Scheduled"
        return "Active" if obj.is_active(now) else "Expired"

    def save_model(self, request, obj, form, change):
        if change:
            return
        grant = services.grant_manually(
            obj.user, obj.key, starts_at=obj.starts_at, ends_at=obj.ends_at, by=request.user, note=obj.note
        )
        obj.pk = grant.pk
        obj.id = grant.pk
        log_security_event("billing.admin_grant", request=request, grant_id=grant.pk, key=grant.key)

    @admin.action(description="Revoke selected grants")
    def revoke_selected(self, request, queryset):
        if not request.user.has_perm("billing.change_entitlementgrant"):
            self.message_user(request, "You do not have permission to revoke.", messages.ERROR)
            return
        count = 0
        for grant in queryset.filter(revoked_at__isnull=True):
            count += int(services.revoke_grant(grant, by=request.user, reason=f"Revoked by {request.user.email}"))
            log_security_event("billing.admin_revoke", request=request, grant_id=grant.pk)
        self.message_user(request, f"{count} grant(s) revoked.")

    @admin.action(description="Re-send hooks (repair enrolments)")
    def resend_hooks(self, request, queryset):
        for grant in queryset.select_related("user"):
            services.resend_hooks(grant)
        self.message_user(request, "Hooks re-sent.")
