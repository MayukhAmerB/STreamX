import uuid
from decimal import Decimal

from django.conf import settings
from django.db import models

from config.model_validators import validate_no_active_content

from apps.courses.models import Course
from apps.users.models import User


class Payment(models.Model):
    STATUS_CREATED = "created"
    STATUS_PAID = "paid"
    STATUS_FAILED = "failed"
    STATUS_REFUNDED = "refunded"
    STATUS_CHOICES = [
        (STATUS_CREATED, "Created"),
        (STATUS_PAID, "Paid"),
        (STATUS_FAILED, "Failed"),
        (STATUS_REFUNDED, "Refunded"),
    ]
    PLAN_FULL = "full"
    PLAN_MONTHLY = "monthly"
    PLAN_BUNDLE = "bundle"
    PLAN_BATCH_PASS = "batch_pass"
    # Platform plans (apps.payments.platform_plans): no course; see platform_plan.
    PLAN_PLATFORM_ONE_TIME = "platform_once"
    PLAN_PLATFORM_SUBSCRIPTION = "platform_sub"
    PLAN_CHOICES = [
        (PLAN_FULL, "Full / lifetime"),
        (PLAN_MONTHLY, "Monthly installment"),
        (PLAN_BUNDLE, "3-month bundle"),
        (PLAN_BATCH_PASS, "All future batches pass"),
        (PLAN_PLATFORM_ONE_TIME, "Platform plan (one-time)"),
        (PLAN_PLATFORM_SUBSCRIPTION, "Platform subscription charge"),
    ]
    terms_snapshot = models.JSONField(default=dict, blank=True)
    PROVISION_PENDING = "pending_payment"
    PROVISION_AWAITING_ADMIN = "awaiting_admin_credentials"
    PROVISION_CREDENTIALS_ISSUED = "credentials_issued"
    PROVISION_FAILED = "failed"
    # A captured guest one-time purchase the buyer email already owned: nothing
    # was granted; refund it (admin filter "Provisioning status").
    PROVISION_DUPLICATE = "duplicate_refund_due"
    PROVISION_CHOICES = [
        (PROVISION_PENDING, "Pending payment"),
        (PROVISION_AWAITING_ADMIN, "Awaiting admin credentials"),
        (PROVISION_CREDENTIALS_ISSUED, "Credentials issued"),
        (PROVISION_FAILED, "Provisioning failed"),
        (PROVISION_DUPLICATE, "Duplicate purchase - refund due"),
    ]

    application = models.ForeignKey("courses.PentestingApplication", on_delete=models.PROTECT,
                                    null=True, blank=True, related_name="payments")
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
    amount_refunded = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        help_text="Cumulative amount refunded through Razorpay or marked refunded by an admin.",
    )
    refunded_at = models.DateTimeField(blank=True, null=True)
    # Platform plans (Bootcamp, Lifetime, memberships): course stays null.
    platform_plan = models.ForeignKey(
        "payments.PlatformPlan",
        on_delete=models.PROTECT,
        related_name="payments",
        blank=True,
        null=True,
    )
    subscription = models.ForeignKey(
        "payments.PlatformSubscription",
        on_delete=models.SET_NULL,
        related_name="payments",
        blank=True,
        null=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["razorpay_order_id"]),
            models.Index(fields=["razorpay_payment_id"]),
            models.Index(fields=["user", "course", "razorpay_order_id"]),
            models.Index(fields=["user", "status", "created_at"]),
            # Stuck-payment reconciliation walks open orders oldest-checked first.
            models.Index(fields=["status", "updated_at"], name="payments_pay_status_upd_idx"),
        ]
        constraints = [
            # One Payment row per subscription charge (webhook replays and the
            # reconcile command both upsert on the Razorpay payment id).
            models.UniqueConstraint(
                fields=["razorpay_payment_id"],
                condition=models.Q(plan="platform_sub", razorpay_payment_id__isnull=False),
                name="payments_one_row_per_subscription_charge",
            )
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


class SuccessfulPaymentUser(User):
    """Admin-only view of accounts provisioned by successful payments."""

    class Meta:
        proxy = True
        verbose_name = "Successful Payment User"
        verbose_name_plural = "Successful Payment Users"


class PaymentWebhookEvent(models.Model):
    STATUS_RECEIVED = "received"
    STATUS_PROCESSED = "processed"
    STATUS_IGNORED = "ignored"
    STATUS_REJECTED = "rejected"
    STATUS_RETRY_QUEUED = "retry_queued"
    STATUS_FAILED = "failed"
    STATUS_CHOICES = [
        (STATUS_RECEIVED, "Received"),
        (STATUS_PROCESSED, "Processed"),
        (STATUS_IGNORED, "Ignored"),
        (STATUS_REJECTED, "Rejected"),
        (STATUS_RETRY_QUEUED, "Retry queued"),
        (STATUS_FAILED, "Failed"),
    ]

    event_id = models.CharField(max_length=255, unique=True)
    event_type = models.CharField(max_length=120, blank=True, default="")
    payload_hash = models.CharField(max_length=64)
    payment = models.ForeignKey(
        Payment,
        on_delete=models.SET_NULL,
        related_name="webhook_events",
        blank=True,
        null=True,
    )
    status = models.CharField(
        max_length=24,
        choices=STATUS_CHOICES,
        default=STATUS_RECEIVED,
    )
    processing_note = models.CharField(max_length=500, blank=True, default="")
    received_at = models.DateTimeField(auto_now_add=True)
    processed_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-received_at"]
        indexes = [
            models.Index(fields=["status", "received_at"]),
            models.Index(fields=["event_type", "received_at"]),
            # Replay check: the same signed body under another event id.
            models.Index(fields=["payload_hash"], name="payments_whe_payload_idx"),
        ]

    def __str__(self):
        return f"{self.event_id}:{self.status}"


class PaymentIdempotencyRecord(models.Model):
    SCOPE_CREATE_ORDER = "create_order"
    STATUS_PROCESSING = "processing"
    STATUS_COMPLETED = "completed"
    STATUS_CHOICES = [
        (STATUS_PROCESSING, "Processing"),
        (STATUS_COMPLETED, "Completed"),
    ]

    scope = models.CharField(max_length=40, default=SCOPE_CREATE_ORDER)
    identity_hash = models.CharField(max_length=64)
    key_hash = models.CharField(max_length=64)
    request_fingerprint = models.CharField(max_length=64)
    lease_token = models.UUIDField(default=uuid.uuid4, editable=False)
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default=STATUS_PROCESSING,
    )
    payment = models.ForeignKey(
        Payment,
        on_delete=models.SET_NULL,
        related_name="idempotency_records",
        blank=True,
        null=True,
    )
    response_payload = models.JSONField(blank=True, default=dict)
    response_status = models.PositiveSmallIntegerField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["scope", "identity_hash", "key_hash"],
                name="payments_idem_scope_identity_key_uniq",
            )
        ]
        indexes = [
            models.Index(fields=["status", "created_at"]),
        ]

    def __str__(self):
        return f"{self.scope}:{self.status}:{self.created_at.isoformat()}"


