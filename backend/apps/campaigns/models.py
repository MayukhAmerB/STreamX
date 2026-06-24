from django.core.exceptions import ValidationError
from django.db import models

from config.model_validators import validate_no_active_content


class Campaign(models.Model):
    name = models.CharField(max_length=180)
    campaign_number = models.CharField(max_length=20, blank=True, default="")
    description = models.TextField(blank=True, default="")
    image_data_url = models.TextField(blank=True, default="")
    is_featured = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    sort_order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["sort_order", "-is_featured", "-created_at"]
        indexes = [
            models.Index(fields=["is_active", "is_featured", "sort_order"]),
            models.Index(fields=["created_at"]),
        ]

    def clean(self):
        super().clean()
        validate_no_active_content(self.name, "name")
        validate_no_active_content(self.campaign_number, "campaign_number")
        validate_no_active_content(self.description, "description")
        if self.image_data_url and not self.image_data_url.startswith("data:image/"):
            raise ValidationError({"image_data_url": "Only image data URLs are allowed."})

    def __str__(self):
        return self.name


class CampaignVolunteer(models.Model):
    STATUS_NEW = "new"
    STATUS_REVIEWED = "reviewed"
    STATUS_CONTACTED = "contacted"
    STATUS_CONFIRMED = "confirmed"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_NEW, "New"),
        (STATUS_REVIEWED, "Reviewed"),
        (STATUS_CONTACTED, "Contacted"),
        (STATUS_CONFIRMED, "Confirmed"),
        (STATUS_REJECTED, "Rejected"),
    ]

    GENDER_MALE = "male"
    GENDER_FEMALE = "female"
    GENDER_CHOICES = [
        (GENDER_MALE, "Male"),
        (GENDER_FEMALE, "Female"),
    ]

    campaign = models.ForeignKey(Campaign, on_delete=models.PROTECT, related_name="volunteers")
    full_name = models.CharField(max_length=180)
    whatsapp_number = models.CharField(max_length=24)
    alternate_number = models.CharField(max_length=24, blank=True, default="")
    city = models.CharField(max_length=120)
    state = models.CharField(max_length=80)
    gender = models.CharField(max_length=12, choices=GENDER_CHOICES)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_NEW)
    notes = models.TextField(blank=True, default="")
    source_ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["campaign", "created_at"]),
            models.Index(fields=["status", "created_at"]),
            models.Index(fields=["whatsapp_number", "created_at"]),
        ]

    def clean(self):
        super().clean()
        for field_name in ("full_name", "whatsapp_number", "alternate_number", "city", "state", "notes"):
            validate_no_active_content(getattr(self, field_name, ""), field_name)

    def __str__(self):
        return f"{self.full_name} -> {self.campaign.name}"

