from django.contrib import admin, messages
from django.db.models import Prefetch, Q
from django.http import Http404
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils.html import format_html

from config.audit import log_security_event

from .credentials import issue_credentials_for_paid_user
from .models import Payment, PaymentWebhookEvent, SuccessfulPaymentUser


@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "internal_reference",
        "user_email_snapshot",
        "course_title_snapshot",
        "status",
        "plan",
        "installment_number",
        "provisioning_status",
        "invoice_number",
        "gateway_status",
        "amount",
        "currency",
        "razorpay_order_id",
        "razorpay_payment_id",
        "payment_method",
        "buyer_name",
        "whatsapp_number",
        "paid_at",
        "created_at",
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
    actions = ("generate_login_credentials",)
    readonly_fields = (
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

    @admin.action(description="Generate/reset credentials for selected paid buyers")
    def generate_login_credentials(self, request, queryset):
        selected = list(queryset.select_related("user").filter(status=Payment.STATUS_PAID))
        if len(selected) != 1:
            self.message_user(
                request,
                "Select exactly one paid record so its temporary password can be shown safely.",
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
            f"Credentials generated. Username: {payment.user.email} | Temporary password: {password}",
            level=messages.SUCCESS,
        )


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
            Q(email__istartswith="adl-", email__iendswith="@adlfront.com")
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
                )
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

    @admin.display(description="Credential status")
    def credential_status(self, obj):
        return "Password issued" if obj.has_usable_password() else "Awaiting password"

    @admin.display(description="Credentials issued at")
    def credentials_issued_at_display(self, obj):
        payment = self._latest_payment(obj)
        return payment.credentials_issued_at if payment else None

    def _credential_url(self, obj):
        info = self.model._meta.app_label, self.model._meta.model_name
        return reverse(f"admin:{info[0]}_{info[1]}_generate_credentials", args=[obj.pk])

    @admin.display(description="Password")
    def credential_action(self, obj):
        label = "Reset password" if obj.has_usable_password() else "Generate password"
        return format_html('<a class="button" href="{}">{}</a>', self._credential_url(obj), label)

    def get_urls(self):
        info = self.model._meta.app_label, self.model._meta.model_name
        custom_urls = [
            path(
                "<path:object_id>/generate-credentials/",
                self.admin_site.admin_view(self.generate_credentials_view),
                name=f"{info[0]}_{info[1]}_generate_credentials",
            )
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
        if request.method == "POST":
            payment, generated_password = issue_credentials_for_paid_user(user_id=target_user.pk)
            target_user.refresh_from_db()
            log_security_event(
                "admin.payment_credentials_issued",
                request=request,
                target_user_id=target_user.id,
                payment_id=payment.id,
            )
            self.log_change(
                request,
                target_user,
                f"Generated or reset login credentials from paid payment {payment.id}.",
            )

        context = {
            **self.admin_site.each_context(request),
            "opts": self.model._meta,
            "original": target_user,
            "title": f"Generate credentials for {target_user.email}",
            "target_user": target_user,
            "payment": payment,
            "generated_password": generated_password,
            "credential_url": self._credential_url(target_user),
            "changelist_url": reverse(
                f"admin:{self.model._meta.app_label}_{self.model._meta.model_name}_changelist"
            ),
        }
        return TemplateResponse(
            request,
            "admin/payments/successfulpaymentuser/generate_credentials.html",
            context,
        )


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
