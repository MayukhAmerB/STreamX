"""Per-lecture engagement records: likes, comments and de-duplicated views.

View counts are an internal metric. They are exposed only through the Django
admin and must never be added to a student-facing serializer.
"""

from django.conf import settings
from django.db import models

COMMENT_MAX_LENGTH = 2000


class LectureLike(models.Model):
    lecture = models.ForeignKey("courses.Lecture", on_delete=models.CASCADE, related_name="likes")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="lecture_likes")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Lecture like"
        verbose_name_plural = "Lecture likes"
        constraints = [
            models.UniqueConstraint(fields=["lecture", "user"], name="uniq_lecture_like_per_user"),
        ]
        indexes = [models.Index(fields=["lecture", "created_at"])]

    def __str__(self):
        return f"Like #{self.pk} on lecture {self.lecture_id}"


class LectureComment(models.Model):
    lecture = models.ForeignKey("courses.Lecture", on_delete=models.CASCADE, related_name="comments")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="lecture_comments",
    )
    body = models.TextField(max_length=COMMENT_MAX_LENGTH)
    is_hidden = models.BooleanField(
        default=False,
        help_text="Hidden comments are kept for moderation records but never shown to students.",
    )
    hidden_reason = models.CharField(max_length=255, blank=True, default="")
    edited_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "Lecture comment"
        verbose_name_plural = "Lecture comments"
        indexes = [
            models.Index(fields=["lecture", "is_hidden", "-created_at"]),
            models.Index(fields=["user", "-created_at"]),
        ]

    def __str__(self):
        preview = (self.body or "")[:60]
        return f"Comment #{self.pk}: {preview}"


class LectureView(models.Model):
    """One row per viewer per lecture per day (the de-duplication window)."""

    lecture = models.ForeignKey("courses.Lecture", on_delete=models.CASCADE, related_name="engagement_views")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="lecture_views",
    )
    # "u:<user id>" for members, "a:<salted hash>" for anonymous preview viewers.
    viewer_key = models.CharField(max_length=80)
    view_date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Lecture view"
        verbose_name_plural = "Lecture views"
        constraints = [
            models.UniqueConstraint(
                fields=["lecture", "viewer_key", "view_date"],
                name="uniq_lecture_view_per_viewer_per_day",
            ),
        ]
        indexes = [models.Index(fields=["lecture", "view_date"])]

    def __str__(self):
        return f"View of lecture {self.lecture_id} on {self.view_date}"
