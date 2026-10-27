from config.model_validators import validate_no_active_content, validate_safe_public_url
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator, RegexValidator
from django.db import models

from .india_locations import STATE_CHOICES, is_valid_district

DEFAULT_INSTAGRAM_URL = "https://www.instagram.com/adlfrontofficial?igsh=MTgwN3Z2ZXZ4aGswYg=="

INDIA_MOBILE_VALIDATOR = RegexValidator(
    regex=r"^\+91[6-9]\d{9}$",
    message="Enter a valid 10-digit Indian mobile number.",
)


class JoinApplication(models.Model):
    ROLE_CITIZEN = "citizen"
    ROLE_LAWYER = "lawyer"
    ROLE_CHOICES = [
        (ROLE_CITIZEN, "Citizen / Volunteer"),
        (ROLE_LAWYER, "Lawyer"),
    ]

    STATUS_NEW = "new"
    STATUS_REVIEWED = "reviewed"
    STATUS_CONTACTED = "contacted"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_NEW, "New"),
        (STATUS_REVIEWED, "Reviewed"),
        (STATUS_CONTACTED, "Contacted"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
    ]

    role = models.CharField(max_length=20, choices=ROLE_CHOICES)
    full_name = models.CharField(max_length=160)
    age = models.PositiveSmallIntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(18), MaxValueValidator(100)],
    )
    phone_number = models.CharField(max_length=13, validators=[INDIA_MOBILE_VALIDATOR])
    address = models.CharField(max_length=300, blank=True, default="")
    state = models.CharField(max_length=80, choices=STATE_CHOICES)
    district = models.CharField(max_length=80)
    terms_accepted_at = models.DateTimeField()
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_NEW)
    notes = models.TextField(blank=True, default="", help_text="Internal notes for the review team.")
    source_ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-created_at",)
        verbose_name = "Joining form submission"
        verbose_name_plural = "Joining form submissions"
        indexes = [
            models.Index(fields=("status", "created_at"), name="join_status_created_idx"),
            models.Index(fields=("role", "created_at"), name="join_role_created_idx"),
            models.Index(fields=("state", "district"), name="join_state_district_idx"),
            models.Index(fields=("phone_number",), name="join_phone_idx"),
        ]

    def clean(self):
        super().clean()
        for field_name in ("full_name", "address", "district", "notes"):
            validate_no_active_content(getattr(self, field_name), field_name)
        if self.state and self.district and not is_valid_district(self.state, self.district):
            raise ValidationError({"district": "Select a district from the chosen state."})

    def __str__(self):
        return f"{self.full_name} ({self.get_role_display()})"


class JoinFormSettings(models.Model):
    """Single-row, admin-managed settings for the public Join Al Syed form (pinned to pk=1)."""

    instagram_url = models.URLField(
        "Instagram link",
        max_length=500,
        default=DEFAULT_INSTAGRAM_URL,
        help_text="Where the 'Get the Updates' button on the Form Submitted screen sends people.",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Joining form settings"
        verbose_name_plural = "Joining form settings"

    def clean(self):
        super().clean()
        validate_safe_public_url(self.instagram_url, "instagram_url")

    def save(self, *args, **kwargs):
        self.pk = 1
        self.full_clean(validate_unique=False)
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        return (0, {})

    @classmethod
    def load(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def __str__(self):
        return "Joining form settings"
