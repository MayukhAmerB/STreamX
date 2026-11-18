from config.audit import log_security_event
from django.contrib import admin, messages
from django.db import transaction
from django.db.models import Prefetch, Q
from django.http import Http404
from django.shortcuts import redirect
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils import timezone
from django.utils.html import format_html, format_html_join

from .batch_pass import activate_batch_pass, deactivate_batch_pass
from . import credential_delivery
from .credentials import issue_credentials_for_paid_user
from .models import BatchPass, CredentialDelivery, Payment, PaymentWebhookEvent, SuccessfulPaymentUser
from .refunds import record_refund


@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    # What an admin scans first (who, what, how much, where it stands), then the
    # identifiers. Same columns as before; the table scrolls in its own region.
    list_display = (
        "id",
        "user_email_snapshot",
        "course_title_snapshot",
        "amount",
        "status",
        "provisioning_status",
        "plan",
        "installment_number",
        "paid_at",
        "created_at",
        "invoice_number",
        "internal_reference",
        "gateway_status",
        "currency",
        "razorpay_order_id",
        "razorpay_payment_id",
        "payment_method",
        "buyer_name",
        "whatsapp_number",
    )
    search_fields = (
        "user__email",
        "user_email_snapshot",
        "buyer_name",
        "buyer_email",
        "whatsapp_number",
        "alternate_number",
        "course__title",
        "course_title_snapshot",
        "razorpay_order_id",
        "razorpay_payment_id",
        "internal_reference",
    )
    list_filter = (
        "status",
        "plan",
        "provisioning_status",
        "gateway_status",
        "payment_method",
        "currency",
        "country",
        "state",
    )
    actions = ("generate_login_credentials", "mark_refunded_and_revoke_access")
    readonly_fields = (
        "terms_snapshot",
        "application",
        "internal_reference",
        "user",
        "course",
        "user_email_snapshot",
        "course_id_snapshot",
        "course_title_snapshot",
        "razorpay_order_id",
        "razorpay_payment_id",
        "razorpay_signature",
        "amount",
        "currency",
        "status",
        "plan",
        "installment_number",
        "access_expires_at",
        "invoice_number",
        "provisioning_status",
        "credentials_issued_at",
        "buyer_name",
        "buyer_email",
        "whatsapp_number",
        "alternate_number",
        "age",
        "country",
        "state",
        "city",
        "pincode",
        "gateway_status",
        "payment_method",
        "gateway_details",
        "failure_reason",
        "last_webhook_event",
        "paid_at",
        "amount_refunded",
        "refunded_at",
        "created_at",
        "updated_at",
    )
    fieldsets = (
        (
            "Payment",
            {
                "fields": (
                    "user",
                    "course",
                    "internal_reference",
                    "user_email_snapshot",
                    "course_id_snapshot",
                    "course_title_snapshot",
                    "status",
                    "plan",
                    "terms_snapshot",
                    "application",
                    "installment_number",
                    "access_expires_at",
                    "invoice_number",
                    "provisioning_status",
                    "credentials_issued_at",
                    "amount",
                    "currency",
                    "razorpay_order_id",
                    "razorpay_payment_id",
                    "razorpay_signature",
                )
            },
        ),
        (
            "Gateway audit",
            {
                "fields": (
                    "gateway_status",
                    "payment_method",
                    "last_webhook_event",
                    "gateway_details",
                    "failure_reason",
                    "paid_at",
                    "amount_refunded",
                    "refunded_at",
                )
            },
        ),
        (
            "Buyer details captured at checkout",
            {
                "fields": (
                    "buyer_name",
                    "buyer_email",
                    "whatsapp_number",
                    "alternate_number",
                    "age",
                    "country",
                    "state",
                    "city",
                    "pincode",
                )
            },
        ),
        ("Audit timestamps", {"fields": ("created_at", "updated_at")}),
    )
    date_hierarchy = "created_at"

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_actions(self, request):
        actions = super().get_actions(request)
        if not request.user.is_superuser:
            actions.pop("mark_refunded_and_revoke_access", None)
        return actions

    @admin.action(description="Mark refunded and revoke access")
    def mark_refunded_and_revoke_access(self, request, queryset):
        """For refunds issued manually in the Razorpay dashboard."""
        if not request.user.is_superuser:
            self.message_user(request, "Only superusers can mark payments refunded.", level=messages.ERROR)
            return
        refunded = 0
        for payment in queryset.filter(status=Payment.STATUS_PAID):
            outcome = record_refund(payment, amount_refunded=payment.amount, full=True)
            if not outcome.newly_refunded:
                continue
            refunded += 1
            log_security_event(
                "admin.payment_marked_refunded",
                request=request,
                payment_id=payment.id,
                course_id=payment.course_id,
                target_user_id=payment.user_id,
                plan=payment.plan,
                **outcome.access,
            )
            self.log_change(
                request,
                outcome.payment,
                "Marked refunded; revoked {revoked} and reduced {reduced} enrollment(s).".format(**outcome.access),
            )
        skipped = queryset.count() - refunded
        self.message_user(
            request,
            f"{refunded} payment(s) marked refunded and access revoked. {skipped} skipped (not paid or already refunded).",
            level=messages.SUCCESS if refunded else messages.WARNING,
        )

    @admin.action(description="Generate/reset credentials for selected paid buyers")
    def generate_login_credentials(self, request, queryset):
        selected = list(queryset.select_related("user").filter(status=Payment.STATUS_PAID))
        if len(selected) != 1:
            self.message_user(
                request,
                "Select exactly one paid record so its account password can be shown safely.",
                level=messages.ERROR,
            )
            return
        payment = selected[0]
        if not payment.user_id:
            self.message_user(request, "This payment has no provisioned user.", level=messages.ERROR)
            return
        payment, password = issue_credentials_for_paid_user(user_id=payment.user_id)
        log_security_event(
            "admin.payment_credentials_issued",
            request=request,
            target_user_id=payment.user_id,
            payment_id=payment.id,
        )
        self.log_change(request, payment, "Generated or reset paid-user login credentials.")
        self.message_user(
            request,
            f"Credentials generated. Username: {payment.user.email} | Account password: {password}",
            level=messages.SUCCESS,
        )