class PaymentCheckoutLock(models.Model):
    """Database mutex serializing one buyer/course checkout at a time."""

    course = models.ForeignKey(
        Course,
        on_delete=models.CASCADE,
        related_name="checkout_locks",
    )
    identity_hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["course", "identity_hash"],
                name="payments_checkout_course_identity_uniq",
            )
        ]

    def __str__(self):
        return f"{self.course_id}:{self.identity_hash[:12]}"


class BatchPass(models.Model):
    """Lifetime entitlement to every course marked included_in_batch_pass.

    Created when an all-future-batches payment is provisioned; access itself is
    materialized as lifetime Enrollments so every existing access check keeps
    working unchanged.
    """

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="batch_passes")
    payment = models.OneToOneField(Payment, on_delete=models.PROTECT, related_name="batch_pass")
    source_course = models.ForeignKey(Course, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    is_active = models.BooleanField(
        default=True,
        help_text="Untick to end the pass: future batches stop and courses only the pass unlocked are revoked.",
    )
    granted_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-granted_at"]
        indexes = [models.Index(fields=["is_active", "user"])]
        verbose_name = "All future batches pass"
        verbose_name_plural = "All future batches passes"

    def __str__(self):
        return f"{self.user} - all future batches pass"


# ---------------------------------------------------------------------------
# Platform plans: Bootcamp / Lifetime (one-time), memberships (subscriptions)
# ---------------------------------------------------------------------------


class PlatformPlan(models.Model):
    """A plan sold for the whole platform rather than one course.

    Ships disabled. ``is_enabled`` can only be true once the owner confirmed
    the INR price (``price_confirmed_at`` with ``confirmed_price == price_inr``),
    the price is positive and, for subscriptions, a Razorpay plan id is set.
    Editing the price or the billing period un-confirms the plan and turns it
    off (``save``), so a price never goes live without a fresh confirmation.
    """

    PRODUCT_CTF_LABS = "ctf_labs"
    PRODUCT_CTF_STARTER = "ctf_starter"
    PRODUCT_PT_BOOTCAMP = "pentesting_bootcamp"
    PRODUCT_PT_MEMBERSHIP = "pentesting_membership"
    PRODUCT_PT_LIFETIME = "pentesting_lifetime"
    PRODUCT_CHOICES = [
        (PRODUCT_CTF_STARTER, "OSINT Starter (easy + medium labs, one batch's recordings)"),
        (PRODUCT_CTF_LABS, "CTF Labs membership (all labs, monthly course bundle)"),
        (PRODUCT_PT_BOOTCAMP, "Pentesting Foundations Bootcamp (one-time)"),
        (PRODUCT_PT_MEMBERSHIP, "Pentesting membership (subscription)"),
        (PRODUCT_PT_LIFETIME, "Pentesting lifetime (one-time)"),
    ]
    SUBSCRIPTION_PRODUCTS = (PRODUCT_CTF_LABS, PRODUCT_CTF_STARTER, PRODUCT_PT_MEMBERSHIP)
    PENTESTING_PRODUCTS = (PRODUCT_PT_BOOTCAMP, PRODUCT_PT_MEMBERSHIP, PRODUCT_PT_LIFETIME)
    OSINT_PRODUCTS = (PRODUCT_CTF_LABS, PRODUCT_CTF_STARTER)

    KIND_ONE_TIME = "one_time"
    KIND_SUBSCRIPTION = "subscription"
    KIND_CHOICES = [(KIND_ONE_TIME, "One-time payment"), (KIND_SUBSCRIPTION, "Subscription")]

    PERIOD_NONE = "none"
    PERIOD_MONTHLY = "monthly"
    PERIOD_YEARLY = "yearly"
    PERIOD_CHOICES = [(PERIOD_NONE, "No period (one-time)"), (PERIOD_MONTHLY, "Monthly"), (PERIOD_YEARLY, "Yearly")]

    GROUP_OSINT = "osint"
    GROUP_PENTESTING = "pentesting"
    GROUP_CHOICES = [(GROUP_OSINT, "OSINT"), (GROUP_PENTESTING, "Pentesting")]

    key = models.SlugField(max_length=40, unique=True)
    product = models.CharField(max_length=32, choices=PRODUCT_CHOICES)
    kind = models.CharField(max_length=16, choices=KIND_CHOICES, editable=False)
    catalog_group = models.CharField(max_length=16, choices=GROUP_CHOICES, editable=False)
    title = models.CharField(max_length=80)
    subtitle = models.CharField(max_length=160, blank=True, default="")
    badge = models.CharField(max_length=30, blank=True, default="")
    cta_label = models.CharField(max_length=40, blank=True, default="")
    features = models.JSONField(
        blank=True,
        default=list,
        help_text='Card bullets: a list of {"text": "...", "included": true}. Excluded items show with a dash.',
    )
    highlighted = models.BooleanField(
        default=False, help_text="The one highlighted card of its pricing group (OSINT or Pentesting)."
    )
    display_order = models.PositiveSmallIntegerField(default=0)
    price_inr = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal("0.00"),
        help_text="Rupees. Changing it un-confirms the plan and switches it off until the owner confirms again.",
    )
    billing_period = models.CharField(max_length=10, choices=PERIOD_CHOICES, default=PERIOD_NONE)
    courses = models.ManyToManyField(
        Course,
        blank=True,
        related_name="platform_plans",
        help_text="Courses this plan unlocks (Bootcamp / Pentesting membership / Lifetime).",
    )
    include_future = models.BooleanField(
        default=False,
        help_text="Also unlock every Pentesting course published later (Lifetime).",
    )
    starter_course = models.ForeignKey(
        Course,
        on_delete=models.PROTECT,
        related_name="starter_plans",
        blank=True,
        null=True,
        help_text="Starter plans only: the batch whose published recordings this plan plays.",
    )
    razorpay_plan_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        help_text="Subscriptions only. Create the plan in the Razorpay dashboard (amount = this price) and paste its id.",
    )
    confirmed_price = models.DecimalField(max_digits=10, decimal_places=2, blank=True, null=True, editable=False)
    price_confirmed_at = models.DateTimeField(blank=True, null=True, editable=False)
    price_confirmed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="+",
        blank=True,
        null=True,
        editable=False,
    )
    is_enabled = models.BooleanField(
        default=False,
        help_text="Sell this plan. Needs a confirmed price (and a Razorpay plan id for subscriptions).",
    )
    version = models.PositiveIntegerField(default=0, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["display_order", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["catalog_group"],
                condition=models.Q(highlighted=True),
                name="payments_one_highlighted_plan_per_group",
            )
        ]
        indexes = [models.Index(fields=["product", "is_enabled"], name="payments_pp_prod_enabled_idx")]
        verbose_name = "Platform plan"
        verbose_name_plural = "Platform plans"

    def __str__(self):
        return f"{self.title} ({self.key})"

    # -- derived -----------------------------------------------------------
    @classmethod
    def kind_for(cls, product):
        return cls.KIND_SUBSCRIPTION if product in cls.SUBSCRIPTION_PRODUCTS else cls.KIND_ONE_TIME

    @classmethod
    def group_for(cls, product):
        return cls.GROUP_PENTESTING if product in cls.PENTESTING_PRODUCTS else cls.GROUP_OSINT

    @property
    def is_subscription(self):
        return self.kind_for(self.product) == self.KIND_SUBSCRIPTION

    @property
    def includes_pentesting(self):
        return self.product in self.PENTESTING_PRODUCTS

    @property
    def price_is_confirmed(self):
        return bool(
            self.price_confirmed_at
            and self.confirmed_price is not None
            and self.price_inr is not None
            and self.confirmed_price == self.price_inr
            and self.price_inr > 0
        )

    def entitlement_keys(self):
        if self.product == self.PRODUCT_CTF_LABS:
            return ["ctf_labs"]
        if self.product == self.PRODUCT_CTF_STARTER:
            return ["ctf_starter"]
        return []

    def enable_blockers(self):
        """Why the plan cannot be switched on (empty list = it can)."""
        problems = []
        if self.price_inr is None or self.price_inr <= 0:
            problems.append("Set a price above zero.")
        if not self.price_is_confirmed:
            problems.append('Confirm the price first (admin action "Confirm price").')
        if self.is_subscription and not self.razorpay_plan_id:
            problems.append("Paste the Razorpay plan id for this subscription.")
        if self.is_subscription and self.billing_period == self.PERIOD_NONE:
            problems.append("Choose a monthly or yearly billing period.")
        if not self.is_subscription and self.billing_period != self.PERIOD_NONE:
            problems.append("One-time plans have no billing period.")
        if self.product == self.PRODUCT_CTF_STARTER and not self.starter_course_id:
            problems.append("Choose the batch whose recordings this Starter plan includes.")
        return problems

    def clean(self):
        from django.core.exceptions import ValidationError

        super().clean()
        for field in ("title", "subtitle", "badge", "cta_label"):
            validate_no_active_content(getattr(self, field), field)
        self.features = sanitize_plan_features(self.features)
        if self.price_inr is not None and self.price_inr < 0:
            raise ValidationError({"price_inr": "The price cannot be negative."})
        self.kind = self.kind_for(self.product)
        self.catalog_group = self.group_for(self.product)
        if self.highlighted:
            clash = PlatformPlan.objects.filter(catalog_group=self.catalog_group, highlighted=True).exclude(pk=self.pk)
            if clash.exists():
                raise ValidationError({"highlighted": "Only one plan per pricing group can be highlighted."})
        if self.is_enabled:
            changed = self._price_changed()
            if changed:
                raise ValidationError(
                    {"is_enabled": "The price or period changed: save it, then confirm the new price before enabling."}
                )
            blockers = self.enable_blockers()
            if blockers:
                raise ValidationError({"is_enabled": blockers})

    def _price_changed(self):
        if not self.pk:
            return False
        previous = PlatformPlan.objects.filter(pk=self.pk).values("price_inr", "billing_period").first()
        if not previous:
            return False
        return previous["price_inr"] != self.price_inr or previous["billing_period"] != self.billing_period

    def _apply_price_change_rules(self):
        """Un-confirm and switch off when price or period changed since the stored row."""
        if not self._price_changed():
            return False
        self.price_confirmed_at = None
        self.price_confirmed_by = None
        self.confirmed_price = None
        self.is_enabled = False
        if self.is_subscription:
            # Razorpay plans are immutable: a new price needs a new plan id.
            self.razorpay_plan_id = ""
        return True

    def save(self, *args, **kwargs):
        self.kind = self.kind_for(self.product)
        self.catalog_group = self.group_for(self.product)
        self._apply_price_change_rules()
        if self.is_enabled and self.enable_blockers():
            self.is_enabled = False
        self.version = (self.version or 0) + 1
        update_fields = kwargs.get("update_fields")
        if update_fields is not None:
            kwargs["update_fields"] = list(
                {
                    *update_fields,
                    "version",
                    "updated_at",
                    "kind",
                    "catalog_group",
                    "is_enabled",
                    "price_confirmed_at",
                    "price_confirmed_by",
                    "confirmed_price",
                    "razorpay_plan_id",
                }
            )
        super().save(*args, **kwargs)


