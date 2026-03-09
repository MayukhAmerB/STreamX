from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone

from config.model_validators import validate_no_active_content
from config.upload_validators import validate_profile_image_upload

from .managers import UserManager


class User(AbstractUser):
    ROLE_STUDENT = "student"
    ROLE_INSTRUCTOR = "instructor"
    ROLE_CHOICES = [
        (ROLE_STUDENT, "Student"),
        (ROLE_INSTRUCTOR, "Instructor"),
    ]

    username = None
    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=255)
    phone_number = models.CharField(max_length=24, blank=True, default="")
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default=ROLE_STUDENT)
    profile_image = models.ImageField(upload_to="profile_images/", blank=True, null=True)
    two_factor_enabled = models.BooleanField(default=False)
    two_factor_secret = models.CharField(max_length=64, blank=True, default="")
    oauth_provider = models.CharField(max_length=50, blank=True, default="")
    oauth_provider_uid = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    objects = UserManager()

    def clean(self):
        super().clean()
        validate_no_active_content(self.full_name, "full_name")
        validate_profile_image_upload(self.profile_image, "profile_image")

    def __str__(self):
        return self.email


class AuthConfiguration(models.Model):
    registration_enabled = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Auth Configuration"
        verbose_name_plural = "Auth Configuration"

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    @classmethod
    def get_solo(cls):
        obj, _ = cls.objects.get_or_create(pk=1, defaults={"registration_enabled": False})
        return obj

    def __str__(self):
        return "Auth Configuration"


class AsyncJob(models.Model):
    TYPE_EMAIL_SEND = "email_send"
    TYPE_PAYMENT_WEBHOOK_RETRY = "payment_webhook_retry"
    TYPE_CHOICES = [
        (TYPE_EMAIL_SEND, "Email Send"),
        (TYPE_PAYMENT_WEBHOOK_RETRY, "Payment Webhook Retry"),
    ]

    STATUS_PENDING = "pending"
    STATUS_PROCESSING = "processing"
    STATUS_SUCCEEDED = "succeeded"
    STATUS_DEAD = "dead"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_PROCESSING, "Processing"),
        (STATUS_SUCCEEDED, "Succeeded"),
        (STATUS_DEAD, "Dead"),
    ]

    job_type = models.CharField(max_length=64, choices=TYPE_CHOICES)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PENDING)
    payload = models.JSONField(default=dict, blank=True)
    result_payload = models.JSONField(default=dict, blank=True)
    attempts = models.PositiveIntegerField(default=0)
    max_attempts = models.PositiveIntegerField(default=5)
    run_after = models.DateTimeField(default=timezone.now)
    locked_at = models.DateTimeField(blank=True, null=True)
    completed_at = models.DateTimeField(blank=True, null=True)
    last_error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["run_after", "id"]
        indexes = [
            models.Index(fields=["status", "run_after"]),
            models.Index(fields=["job_type", "status", "run_after"]),
            models.Index(fields=["created_at"]),
        ]

    def __str__(self):
        return f"{self.job_type}:{self.status}:id={self.id}"