def _no_store(response):
    """Pages that show a plaintext password must never be cached."""
    response["Cache-Control"] = "no-store, private"
    response["Pragma"] = "no-cache"
    return response


class CredentialStateFilter(admin.SimpleListFilter):
    title = "credentials"
    parameter_name = "credentials"

    def lookups(self, request, model_admin):
        return (
            ("awaiting", "Awaiting password"),
            ("not_sent", "Password issued, not sent"),
            ("sent", "Sent to buyer"),
        )

    def queryset(self, request, queryset):
        value = self.value()
        if not value:
            return queryset
        # Django marks unusable passwords with a leading "!".
        unusable = Q(password__startswith="!") | Q(password="")
        if value == "awaiting":
            return queryset.filter(unusable)
        sent_ids = CredentialDelivery.objects.filter(status=CredentialDelivery.STATUS_SENT).values("user_id")
        issued = queryset.exclude(unusable)
        if value == "sent":
            return issued.filter(pk__in=sent_ids)
        return issued.exclude(pk__in=sent_ids)


@admin.register(SuccessfulPaymentUser)
class SuccessfulPaymentUserAdmin(admin.ModelAdmin):
    list_display = (
        "generated_username",
        "full_name",
        "customer_email",
        "phone_number_from_payment",
        "payment_id",
        "invoice_id",
        "course_name",
        "credential_status",
        "credential_action",
    )
    list_filter = (CredentialStateFilter,)
    actions = ("generate_and_send_credentials",)
    list_display_links = ("generated_username",)
    search_fields = (
        "email",
        "full_name",
        "phone_number",
        "payments__buyer_email",
        "payments__whatsapp_number",
        "payments__razorpay_payment_id",
        "payments__invoice_number",
        "payments__course_title_snapshot",
    )
    ordering = ("-created_at", "-id")
    fields = (
        "generated_username",
        "full_name",
        "customer_email",
        "phone_number_from_payment",
        "alternate_phone_number",
        "payment_id",
        "invoice_id",
        "course_name",
        "payment_plan",
        "amount_paid",
        "paid_at_display",
        "credential_status",
        "credentials_issued_at_display",
        "delivery_history",
        "credential_action",
    )
    readonly_fields = fields

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_queryset(self, request):
        successful_payments = Payment.objects.filter(status=Payment.STATUS_PAID).order_by(
            "-paid_at", "-created_at", "-id"
        )
        generated_username = (
            Q(email__istartswith="adl", email__iendswith="@adlfront.com")
            | Q(email__istartswith="adl", email__iendswith="@alsyedinitiative.com")
        )
        return (
            super()
            .get_queryset(request)
            .filter(payments__status=Payment.STATUS_PAID)
            .filter(generated_username)
            .distinct()
            .prefetch_related(
                Prefetch(
                    "payments",
                    queryset=successful_payments,
                    to_attr="_successful_payment_records",
                ),
                Prefetch(
                    "credential_deliveries",
                    queryset=CredentialDelivery.objects.order_by("-created_at", "-id"),
                    to_attr="_credential_delivery_records",
                ),
            )
        )

    @staticmethod
    def _latest_payment(obj):
        prefetched = getattr(obj, "_successful_payment_records", None)
        if prefetched is not None:
            return prefetched[0] if prefetched else None
        return (
            obj.payments.filter(status=Payment.STATUS_PAID)
            .order_by("-paid_at", "-created_at", "-id")
            .first()
        )

    @admin.display(description="Generated username", ordering="email")
    def generated_username(self, obj):
        return obj.email

    @admin.display(description="Customer email")
    def customer_email(self, obj):
        payment = self._latest_payment(obj)
        return payment.buyer_email if payment else ""

    @admin.display(description="WhatsApp / phone")
    def phone_number_from_payment(self, obj):
        payment = self._latest_payment(obj)
        return (payment.whatsapp_number if payment else "") or obj.phone_number

    @admin.display(description="Alternate phone")
    def alternate_phone_number(self, obj):
        payment = self._latest_payment(obj)
        return payment.alternate_number if payment else ""

    @admin.display(description="Payment ID")
    def payment_id(self, obj):
        payment = self._latest_payment(obj)
        return payment.razorpay_payment_id if payment else ""

    @admin.display(description="Invoice ID")
    def invoice_id(self, obj):
        payment = self._latest_payment(obj)
        return payment.invoice_number if payment else ""

    @admin.display(description="Course")
    def course_name(self, obj):
        payment = self._latest_payment(obj)
        return payment.course_title_snapshot if payment else ""

    @admin.display(description="Plan")
    def payment_plan(self, obj):
        payment = self._latest_payment(obj)
        return payment.get_plan_display() if payment else ""

    @admin.display(description="Amount")
    def amount_paid(self, obj):
        payment = self._latest_payment(obj)
        return f"{payment.currency} {payment.amount}" if payment else ""

    @admin.display(description="Paid at")
    def paid_at_display(self, obj):
        payment = self._latest_payment(obj)
        return payment.paid_at if payment else None

    @staticmethod
    def _deliveries(obj):
        prefetched = getattr(obj, "_credential_delivery_records", None)
        if prefetched is not None:
            return prefetched
        return list(obj.credential_deliveries.order_by("-created_at", "-id"))

    def _sent_since_issue(self, obj):
        payment = self._latest_payment(obj)
        issued_at = payment.credentials_issued_at if payment else None
        return [
            item
            for item in self._deliveries(obj)
            if item.status == CredentialDelivery.STATUS_SENT and (issued_at is None or item.created_at >= issued_at)
        ]

    @admin.display(description="Credential status")
    def credential_status(self, obj):
        if not obj.has_usable_password():
            latest = next(iter(self._deliveries(obj)), None)
            if latest is not None and latest.status == CredentialDelivery.STATUS_FAILED:
                return "Awaiting password - last send failed"
            return "Awaiting password"
        sent = self._sent_since_issue(obj)
        if sent:
            channels = sorted({item.get_channel_display() for item in sent})
            return f"Sent ({' + '.join(channels)})"
        latest = next(iter(self._deliveries(obj)), None)
        if latest is not None and latest.status == CredentialDelivery.STATUS_FAILED:
            return "Issued - send failed"
        return "Issued - not sent"

    @admin.display(description="Delivery history")
    def delivery_history(self, obj):
        rows = self._deliveries(obj)[:10]
        if not rows:
            return "-"
        return format_html_join(
            format_html("<br>"),
            "{} - {} {}{}{}{}",
            (
                (
                    f"{timezone.localtime(item.created_at):%d %b %Y %H:%M}",
                    item.get_channel_display(),
                    item.get_status_display().lower(),
                    f" to {item.recipient}" if item.recipient else "",
                    f" by {item.sent_by.email}" if item.sent_by_id else " (automatic)",
                    f" - {item.error}" if item.error else "",
                )
                for item in rows
            ),
        )

    @admin.action(description="Generate and send credentials (email + WhatsApp) to selected buyers")
    def generate_and_send_credentials(self, request, queryset):
        """Buyers still awaiting a password only; a reset (signs devices out) is done per buyer."""
        users = list(queryset.order_by("email"))
        pending = [user for user in users if not user.has_usable_password()]
        skipped = [user for user in users if user.has_usable_password()]
        results, errors = [], []
        for user in pending:
            try:
                results.append(credential_delivery.issue_and_send(user=user, actor=request.user, request=request))
            except ValueError as exc:
                errors.append((user, str(exc)))
                continue
            self.log_change(request, user, "Generated login credentials and sent them to the buyer.")
        info = self.model._meta.app_label, self.model._meta.model_name
        context = {
            **self.admin_site.each_context(request),
            "opts": self.model._meta,
            "title": "Credentials generated and sent",
            "results": [
                {"result": item, "mark_url": reverse(f"admin:{info[0]}_{info[1]}_mark_whatsapp", args=[item.user.pk])}
                for item in results
            ],
            "skipped": skipped,
            "errors": errors,
            "changelist_url": reverse(f"admin:{info[0]}_{info[1]}_changelist"),
        }
        return _no_store(
            TemplateResponse(request, "admin/payments/successfulpaymentuser/credentials_results.html", context)
        )

    @admin.display(description="Credentials issued at")
    def credentials_issued_at_display(self, obj):
        payment = self._latest_payment(obj)
        return payment.credentials_issued_at if payment else None

    def _credential_url(self, obj):
        info = self.model._meta.app_label, self.model._meta.model_name
        return reverse(f"admin:{info[0]}_{info[1]}_generate_credentials", args=[obj.pk])

    @admin.display(description="Password")
    def credential_action(self, obj):
        label = "Reset and resend" if obj.has_usable_password() else "Generate and send"
        return format_html('<a class="button" href="{}">{}</a>', self._credential_url(obj), label)

    def get_urls(self):
        info = self.model._meta.app_label, self.model._meta.model_name
        custom_urls = [
            path(
                "<path:object_id>/generate-credentials/",
                self.admin_site.admin_view(self.generate_credentials_view),
                name=f"{info[0]}_{info[1]}_generate_credentials",
            ),
            path(
                "<path:object_id>/mark-whatsapp-sent/",
                self.admin_site.admin_view(self.mark_whatsapp_sent_view),
                name=f"{info[0]}_{info[1]}_mark_whatsapp",
            ),
        ]
        return custom_urls + super().get_urls()

    def generate_credentials_view(self, request, object_id):
        target_user = self.get_object(request, object_id)
        if target_user is None:
            raise Http404("Successful payment user does not exist.")
        if not self.has_change_permission(request, target_user):
            raise Http404("Successful payment user does not exist.")

        payment = self._latest_payment(target_user)
        if payment is None:
            raise Http404("No successful payment exists for this user.")

        generated_password = None
        result = None
        if request.method == "POST":
            send = request.POST.get("send", "1") not in ("0", "off", "false")
            result = credential_delivery.issue_and_send(
                user=target_user, actor=request.user, send_email=send, send_whatsapp=send, request=request
            )
            payment, generated_password = result.payment, result.password
            target_user.refresh_from_db()
            self.log_change(
                request,
                target_user,
                f"Generated or reset login credentials from paid payment {payment.id}"
                + (f"; email {result.email.status}" if result.email else "; not emailed")
                + (f"; WhatsApp {result.whatsapp.status}." if result.whatsapp else "; WhatsApp manual."),
            )

        context = {
            **self.admin_site.each_context(request),
            "opts": self.model._meta,
            "original": target_user,
            "title": f"Generate credentials for {target_user.email}",
            "target_user": target_user,
            "payment": payment,
            "generated_password": generated_password,
            "result": result,
            "deliveries": self._deliveries(target_user)[:10],
            "whatsapp_mark_url": reverse(
                f"admin:{self.model._meta.app_label}_{self.model._meta.model_name}_mark_whatsapp",
                args=[target_user.pk],
            ),
            "credential_url": self._credential_url(target_user),
            "changelist_url": reverse(
                f"admin:{self.model._meta.app_label}_{self.model._meta.model_name}_changelist"
            ),
        }
        return _no_store(
            TemplateResponse(
                request,
                "admin/payments/successfulpaymentuser/generate_credentials.html",
                context,
            )
        )

    def mark_whatsapp_sent_view(self, request, object_id):
        target_user = self.get_object(request, object_id)
        if target_user is None or not self.has_change_permission(request, target_user):
            raise Http404("Successful payment user does not exist.")
        if request.method != "POST":
            return redirect(self._credential_url(target_user))
        credential_delivery.record_whatsapp_sent(user=target_user, actor=request.user, request=request)
        self.log_change(request, target_user, "Marked login credentials as sent on WhatsApp.")
        self.message_user(request, f"Recorded: login for {target_user.email} sent on WhatsApp.", messages.SUCCESS)
        return redirect(reverse(f"admin:{self.model._meta.app_label}_{self.model._meta.model_name}_changelist"))