def sanitize_plan_features(value):
    from django.core.exceptions import ValidationError

    if value in (None, "", []):
        return []
    if not isinstance(value, list):
        raise ValidationError({"features": "Enter a list of {text, included} items."})
    if len(value) > 12:
        raise ValidationError({"features": "Keep a plan card to 12 bullets or fewer."})
    cleaned = []
    for index, item in enumerate(value):
        if isinstance(item, str):
            item = {"text": item, "included": True}
        if not isinstance(item, dict):
            raise ValidationError({"features": f"Bullet {index + 1} must be text or {{text, included}}."})
        text = " ".join(str(item.get("text") or "").split())
        if not text:
            continue
        if len(text) > 120:
            raise ValidationError({"features": f"Bullet {index + 1} is longer than 120 characters."})
        validate_no_active_content(text, f"features[{index}]")
        cleaned.append({"text": text, "included": bool(item.get("included", True))})
    return cleaned


class PlatformGrant(models.Model):
    """Access from a one-time platform plan payment, or a manual admin grant.

    One-time purchases (Bootcamp, Lifetime) materialise lifetime Enrollments
    (the BatchPass pattern). A manual grant of a membership plan (scholarship,
    staff comp) gives that plan's labs entitlement until ``expires_at``.
    """

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="platform_grants")
    plan = models.ForeignKey(PlatformPlan, on_delete=models.PROTECT, related_name="grants")
    payment = models.OneToOneField(
        Payment, on_delete=models.PROTECT, related_name="platform_grant", blank=True, null=True
    )
    is_active = models.BooleanField(
        default=True, help_text="Untick to end the grant: courses only this grant unlocked are revoked."
    )
    expires_at = models.DateTimeField(
        blank=True, null=True, help_text="Leave blank for no end date (one-time plans are lifetime)."
    )
    note = models.CharField(max_length=200, blank=True, default="")
    granted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, related_name="+", blank=True, null=True
    )
    granted_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-granted_at"]
        indexes = [models.Index(fields=["user", "is_active"], name="payments_pg_user_active_idx")]
        verbose_name = "Platform grant"
        verbose_name_plural = "Platform grants"

    def __str__(self):
        return f"{self.user} - {self.plan.title}"

    def has_access(self, at=None):
        from django.utils import timezone

        if not self.is_active:
            return False
        return self.expires_at is None or self.expires_at > (at or timezone.now())


