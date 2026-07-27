import uuid

from django.conf import settings
from django.db import models

from apps.courses.models import Course


class Payment(models.Model):
    STATUS_CREATED = "created"
    STATUS_PAID = "paid"
    STATUS_FAILED = "failed"
    STATUS_CHOICES = [
        (STATUS_CREATED, "Created"),
        (STATUS_PAID, "Paid"),
        (STATUS_FAILED, "Failed"),
    ]
    PLAN_FULL = "full"
    PLAN_MONTHLY = "monthly"
    PLAN_CHOICES = [(PLAN_FULL, "Full / lifetime"), (PLAN_MONTHLY, "Monthly installment")]
    PROVISION_PENDING = "pending_payment"
    PROVISION_AWAITING_ADMIN = "awaiting_admin_credentials"
    PROVISION_CREDENTIALS_ISSUED = "credentials_issued"
    PROVISION_FAILED = "failed"
    PROVISION_CHOICES = [
        (PROVISION_PENDING, "Pending payment"),
        (PROVISION_AWAITING_ADMIN, "Awaiting admin credentials"),
        (PROVISION_CREDENTIALS_ISSUED, "Credentials issued"),
        (PROVISION_FAILED, "Provisioning failed"),
    ]

    internal_reference = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="payments",
        blank=True,
        null=True,
    )
    course = models.ForeignKey(
        Course,
        on_delete=models.SET_NULL,
        related_name="payments",
        blank=True,
        null=True,
    )
    user_email_snapshot = models.EmailField(blank=True, default="")
    course_id_snapshot = models.PositiveBigIntegerField(blank=True, null=True)
    course_title_snapshot = models.CharField(max_length=255, blank=True, default="")
    razorpay_order_id = models.CharField(max_length=255, blank=True, default="")
    razorpay_payment_id = models.CharField(max_length=255, blank=True, null=True)
    razorpay_signature = models.CharField(max_length=255, blank=True, null=True)
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    currency = models.CharField(max_length=10, default="INR")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_CREATED)
    plan = models.CharField(max_length=20, choices=PLAN_CHOICES, default=PLAN_FULL)
    installment_number = models.PositiveSmallIntegerField(blank=True, null=True)
    access_expires_at = models.DateTimeField(blank=True, null=True)
    invoice_number = models.CharField(max_length=64, blank=True, null=True, unique=True)
    provisioning_status = models.CharField(
        max_length=40, choices=PROVISION_CHOICES, default=PROVISION_PENDING
    )
    credentials_issued_at = models.DateTimeField(blank=True, null=True)
    buyer_name = models.CharField(max_length=255, blank=True, default="")
    buyer_email = models.EmailField(blank=True, default="")
    whatsapp_number = models.CharField(max_length=24, blank=True, default="")
    alternate_number = models.CharField(max_length=24, blank=True, default="")
    age = models.PositiveSmallIntegerField(blank=True, null=True)
    country = models.CharField(max_length=120, blank=True, default="")
    state = models.CharField(max_length=120, blank=True, default="")
    city = models.CharField(max_length=120, blank=True, default="")
    pincode = models.CharField(max_length=20, blank=True, default="")
    gateway_status = models.CharField(max_length=64, blank=True, default="")
    payment_method = models.CharField(max_length=64, blank=True, default="")
    gateway_details = models.JSONField(blank=True, default=dict)
    failure_reason = models.TextField(blank=True, default="")
    last_webhook_event = models.CharField(max_length=120, blank=True, default="")
    paid_at = models.DateTimeField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["razorpay_order_id"]),
            models.Index(fields=["razorpay_payment_id"]),
            models.Index(fields=["user", "course", "razorpay_order_id"]),
            models.Index(fields=["user", "status", "created_at"]),
        ]

    def __str__(self):
        user_label = self.user_email_snapshot or getattr(self.user, "email", "") or "Unknown user"
        course_label = self.course_title_snapshot or getattr(self.course, "title", "") or "Unknown course"
        return f"{user_label} - {course_label} - {self.status}"

    def save(self, *args, **kwargs):
        if self.user_id and not self.user_email_snapshot:
            self.user_email_snapshot = str(getattr(self.user, "email", "") or "")
        if self.course_id:
            if self.course_id_snapshot is None:
                self.course_id_snapshot = self.course_id
            if not self.course_title_snapshot:
                self.course_title_snapshot = str(getattr(self.course, "title", "") or "")
        super().save(*args, **kwargs)


class StudentAccountSequence(models.Model):
    next_number = models.PositiveBigIntegerField(default=1)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Student account sequence"
        verbose_name_plural = "Student account sequence"