@admin.register(PaymentWebhookEvent)
class PaymentWebhookEventAdmin(admin.ModelAdmin):
    list_display = (
        "event_id",
        "event_type",
        "status",
        "payment",
        "received_at",
        "processed_at",
    )
    search_fields = (
        "event_id",
        "event_type",
        "payload_hash",
        "payment__razorpay_order_id",
        "payment__razorpay_payment_id",
    )
    list_filter = ("status", "event_type", "received_at")
    readonly_fields = (
        "event_id",
        "event_type",
        "payload_hash",
        "payment",
        "status",
        "processing_note",
        "received_at",
        "processed_at",
    )

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(BatchPass)
class BatchPassAdmin(admin.ModelAdmin):
    list_display = ("user", "source_course", "is_active", "granted_at", "payment")
    list_filter = ("is_active",)
    search_fields = ("user__email", "user__full_name", "payment__invoice_number")
    readonly_fields = ("user", "payment", "source_course", "granted_at")
    fields = ("user", "payment", "source_course", "is_active", "granted_at")

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @transaction.atomic
    def save_model(self, request, obj, form, change):
        was_active = BatchPass.objects.filter(pk=obj.pk, is_active=True).exists()
        super().save_model(request, obj, form, change)
        if was_active and not obj.is_active:
            result = deactivate_batch_pass(obj)
            event = "admin.batch_pass_deactivated"
        elif obj.is_active and not was_active and obj.payment.status == Payment.STATUS_PAID:
            activate_batch_pass(obj.payment)
            result = {}
            event = "admin.batch_pass_reactivated"
        else:
            return
        log_security_event(
            event,
            request=request,
            batch_pass_id=obj.pk,
            payment_id=obj.payment_id,
            target_user_id=obj.user_id,
            **result,
        )


