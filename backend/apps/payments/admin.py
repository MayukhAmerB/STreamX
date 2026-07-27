import secrets
import string

from django.contrib import admin, messages
from django.utils import timezone

from .models import Payment


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
        letters = [secrets.choice(string.ascii_letters) for _ in range(8)]
        digits = [secrets.choice(string.digits) for _ in range(2)]
        symbols = [secrets.choice("!@#$%^&*") for _ in range(2)]
        characters = letters + digits + symbols
        secrets.SystemRandom().shuffle(characters)
        password = "".join(characters)
        payment.user.set_password(password)
        payment.user.save(update_fields=["password"])
        payment.provisioning_status = Payment.PROVISION_CREDENTIALS_ISSUED
        payment.credentials_issued_at = timezone.now()
        payment.save(update_fields=["provisioning_status", "credentials_issued_at", "updated_at"])
        self.message_user(
            request,
            f"Credentials generated. Username: {payment.user.email} | Temporary password: {password}",
            level=messages.SUCCESS,
        )
