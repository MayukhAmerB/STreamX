from django import template
from django.db import DatabaseError, OperationalError

from apps.courses.models import PublicEnrollmentLead

register = template.Library()


@register.simple_tag(takes_context=True)
def get_recent_enrollment_leads(context, limit=12):
    request = context.get("request")
    user = getattr(request, "user", None)
    if not user or not user.is_authenticated:
        return []
    if not user.is_superuser and not user.has_perm("courses.view_publicenrollmentlead"):
        return []
    try:
        return list(
            PublicEnrollmentLead.objects.select_related("course", "live_class")
            .order_by("-created_at")[: int(limit)]
        )
    except (OperationalError, DatabaseError, ValueError, TypeError):
        return []
