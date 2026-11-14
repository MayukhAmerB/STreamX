"""Console Admin › Today › Activity (plan §4.3): what admins changed, newest
first. OWNER: WS-G.

``GET /api/admin/activity/?group=&before=<id>&limit=``

Reads Django's ``LogEntry`` (written by the back office, by the Console
services in this app, by ``enrollment_actions`` and by feature switches via
``apps.core.features.set_feature``), so both admin rooms share one history.
Entries are grouped with the same 8 job groups as the admin navigation.
"""

from __future__ import annotations

from django.contrib.admin.models import ADDITION, CHANGE, DELETION, LogEntry
from django.urls import NoReverseMatch, reverse

from apps.core.errors import ValidationFailed

DEFAULT_LIMIT = 30
MAX_LIMIT = 100
HOME_LIMIT = 8

GROUPS = (
    ("today", "Today"),
    ("live", "Live classes"),
    ("content", "Content"),
    ("students", "Students & sales"),
    ("assessments", "Assessments"),
    ("community", "Community"),
    ("settings", "Settings"),
    ("system", "System"),
)
GROUP_LABELS = dict(GROUPS)

# (app_label, model) → group; an app_label alone is the fallback for its models.
_MODEL_GROUPS = {
    ("courses", "course"): "content",
    ("courses", "section"): "content",
    ("courses", "lecture"): "content",
    ("courses", "guidevideo"): "content",
    ("courses", "liveclass"): "live",
    ("courses", "enrollment"): "students",
    ("courses", "liveclassenrollment"): "students",
    ("courses", "publicenrollmentlead"): "students",
    ("courses", "pentestingapplication"): "students",
    ("courses", "lecturequestion"): "community",
    ("courses", "coursereview"): "community",
    ("courses", "lecturecomment"): "community",
    ("courses", "enrollmentrequestnotification"): "community",
    ("realtime", "classrecording"): "content",
    ("realtime", "realtimesessionrecording"): "content",
    ("realtime", "realtimeconfiguration"): "settings",
    ("realtime", "serverresourceprofile"): "live",
    ("core", "featureflag"): "settings",
    ("core", "featureflagchange"): "settings",
    ("users", "user"): "students",
    ("users", "authconfiguration"): "settings",
    ("users", "asyncjob"): "system",
}
_APP_GROUPS = {
    "realtime": "live",
    "recording_uploads": "content",
    "payments": "students",
    "join_requests": "students",
    "campaigns": "settings",
    "reports": "assessments",
    "ctf": "assessments",
    "notifications": "community",
    "site_media": "settings",
    "national_desk": "settings",
    "social_accounts": "settings",
    "core": "system",
    "users": "system",
    "authtoken": "system",
    "token_blacklist": "system",
    "auth": "system",
}
_FLAG_WORDS = {ADDITION: "added", CHANGE: "changed", DELETION: "deleted"}


def sees_everyone(user) -> bool:
    """Superusers and ``admin.view_logentry`` see every admin's changes;
    other staff see their own (like Django's "My actions")."""
    return bool(user and (user.is_superuser or user.has_perm("admin.view_logentry")))


def group_for(app_label: str, model: str) -> str:
    return _MODEL_GROUPS.get((app_label, model)) or _APP_GROUPS.get(app_label) or "system"


def _models_in(group: str):
    """(app_label, model) pairs and whole apps that belong to ``group``."""
    pairs = [pair for pair, value in _MODEL_GROUPS.items() if value == group]
    apps = [app for app, value in _APP_GROUPS.items() if value == group]
    excluded = [pair for pair, value in _MODEL_GROUPS.items() if value != group and pair[0] in apps]
    return pairs, apps, excluded


def _href(entry) -> str:
    if entry.action_flag == DELETION or not entry.content_type_id or not entry.object_id:
        return ""
    try:
        return reverse(
            f"admin:{entry.content_type.app_label}_{entry.content_type.model}_change", args=[entry.object_id]
        )
    except NoReverseMatch:
        return ""


def _actor(entry) -> dict:
    user = entry.user
    return {"id": user.pk, "name": getattr(user, "full_name", "") or user.email, "email": user.email}


def serialize(entry) -> dict:
    content_type = entry.content_type
    app_label = getattr(content_type, "app_label", "")
    model = getattr(content_type, "model", "")
    model_class = content_type.model_class() if content_type else None
    verbose = str(model_class._meta.verbose_name) if model_class else model
    group = group_for(app_label, model)
    try:
        message = entry.get_change_message()
    except Exception:  # noqa: BLE001 - malformed legacy JSON
        message = str(entry.change_message or "")
    return {
        "id": entry.pk,
        "at": entry.action_time.isoformat(),
        "action": _FLAG_WORDS.get(entry.action_flag, "changed"),
        "actor": _actor(entry),
        "object": entry.object_repr,
        "model": verbose[:1].upper() + verbose[1:] if verbose else "",
        "group": group,
        "group_label": GROUP_LABELS[group],
        "message": message,
        "href": _href(entry),
    }


def recent(user, *, group: str = "", before=None, limit: int = DEFAULT_LIMIT) -> dict:
    from django.db.models import Q

    if group and group not in GROUP_LABELS:
        raise ValidationFailed(details={"group": ["Unknown group."]})
    try:
        limit = max(1, min(MAX_LIMIT, int(limit or DEFAULT_LIMIT)))
        before = int(before) if before not in (None, "") else None
    except (TypeError, ValueError) as exc:
        raise ValidationFailed(details={"before": ["Must be a whole number."]}) from exc
    queryset = LogEntry.objects.select_related("user", "content_type").order_by("-pk")
    if not sees_everyone(user):
        queryset = queryset.filter(user_id=getattr(user, "pk", None))
    if before is not None:
        queryset = queryset.filter(pk__lt=before)
    if group:
        pairs, apps, excluded = _models_in(group)
        condition = Q(pk__in=[])
        for app_label, model in pairs:
            condition |= Q(content_type__app_label=app_label, content_type__model=model)
        if apps:
            app_condition = Q(content_type__app_label__in=apps)
            for app_label, model in excluded:
                app_condition &= ~Q(content_type__app_label=app_label, content_type__model=model)
            condition |= app_condition
        queryset = queryset.filter(condition)
    rows = list(queryset[: limit + 1])
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "results": [serialize(entry) for entry in rows],
        "next_before": rows[-1].pk if (more and rows) else None,
        "group": group,
        "scope": "everyone" if sees_everyone(user) else "mine",
        "groups": [{"key": key, "label": label} for key, label in GROUPS if key != "today"],
    }
