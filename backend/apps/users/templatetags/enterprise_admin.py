"""Admin shell helpers: group installed apps into areas and pick Carbon icons."""

from django import template

register = template.Library()

# Areas shown in the sidebar and on the overview, in order. Apps not listed
# fall into "More" so a newly added app is never hidden.
AREAS = (
    ("Learning", ("courses",)),
    ("Live classes", ("realtime",)),
    ("Payments", ("payments",)),
    ("People", ("users", "join_requests", "authtoken", "token_blacklist", "auth")),
    ("Outreach", ("campaigns", "social_accounts", "notifications")),
    ("Public services", ("national_desk",)),
)

APP_ICONS = {
    "courses": "education",
    "realtime": "video",
    "payments": "wallet",
    "users": "user-multiple",
    "auth": "user-multiple",
    "join_requests": "user-follow",
    "authtoken": "password",
    "token_blacklist": "password",
    "campaigns": "bullhorn",
    "social_accounts": "share",
    "notifications": "notification",
    "national_desk": "scales",
}


@register.filter
def app_icon(app_label):
    return APP_ICONS.get(str(app_label or ""), "catalog")


@register.simple_tag
def enterprise_nav_groups(available_apps, current_path=""):
    """Group admin apps into ordered areas and mark the current app and model."""
    path = str(current_path or "")
    by_label = {}
    for app in available_apps or []:
        models = []
        for model in app.get("models", []):
            url = model.get("admin_url") or ""
            models.append({**model, "is_current": bool(url) and path.startswith(url)})
        app_url = app.get("app_url") or ""
        by_label[app.get("app_label")] = {
            **app,
            "icon": app_icon(app.get("app_label")),
            "models": models,
            "is_current": bool(app_url) and path.startswith(app_url),
        }

    groups, placed = [], set()
    for title, labels in AREAS:
        apps = [by_label[label] for label in labels if label in by_label]
        if apps:
            groups.append({"title": title, "apps": apps})
            placed.update(app["app_label"] for app in apps)
    rest = [app for label, app in by_label.items() if label not in placed]
    if rest:
        groups.append({"title": "More", "apps": rest})
    return groups


@register.simple_tag(takes_context=True)
def enterprise_queue_counts(context):
    """Items waiting for an admin, limited to what the viewer may see."""
    from django.db import DatabaseError

    from apps.courses.models import Enrollment, LiveClassEnrollment
    from apps.join_requests.models import JoinApplication

    request = context.get("request")
    user = getattr(request, "user", None)
    if not user or not user.is_authenticated:
        return {}
    queries = {
        "courses": ("courses.view_enrollment", lambda: Enrollment.objects.filter(payment_status=Enrollment.STATUS_PENDING)),
        "live_classes": (
            "courses.view_liveclassenrollment",
            lambda: LiveClassEnrollment.objects.filter(status=LiveClassEnrollment.STATUS_PENDING),
        ),
        "join_forms": ("join_requests.view_joinapplication", lambda: JoinApplication.objects.filter(status=JoinApplication.STATUS_NEW)),
    }
    counts = {}
    for key, (permission, queryset) in queries.items():
        if not user.has_perm(permission):
            continue
        try:
            counts[key] = queryset().count()
        except DatabaseError:
            counts[key] = None
    return counts
