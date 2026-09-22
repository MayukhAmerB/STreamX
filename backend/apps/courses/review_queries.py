from django.db.models import Avg, Count, Exists, OuterRef, Subquery

from .models import CourseReview, Enrollment


def confirmed_review_queryset():
    """Published reviews whose author paid for the reviewed course."""
    paid_enrollment = Enrollment.objects.filter(
        course_id=OuterRef("course_id"),
        user_id=OuterRef("student_id"),
        payment_status=Enrollment.STATUS_PAID,
    )
    return CourseReview.objects.annotate(
        has_confirmed_enrollment=Exists(paid_enrollment)
    ).filter(
        has_confirmed_enrollment=True,
        status=CourseReview.STATUS_APPROVED,
    )


def confirmed_reviews_for_course(course):
    """Return the shared review pool for every batch in a course category."""
    return confirmed_review_queryset().filter(course__category=course.category)


def annotate_shared_review_metrics(queryset):
    """Attach category-wide rating metrics to each course in a catalog queryset."""
    metrics = (
        confirmed_review_queryset()
        .filter(course__category=OuterRef("category"))
        .order_by()
        .values("course__category")
        .annotate(
            shared_average_rating=Avg("rating"),
            shared_review_count=Count("pk"),
        )
    )
    return queryset.annotate(
        average_rating=Subquery(metrics.values("shared_average_rating")[:1]),
        review_count=Subquery(metrics.values("shared_review_count")[:1]),
    )
