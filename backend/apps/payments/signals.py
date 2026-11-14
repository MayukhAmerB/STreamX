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


# --- Public catalogue cache (WS catalog-plans) -------------------------------
def _connect_catalog_invalidation():
    from django.db.models.signals import m2m_changed, post_delete, post_save

    from apps.courses.catalog_api import bump_catalog_version

    from .models import MembershipBundle, PlatformPlan

    for model in (PlatformPlan, MembershipBundle):
        post_save.connect(bump_catalog_version, sender=model, dispatch_uid=f"catalog-bump-save-{model.__name__}")
        post_delete.connect(bump_catalog_version, sender=model, dispatch_uid=f"catalog-bump-del-{model.__name__}")
    for through in (PlatformPlan.courses.through, MembershipBundle.courses.through):
        m2m_changed.connect(bump_catalog_version, sender=through, dispatch_uid=f"catalog-bump-m2m-{through.__name__}")


_connect_catalog_invalidation()


@receiver(post_save, sender=Course, dispatch_uid="payments.grant_platform_plan_courses")
def grant_platform_plan_courses(sender, instance, **kwargs):
    """A Pentesting course published later reaches Lifetime holders (``include_future``)."""
    if kwargs.get("raw") or not (instance.is_published and instance.category == Course.CATEGORY_WEB_PENTESTING):
        return
    from .models import PlatformGrant

    if not PlatformGrant.objects.filter(is_active=True, plan__include_future=True, plan__kind="one_time").exists():
        return
    course_id = instance.pk

    def _grant():
        from .platform_orders import grant_course_to_plan_holders

        grant_course_to_plan_holders(Course.objects.get(pk=course_id))

    transaction.on_commit(_grant)