# ---------------------------------------------------------------------------
# Platform plans, grants, subscriptions, membership bundles (WS catalog-plans)
# ---------------------------------------------------------------------------
from django.contrib.admin.models import CHANGE, LogEntry  # noqa: E402
from django.contrib.contenttypes.models import ContentType  # noqa: E402
from django.core.exceptions import ValidationError  # noqa: E402

from .models import MembershipBundle, PlatformGrant, PlatformPlan, PlatformSubscription  # noqa: E402
from .plans import format_inr  # noqa: E402


def _audit(request, obj, message):
    LogEntry.objects.log_action(
        user_id=request.user.pk,
        content_type_id=ContentType.objects.get_for_model(obj).pk,
        object_id=str(obj.pk),
        object_repr=str(obj)[:200],
        action_flag=CHANGE,
        change_message=message,
    )


@admin.register(PlatformPlan)
class PlatformPlanAdmin(admin.ModelAdmin):
    list_display = (
        "title",
        "key",
        "product",
        "price_display",
        "price_status",
        "is_enabled",
        "highlighted",
        "display_order",
    )
    list_filter = ("product", "is_enabled", "billing_period")
    search_fields = ("key", "title")
    filter_horizontal = ("courses",)
    raw_id_fields = ("starter_course",)
    readonly_fields = (
        "kind",
        "catalog_group",
        "confirmed_price",
        "price_confirmed_at",
        "price_confirmed_by",
        "version",
        "created_at",
        "updated_at",
        "enable_checklist",
    )
    actions = ("confirm_price", "disable_plans")
    fieldsets = (
        (
            None,
            {
                "fields": (
                    "key",
                    "product",
                    "kind",
                    "catalog_group",
                    "title",
                    "subtitle",
                    "badge",
                    "cta_label",
                    "highlighted",
                    "display_order",
                )
            },
        ),
        (
            "Price (INR)",
            {
                "description": (
                    "Changing the price or the period un-confirms the plan and switches it off "
                    "until the owner confirms again."
                ),
                "fields": ("price_inr", "billing_period", "confirmed_price", "price_confirmed_at", "price_confirmed_by"),
            },
        ),
        ("Card bullets", {"fields": ("features",)}),
        ("What it unlocks", {"fields": ("courses", "include_future", "starter_course")}),
        ("Selling", {"fields": ("razorpay_plan_id", "is_enabled", "enable_checklist")}),
        ("Record", {"fields": ("version", "created_at", "updated_at")}),
    )

    @admin.display(description="Price")
    def price_display(self, obj):
        period = {"monthly": " / month", "yearly": " / year"}.get(obj.billing_period, " one-time")
        return format_inr(obj.price_inr) + period

    @admin.display(description="Price status")
    def price_status(self, obj):
        return "Confirmed" if obj.price_is_confirmed else "Waiting for confirmation"

    @admin.display(description="Before it can be switched on")
    def enable_checklist(self, obj):
        if not obj or not obj.pk:
            return "-"
        blockers = obj.enable_blockers()
        return "Ready: every requirement is met." if not blockers else " / ".join(blockers)

    @admin.action(description="Confirm price (records who and when; does not switch the plan on)")
    def confirm_price(self, request, queryset):
        from .platform_plans import confirm_price

        done = 0
        for plan in queryset:
            try:
                plan = confirm_price(plan, by=request.user)
            except ValidationError as exc:
                self.message_user(request, f"{plan.title}: {' '.join(exc.messages)}", messages.ERROR)
                continue
            _audit(request, plan, f"Confirmed price {format_inr(plan.price_inr)}")
            log_security_event("admin.platform_plan_price_confirmed", request=request, plan=plan.key)
            done += 1
        if done:
            self.message_user(
                request, f"Confirmed the price of {done} plan(s). Switch them on when ready.", messages.SUCCESS
            )

    @admin.action(description="Switch selected plans off")
    def disable_plans(self, request, queryset):
        for plan in queryset.filter(is_enabled=True):
            plan.is_enabled = False
            plan.save(update_fields=["is_enabled"])
            _audit(request, plan, "Switched off")
        self.message_user(request, "Selected plans are off.", messages.SUCCESS)

    def save_model(self, request, obj, form, change):
        was_confirmed = bool(
            change and PlatformPlan.objects.filter(pk=obj.pk, price_confirmed_at__isnull=False).exists()
        )
        super().save_model(request, obj, form, change)
        if was_confirmed and not obj.price_confirmed_at:
            self.message_user(
                request,
                "The price or period changed: the plan is now unconfirmed and switched off. "
                "Confirm the new price to sell it.",
                messages.WARNING,
            )


