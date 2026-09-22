from django.db.models import Avg, Case, Count, Exists, IntegerField, OuterRef, Subquery, Value, When

from .access import active_enrollment_q
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
    return confirmed_review_queryset().filter(course__category=course.category).select_related("student")


def active_review_course_for_user(user, course, *, for_update=False):
    """Return an enrolled course that can verify a review for this training track."""
    if not user or not getattr(user, "is_authenticated", False):
        return None

    enrollments = (
        Enrollment.objects.filter(user=user, course__category=course.category)
        .filter(active_enrollment_q())
        .select_related("course")
        .order_by(
            Case(
                When(course_id=course.pk, then=Value(0)),
                default=Value(1),
                output_field=IntegerField(),
            ),
            "-enrolled_at",
            "-pk",
        )
    )
    if for_update:
        enrollments = enrollments.select_for_update()
    enrollment = enrollments.first()
    return enrollment.course if enrollment else None


def student_review_for_course_track(user, course, *, for_update=False):
    """Return a student's single review shared by every batch in the track."""
    reviews = CourseReview.objects.filter(
        student=user,
        course__category=course.category,
    ).order_by("-created_at", "-pk")
    if for_update:
        reviews = reviews.select_for_update()
    return reviews.first()


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
