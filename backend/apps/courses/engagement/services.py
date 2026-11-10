"""Likes and comments on lectures. Views only map HTTP onto these functions."""

from django.db import IntegrityError, transaction
from django.utils import timezone

from config.audit import log_security_event

from ..access import lecture_access_context
from .models import LectureComment, LectureLike
from .text import clean_comment_body


def can_engage(lecture, user):
    """Members who may watch the lecture (or staff) may like and comment on it."""
    context = lecture_access_context(lecture, user)
    if not context["is_authenticated"]:
        return False
    return bool(context["can_access"] or context["is_staff"])


def can_moderate(lecture, user):
    context = lecture_access_context(lecture, user)
    return bool(context["is_staff"] or context["is_instructor_owner"])


def visible_comments(lecture):
    return (
        LectureComment.objects.filter(lecture=lecture, is_hidden=False)
        .select_related("user")
        .order_by("-created_at", "-id")
    )


def like_summary(lecture, user):
    return {
        "lecture_id": lecture.id,
        "like_count": LectureLike.objects.filter(lecture=lecture).count(),
        "liked": LectureLike.objects.filter(lecture=lecture, user=user).exists(),
        "comment_count": LectureComment.objects.filter(lecture=lecture, is_hidden=False).count(),
    }


def set_like(lecture, user, *, liked):
    """Idempotently like or unlike; returns the fresh summary."""
    if liked:
        try:
            with transaction.atomic():
                LectureLike.objects.get_or_create(lecture=lecture, user=user)
        except IntegrityError:
            # A concurrent request created the same like; the end state is identical.
            pass
    else:
        LectureLike.objects.filter(lecture=lecture, user=user).delete()
    return like_summary(lecture, user)


def toggle_like(lecture, user):
    already_liked = LectureLike.objects.filter(lecture=lecture, user=user).exists()
    return set_like(lecture, user, liked=not already_liked)


def create_comment(lecture, user, raw_body, *, request=None):
    comment = LectureComment.objects.create(lecture=lecture, user=user, body=clean_comment_body(raw_body))
    log_security_event(
        "course.lecture_comment_created",
        request=request,
        lecture_id=lecture.id,
        comment_id=comment.id,
    )
    return comment


def update_comment(comment, raw_body, *, request=None):
    comment.body = clean_comment_body(raw_body)
    comment.edited_at = timezone.now()
    comment.save(update_fields=["body", "edited_at", "updated_at"])
    log_security_event(
        "course.lecture_comment_updated",
        request=request,
        lecture_id=comment.lecture_id,
        comment_id=comment.id,
    )
    return comment


def delete_comment(comment, *, actor, request=None):
    comment_id = comment.id
    lecture_id = comment.lecture_id
    moderated = actor.id != comment.user_id
    comment.delete()
    log_security_event(
        "course.lecture_comment_moderated_delete" if moderated else "course.lecture_comment_deleted",
        request=request,
        lecture_id=lecture_id,
        comment_id=comment_id,
    )


def hide_comments(queryset, *, reason="", request=None):
    comment_ids = list(queryset.values_list("id", flat=True))
    updated = LectureComment.objects.filter(id__in=comment_ids).update(
        is_hidden=True,
        hidden_reason=str(reason or "")[:255],
        updated_at=timezone.now(),
    )
    log_security_event("course.lecture_comments_hidden", request=request, comment_ids=comment_ids[:200])
    return updated


def unhide_comments(queryset, *, request=None):
    comment_ids = list(queryset.values_list("id", flat=True))
    updated = LectureComment.objects.filter(id__in=comment_ids).update(
        is_hidden=False,
        hidden_reason="",
        updated_at=timezone.now(),
    )
    log_security_event("course.lecture_comments_unhidden", request=request, comment_ids=comment_ids[:200])
    return updated
