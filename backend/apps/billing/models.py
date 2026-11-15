"""Billing catalogue: products, versioned prices, plans, purchases and entitlement grants.

The catalogue knows nothing about courses, labs or CTFs. A plan grants free-form
entitlement keys ("course_access:12", "all_labs", ...); other apps react to the
grants through ``apps.billing.signals`` or ask ``apps.billing.services``.

Every table here is new (additive migration); no existing table is changed.
"""

from __future__ import annotations

import re
import uuid
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator
from django.db import models, transaction
from django.db.models import Q
from django.utils import timezone

KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}(:[A-Za-z0-9_.-]{1,64})?$")


def validate_entitlement_key(value: str) -> None:
    if not KEY_PATTERN.match(str(value or "")):
        raise ValidationError(
            "Use lower_snake_case, optionally followed by ':<argument>' (for example course_access:12).",
            code="invalid_entitlement_key",
        )
    from .registry import is_registered

    if not is_registered(value):
        raise ValidationError(
            f"'{value}' is not a registered entitlement key. Add it under Billing > Entitlement keys first.",
            code="unknown_entitlement_key",
        )


class Product(models.Model):
    """A thing we sell: "OSINT Batch IV access", "Labs membership", a future service."""

    key = models.SlugField(max_length=80, unique=True, help_text="Stable identifier used by code and URLs.")
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    is_active = models.BooleanField(default=True)
    metadata = models.JSONField(
        blank=True, default=dict, help_text='Free-form context for integrations, e.g. {"course_id": 12}.'
    )
    sort_order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["sort_order", "name"]

    def __str__(self):
        return self.name


class Price(models.Model):
    """An amount for a product. Versioned: a used price is never rewritten in place.

    Changing a commercial field (amount, currency, billing type, interval, access
    days) of a price that already has purchases archives the old values as a new
    inactive row (``superseded_by`` = this row) and moves those purchases to it;
    this row keeps its id with the new values, so every plan pointing at it uses
    the new amount on the very next checkout. Purchases also snapshot what they
    were charged, so history never depends on the catalogue.
    """

    ONE_TIME = "one_time"
    RECURRING = "recurring"
    BILLING_TYPE_CHOICES = [(ONE_TIME, "One-time"), (RECURRING, "Recurring")]
    MONTH = "month"
    YEAR = "year"
    INTERVAL_CHOICES = [(MONTH, "Month"), (YEAR, "Year")]
    COMMERCIAL_FIELDS = ("amount", "currency", "billing_type", "interval", "interval_count", "access_days")

    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="prices")
    label = models.CharField(max_length=120, blank=True, default="", help_text='Admin label, e.g. "Monthly".')
    amount = models.DecimalField(max_digits=10, decimal_places=2, validators=[MinValueValidator(Decimal("1.00"))])
    currency = models.CharField(max_length=3, default="INR")
    billing_type = models.CharField(max_length=12, choices=BILLING_TYPE_CHOICES, default=ONE_TIME)
    interval = models.CharField(max_length=8, choices=INTERVAL_CHOICES, blank=True, default="")
    interval_count = models.PositiveSmallIntegerField(default=1, validators=[MinValueValidator(1)])
    access_days = models.PositiveIntegerField(
        null=True, blank=True, help_text="Days of access per payment. Empty = lifetime (one-time) or one interval (recurring)."
    )
    is_active = models.BooleanField(default=True)
    valid_from = models.DateTimeField(null=True, blank=True)
    valid_to = models.DateTimeField(null=True, blank=True)
    sort_order = models.PositiveIntegerField(default=0)
    is_highlighted = models.BooleanField(default=False)
    version = models.PositiveIntegerField(default=1, editable=False)
    superseded_by = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="previous_versions", editable=False
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["product", "sort_order", "-is_active", "-version"]

    def __str__(self):
        label = f"{self.label} " if self.label else ""
        return f"{self.product} - {label}{self.currency} {self.amount} ({self.describe_period()})"

    def describe_period(self) -> str:
        if self.billing_type == self.RECURRING:
            unit = self.interval or self.MONTH
            return f"every {self.interval_count} {unit}s" if self.interval_count > 1 else f"per {unit}"
        return f"{self.access_days} days" if self.access_days else "lifetime"

    def period_days(self) -> int | None:
        """Days of access one payment buys; None = lifetime."""
        if self.access_days:
            return int(self.access_days)
        if self.billing_type == self.RECURRING:
            per = 365 if self.interval == self.YEAR else 30
            return per * max(int(self.interval_count or 1), 1)
        return None

    def is_available(self, at=None) -> bool:
        at = at or timezone.now()
        return bool(
            self.is_active
            and (self.valid_from is None or self.valid_from <= at)
            and (self.valid_to is None or self.valid_to > at)
        )

    @property
    def amount_paise(self) -> int:
        return int((Decimal(self.amount) * 100).quantize(Decimal("1")))

    def clean(self):
        if self.billing_type == self.RECURRING and not self.interval:
            raise ValidationError({"interval": "A recurring price needs an interval (month or year)."})
        if self.billing_type == self.ONE_TIME and self.interval:
            raise ValidationError({"interval": "A one-time price has no interval."})
        if self.valid_from and self.valid_to and self.valid_to <= self.valid_from:
            raise ValidationError({"valid_to": "Must be after valid from."})
        self.currency = str(self.currency or "INR").upper()

    def save(self, *args, **kwargs):
        if self.pk and not kwargs.get("update_fields"):
            with transaction.atomic():
                previous = Price.objects.select_for_update().filter(pk=self.pk).first()
                if previous is not None and self._commercial_change(previous) and previous.purchases.exists():
                    self._archive(previous)
                super().save(*args, **kwargs)
            return
        super().save(*args, **kwargs)

    def _commercial_change(self, previous) -> bool:
        return any(getattr(previous, name) != getattr(self, name) for name in self.COMMERCIAL_FIELDS)

    def _archive(self, previous) -> None:
        purchase_ids = list(previous.purchases.values_list("pk", flat=True))
        archived = previous
        archived.pk = None
        archived.id = None
        archived.is_active = False
        archived.is_highlighted = False
        archived.valid_to = timezone.now()
        archived.superseded_by_id = self.pk
        super(Price, archived).save(force_insert=True)
        Purchase.objects.filter(pk__in=purchase_ids).update(price=archived)
        self.version = (archived.version or 1) + 1