class PlatformSubscription(models.Model):
    """A Razorpay subscription to a platform plan (webhook-authoritative).

    ``access_until`` = ``current_end`` + ``SUBSCRIPTION_GRACE_DAYS``; every
    entitlement check reads only that indexed field. It only ever moves
    forward, so a missed or late webhook never cuts paid time short.
    """

    STATUS_CREATED = "created"
    STATUS_AUTHENTICATED = "authenticated"
    STATUS_ACTIVE = "active"
    STATUS_PENDING = "pending"
    STATUS_HALTED = "halted"
    STATUS_PAUSED = "paused"
    STATUS_CANCELLED = "cancelled"
    STATUS_COMPLETED = "completed"
    STATUS_EXPIRED = "expired"
    STATUS_CHOICES = [
        (STATUS_CREATED, "Created (checkout not finished)"),
        (STATUS_AUTHENTICATED, "Authenticated"),
        (STATUS_ACTIVE, "Active"),
        (STATUS_PENDING, "Pending (charge retrying)"),
        (STATUS_HALTED, "Halted (charges failed)"),
        (STATUS_PAUSED, "Paused"),
        (STATUS_CANCELLED, "Cancelled"),
        (STATUS_COMPLETED, "Completed"),
        (STATUS_EXPIRED, "Expired"),
    ]
    LIVE_STATUSES = (
        STATUS_CREATED,
        STATUS_AUTHENTICATED,
        STATUS_ACTIVE,
        STATUS_PENDING,
        STATUS_HALTED,
        STATUS_PAUSED,
    )
    TERMINAL_STATUSES = (STATUS_CANCELLED, STATUS_COMPLETED, STATUS_EXPIRED)

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="platform_subscriptions")
    plan = models.ForeignKey(PlatformPlan, on_delete=models.PROTECT, related_name="subscriptions")
    razorpay_subscription_id = models.CharField(max_length=64, unique=True)
    razorpay_plan_id = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_CREATED)
    amount = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0.00"))
    total_count = models.PositiveSmallIntegerField(default=0)
    paid_count = models.PositiveSmallIntegerField(default=0)
    current_start = models.DateTimeField(blank=True, null=True)
    current_end = models.DateTimeField(blank=True, null=True)
    access_until = models.DateTimeField(blank=True, null=True, db_index=True)
    cancel_at_cycle_end = models.BooleanField(default=False)
    cancelled_at = models.DateTimeField(blank=True, null=True)
    ended_at = models.DateTimeField(blank=True, null=True)
    last_event_at = models.DateTimeField(blank=True, null=True)
    last_event = models.CharField(max_length=60, blank=True, default="")
    short_url = models.URLField(blank=True, default="")
    gateway_details = models.JSONField(blank=True, default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "plan"],
                condition=models.Q(status__in=["created", "authenticated", "active", "pending", "halted", "paused"]),
                name="payments_one_live_subscription_per_plan",
            )
        ]
        indexes = [
            models.Index(fields=["user", "access_until"], name="payments_ps_user_access_idx"),
            models.Index(fields=["status", "updated_at"], name="payments_ps_status_upd_idx"),
        ]
        verbose_name = "Platform subscription"
        verbose_name_plural = "Platform subscriptions"

    def __str__(self):
        return f"{self.user} - {self.plan.title} - {self.status}"

    def has_access(self, at=None):
        from django.utils import timezone

        return bool(self.access_until and self.access_until > (at or timezone.now()))


class MembershipBundle(models.Model):
    """The courses whose recordings CTF Labs members can play in one IST calendar month."""

    STATUS_DRAFT = "draft"
    STATUS_PUBLISHED = "published"
    STATUS_CHOICES = [(STATUS_DRAFT, "Draft"), (STATUS_PUBLISHED, "Published")]

    month = models.DateField(unique=True, help_text="Any day of the month; stored as the 1st (IST calendar month).")
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=STATUS_DRAFT)
    courses = models.ManyToManyField(
        Course,
        blank=True,
        related_name="membership_bundles",
        help_text="Courses / batches whose published recordings members can play this month.",
    )
    note = models.CharField(max_length=200, blank=True, default="")
    published_at = models.DateTimeField(blank=True, null=True, editable=False)
    published_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, related_name="+", blank=True, null=True, editable=False
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-month"]
        verbose_name = "Membership bundle"
        verbose_name_plural = "Membership bundles"

    def __str__(self):
        return f"Membership bundle {self.month:%Y-%m} ({self.get_status_display()})"

    def save(self, *args, **kwargs):
        if self.month:
            self.month = self.month.replace(day=1)
        super().save(*args, **kwargs)
