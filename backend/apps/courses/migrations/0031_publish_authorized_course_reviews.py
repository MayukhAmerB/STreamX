from django.db import migrations, models
from django.db.models import Q
from django.utils import timezone


def publish_authorized_pending_reviews(apps, schema_editor):
    CourseReview = apps.get_model("courses", "CourseReview")
    Enrollment = apps.get_model("courses", "Enrollment")
    now = timezone.now()
    active_enrollments = Enrollment.objects.filter(payment_status="paid").filter(
        Q(access_type__in=("legacy", "lifetime"))
        | Q(access_type="installment", access_expires_at__gt=now)
    )
    eligible_pairs = set(active_enrollments.values_list("user_id", "course_id"))
    review_ids = [
        review.pk
        for review in CourseReview.objects.filter(status="pending").only(
            "pk", "student_id", "course_id"
        )
        if (review.student_id, review.course_id) in eligible_pairs
    ]
    if review_ids:
        CourseReview.objects.filter(pk__in=review_ids).update(status="approved")


class Migration(migrations.Migration):
    dependencies = [
        ("courses", "0030_mark_pentesting_program_coming_soon"),
    ]

    operations = [
        migrations.RunPython(
            publish_authorized_pending_reviews,
            migrations.RunPython.noop,
        ),
        migrations.AlterField(
            model_name="coursereview",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "Pending"),
                    ("approved", "Published"),
                    ("hidden", "Hidden"),
                ],
                default="approved",
                max_length=12,
            ),
        ),
    ]