@admin.register(PlatformGrant)
class PlatformGrantAdmin(admin.ModelAdmin):
    list_display = ("user", "plan", "is_active", "expires_at", "granted_at", "revoked_at", "payment")
    list_filter = ("is_active", "plan")
    search_fields = ("user__email", "user__full_name", "note")
    raw_id_fields = ("user", "payment")
    readonly_fields = ("granted_at", "revoked_at", "granted_by")
    fields = ("user", "plan", "payment", "is_active", "expires_at", "note", "granted_by", "granted_at", "revoked_at")

    def has_delete_permission(self, request, obj=None):
        return False

    @transaction.atomic
    def save_model(self, request, obj, form, change):
        from .platform_orders import activate_grant, deactivate_grant, grant_scope_lifetime

        was_active = bool(change and PlatformGrant.objects.filter(pk=obj.pk, is_active=True).exists())
        if not change:
            obj.granted_by = request.user
        super().save_model(request, obj, form, change)
        if was_active and not obj.is_active:
            deactivate_grant(obj)
            log_security_event("admin.platform_grant_deactivated", request=request, grant_id=obj.pk)
        elif obj.is_active and not was_active:
            if obj.payment_id:
                activate_grant(obj.payment)
            else:
                grant_scope_lifetime(obj)
            log_security_event("admin.platform_grant_activated", request=request, grant_id=obj.pk)


