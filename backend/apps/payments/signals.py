from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.courses.models import Course

from .batch_pass import grant_course_to_pass_holders


@receiver(post_save, sender=Course, dispatch_uid="payments.grant_batch_pass_courses")
def grant_batch_pass_courses(sender, instance, **kwargs):
    if kwargs.get("raw") or not (instance.included_in_batch_pass and instance.is_published):
        return
    course_id = instance.pk
    transaction.on_commit(lambda: grant_course_to_pass_holders(Course.objects.get(pk=course_id)))
