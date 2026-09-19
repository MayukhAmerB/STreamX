"""Course product records, separate from access and payment authority."""

import uuid

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models


class CourseReview(models.Model):
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_HIDDEN = "hidden"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Published"),
        (STATUS_HIDDEN, "Hidden"),
    ]

    course = models.ForeignKey("courses.Course", on_delete=models.CASCADE, related_name="reviews")
    student = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    rating = models.PositiveSmallIntegerField(validators=[MinValueValidator(1), MaxValueValidator(5)])
    text = models.TextField(max_length=3000)
    status = models.CharField(
        max_length=12,
        default=STATUS_APPROVED,
        choices=STATUS_CHOICES,
    )
    edit_allowed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["course", "student"], name="one_student_review_per_course"),
            models.CheckConstraint(condition=models.Q(rating__gte=1, rating__lte=5), name="review_rating_1_to_5"),
        ]
        ordering = ["-created_at", "-pk"]


class PentestingApplication(models.Model):
    reference = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    course = models.ForeignKey("courses.Course", on_delete=models.PROTECT, related_name="applications")
    student = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True)
    full_name = models.CharField(max_length=120)
    email = models.EmailField()
    phone = models.CharField(max_length=24)
    is_student = models.BooleanField()
    institution = models.CharField(max_length=200, blank=True)
    education = models.CharField(max_length=200)
    skill_level = models.CharField(
        max_length=20,
        choices=[
            ("beginner", "Beginner"),
            ("intermediate", "Intermediate"),
            ("advanced", "Advanced"),
        ],
    )
    experience = models.TextField(max_length=2000)
    motivation = models.TextField(max_length=2000)
    consent_at = models.DateTimeField()
    status = models.CharField(
        max_length=20,
        default="submitted",
        choices=[
            ("submitted", "Submitted"),
            ("enrolled", "Enrolled"),
            ("cancelled", "Cancelled"),
        ],
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    @property
    def payment_status(self):
        if self.payments.filter(status="paid").exists():
            return "paid"
        if self.status == "cancelled":
            return "cancelled"
        latest = self.payments.order_by("-created_at").first()
        return "failed" if latest and latest.status == "failed" else "pending"
