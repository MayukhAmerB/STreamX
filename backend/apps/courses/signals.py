from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from .cache_utils import bump_course_list_cache_version
from .experience_models import CourseReview
from .models import Enrollment, Lecture, Section


@receiver(post_save, sender=CourseReview)
@receiver(post_delete, sender=CourseReview)
@receiver(post_save, sender=Enrollment)
@receiver(post_delete, sender=Enrollment)
def invalidate_course_review_metrics(**_kwargs):
    """Keep verified catalog ratings fresh after review or access changes."""
    bump_course_list_cache_version()


@receiver(post_save, sender=Section)
@receiver(post_save, sender=Lecture)
def invalidate_course_structure_on_create(*, created, **_kwargs):
    if created:
        bump_course_list_cache_version()


@receiver(post_delete, sender=Section)
@receiver(post_delete, sender=Lecture)
def invalidate_course_structure_on_delete(**_kwargs):
    bump_course_list_cache_version()