@admin.register(PlatformSubscription)
class PlatformSubscriptionAdmin(admin.ModelAdmin):
    list_display = (
        "user",
        "plan",
        "status",
        "paid_count",
        "current_end",
        "access_until",
        "cancel_at_cycle_end",
        "updated_at",
    )
    list_filter = ("status", "plan", "cancel_at_cycle_end")
    search_fields = ("user__email", "razorpay_subscription_id")
    actions = ("cancel_now",)

    def get_readonly_fields(self, request, obj=None):
        return [field.name for field in PlatformSubscription._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    @admin.action(description="Cancel immediately at Razorpay (no automatic refund)")
    def cancel_now(self, request, queryset):
        from .subscriptions import SubscriptionError, cancel_subscription

        for sub in queryset:
            try:
                cancel_subscription(sub.user, sub.pk, at_cycle_end=False, request=request)
            except SubscriptionError as exc:
                self.message_user(request, f"{sub}: {exc.message}", messages.ERROR)
                continue
            _audit(request, sub, "Cancelled immediately by an admin")
        self.message_user(request, "Done. Refunds stay manual.", messages.SUCCESS)


@admin.register(MembershipBundle)
class MembershipBundleAdmin(admin.ModelAdmin):
    list_display = ("month", "status", "course_count", "published_at", "note")
    list_filter = ("status",)
    filter_horizontal = ("courses",)
    readonly_fields = ("published_at", "published_by", "preview")
    fields = ("month", "status", "courses", "note", "preview", "published_at", "published_by")
    actions = ("publish", "copy_to_next_month")

    @admin.display(description="Courses")
    def course_count(self, obj):
        return obj.courses.count()

    @admin.display(description="What members can play that month")
    def preview(self, obj):
        if not obj or not obj.pk:
            return "Save first to preview."
        from apps.courses.models import Course

        bundled = list(obj.courses.order_by("title").values_list("title", flat=True))
        always = list(
            Course.objects.filter(membership_always_included=True).order_by("title").values_list("title", flat=True)
        )
        return format_html(
            "<strong>Bundle:</strong> {}<br><strong>Always included:</strong> {}",
            ", ".join(bundled) or "none",
            ", ".join(always) or "none",
        )

    @admin.action(description="Publish selected bundles")
    def publish(self, request, queryset):
        from .platform_plans import publish_bundle

        for bundle in queryset:
            publish_bundle(bundle, by=request.user)
            _audit(request, bundle, "Published")
        self.message_user(request, "Published. Members can play these recordings in that month.", messages.SUCCESS)

    @admin.action(description="Copy into the following month (draft)")
    def copy_to_next_month(self, request, queryset):
        from .platform_plans import copy_previous_bundle

        for bundle in queryset:
            month = bundle.month
            next_month = month.replace(year=month.year + (month.month // 12), month=month.month % 12 + 1)
            copy_previous_bundle(next_month, by=request.user)
        self.message_user(request, "Draft created for the following month. Review and publish it.", messages.SUCCESS)