class EntitlementKey(models.Model):
    """Admin-registered entitlement keys (code registers its own in ``registry.BUILTIN_KEYS``).

    ``takes_argument`` keys are prefixes: "course_access" allows "course_access:<id>".
    """

    key = models.CharField(max_length=64, unique=True)
    label = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    takes_argument = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["key"]

    def __str__(self):
        return f"{self.key}{':<arg>' if self.takes_argument else ''}"

    def clean(self):
        if not re.match(r"^[a-z][a-z0-9_]{0,63}$", self.key or ""):
            raise ValidationError({"key": "Use lower_snake_case (letters, digits, underscore)."})


class Plan(models.Model):
    """A named bundle: one price, display lines and entitlement keys."""

    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="plans")
    price = models.ForeignKey(Price, on_delete=models.PROTECT, related_name="plans")
    key = models.SlugField(max_length=100, unique=True)
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    badge = models.CharField(max_length=40, blank=True, default="", help_text='Short ribbon, e.g. "Best value".')
    is_active = models.BooleanField(default=True, help_text="Untick to hide the plan everywhere.")
    is_highlighted = models.BooleanField(default=False)
    sort_order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["product", "sort_order", "id"]

    def __str__(self):
        return self.name

    def clean(self):
        if self.price_id and self.product_id and self.price.product_id != self.product_id:
            raise ValidationError({"price": "The price must belong to the same product."})

    def entitlement_keys(self) -> list[str]:
        return [row.key for row in self.entitlements.all()]

    def is_purchasable(self, at=None) -> bool:
        return bool(self.is_active and self.product.is_active and self.price.is_available(at))


class PlanFeature(models.Model):
    plan = models.ForeignKey(Plan, on_delete=models.CASCADE, related_name="features")
    text = models.CharField(max_length=240)
    is_highlighted = models.BooleanField(default=False)
    sort_order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "id"]

    def __str__(self):
        return self.text


class PlanEntitlement(models.Model):
    plan = models.ForeignKey(Plan, on_delete=models.CASCADE, related_name="entitlements")
    key = models.CharField(max_length=160, validators=[validate_entitlement_key])

    class Meta:
        ordering = ["id"]
        constraints = [models.UniqueConstraint(fields=["plan", "key"], name="billing_plan_entitlement_unique")]

    def __str__(self):
        return self.key


class Purchase(models.Model):
    """One checkout of one plan by one user, with a snapshot of what was charged."""

    STATUS_PENDING = "pending"
    STATUS_PAID = "paid"
    STATUS_FAILED = "failed"
    STATUS_REFUNDED = "refunded"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending payment"),
        (STATUS_PAID, "Paid"),
        (STATUS_FAILED, "Failed"),
        (STATUS_REFUNDED, "Refunded"),
    ]

    reference = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    # SET_NULL like payments.Payment: deleting an account never deletes financial history.
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name="billing_purchases"
    )
    plan = models.ForeignKey(Plan, on_delete=models.PROTECT, related_name="purchases")
    price = models.ForeignKey(Price, on_delete=models.PROTECT, related_name="purchases")
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=STATUS_PENDING)
    # Snapshot of what was charged (never re-read from the catalogue).
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    currency = models.CharField(max_length=3, default="INR")
    billing_type = models.CharField(max_length=12, choices=Price.BILLING_TYPE_CHOICES)
    access_days = models.PositiveIntegerField(null=True, blank=True, help_text="Empty = lifetime.")
    entitlement_keys = models.JSONField(default=list, blank=True)
    plan_snapshot = models.JSONField(default=dict, blank=True)
    period_start = models.DateTimeField(null=True, blank=True)
    period_end = models.DateTimeField(null=True, blank=True)
    provider = models.CharField(max_length=20, default="razorpay")
    provider_order_id = models.CharField(max_length=255, blank=True, default="", db_index=True)
    provider_payment_id = models.CharField(max_length=255, blank=True, default="", db_index=True)
    amount_refunded = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    failure_reason = models.CharField(max_length=500, blank=True, default="")
    paid_at = models.DateTimeField(null=True, blank=True)
    refunded_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "status", "created_at"])]
        constraints = [
            models.UniqueConstraint(
                fields=["provider", "provider_order_id"],
                condition=~Q(provider_order_id=""),
                name="billing_purchase_unique_order",
            )
        ]

    def __str__(self):
        return f"{getattr(self.user, 'email', self.user_id)} - {self.plan_snapshot.get('name') or self.plan_id} - {self.status}"

    @property
    def amount_paise(self) -> int:
        return int((Decimal(self.amount) * 100).quantize(Decimal("1")))


class EntitlementGrantQuerySet(models.QuerySet):
    def live(self):
        return self.filter(revoked_at__isnull=True)

    def active_at(self, at=None):
        at = at or timezone.now()
        return self.live().filter(starts_at__lte=at).filter(Q(ends_at__isnull=True) | Q(ends_at__gt=at))


class EntitlementGrant(models.Model):
    """User X may use key K from ``starts_at`` until ``ends_at`` (null = lifetime)."""

    SOURCE_PURCHASE = "purchase"
    SOURCE_MANUAL = "manual"
    SOURCE_CHOICES = [(SOURCE_PURCHASE, "Purchase"), (SOURCE_MANUAL, "Manual (admin)")]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="billing_grants")
    key = models.CharField(max_length=160, validators=[validate_entitlement_key])
    purchase = models.ForeignKey(Purchase, on_delete=models.PROTECT, null=True, blank=True, related_name="grants")
    source = models.CharField(max_length=12, choices=SOURCE_CHOICES, default=SOURCE_MANUAL)
    starts_at = models.DateTimeField(default=timezone.now)
    ends_at = models.DateTimeField(null=True, blank=True, help_text="Empty = lifetime.")
    granted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    note = models.CharField(max_length=255, blank=True, default="")
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    revoke_reason = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    objects = EntitlementGrantQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["user", "key", "revoked_at"])]
        constraints = [
            models.UniqueConstraint(
                fields=["purchase", "key"], condition=Q(purchase__isnull=False), name="billing_one_grant_per_purchase_key"
            )
        ]

    def __str__(self):
        return f"{getattr(self.user, 'email', self.user_id)}: {self.key}"

    def clean(self):
        if self.ends_at and self.starts_at and self.ends_at <= self.starts_at:
            raise ValidationError({"ends_at": "Must be after the start."})

    def is_active(self, at=None) -> bool:
        at = at or timezone.now()
        return bool(
            self.revoked_at is None and self.starts_at <= at and (self.ends_at is None or self.ends_at > at)
        )


def default_period_end(start, days):
    return None if days is None else start + timedelta(days=int(days))
