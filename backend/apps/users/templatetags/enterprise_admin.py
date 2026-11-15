"""Al Syed Admin (Django back office) shell helpers (UI plan §4.2, §4.8).

* ``JOB_GROUPS`` / ``MODEL_JOBS``: the job-based navigation shared with the
  Console Admin workspace. Every registered model is placed in one of the 8
  groups by ``app_label.model_name`` (not by app), with a friendly label. A
  model missing from ``MODEL_JOBS`` lands in "Not grouped yet", which
  ``tests/test_admin_nav_groups.py`` keeps empty.
* ``enterprise_nav_groups``: the sidebar / index structure for the viewer.
* ``enterprise_attention``: the index's attention queues, from the same
  service as ``GET /api/admin/attention/`` (``apps.console_api.attention``).
* ``enterprise_console_home``: the "daily work lives in Console" banner for
  screens that have a Console equivalent (decision D4: they stay editable).
* ``enterprise_model_title``: plain page titles ("Payments", not "Select
  payment to change").
"""

from __future__ import annotations

import logging
from datetime import datetime

from django import template
from django.conf import settings
from django.urls import NoReverseMatch, reverse
from django.utils import timezone
from django.utils.dateparse import parse_datetime

register = template.Library()
logger = logging.getLogger(__name__)

CONSOLE_ADMIN_HREF = "/console/admin"

# ---------------------------------------------------------------- job groups
# (key, title, Carbon icon id in includes/carbon_icons.html). "today" is pinned
# above the groups in the sidebar and holds Overview and Dashboard.
JOB_GROUPS = (
    ("live", "Live classes", "video"),
    ("content", "Content", "education"),
    ("students", "Students & sales", "user-multiple"),
    ("billing", "Billing", "wallet"),
    ("assessments", "Assessments", "flag"),
    ("community", "Community", "chat"),
    ("settings", "Settings", "settings-adjust"),
    ("system", "System", "activity"),
)
UNGROUPED = ("ungrouped", "Not grouped yet", "catalog")

# app_label.model_name -> (group key, label). Order inside a group follows this
# mapping, so the most used screen of each job comes first.
MODEL_JOBS = {
    # Live classes
    "courses.liveclass": ("live", "Live classes"),
    "realtime.realtimesession": ("live", "Realtime sessions"),
    "realtime.owncastchatidentity": ("live", "Live chat moderation"),
    "realtime.realtimeconfiguration": ("live", "Live configuration"),
    "realtime.serverresourceprofile": ("live", "Server profile"),
    # Content
    "courses.course": ("content", "Courses"),
    "courses.section": ("content", "Modules"),
    "courses.lecture": ("content", "Lectures"),
    "realtime.classrecording": ("content", "Class recordings"),
    "recording_uploads.recordingupload": ("content", "Recording uploads"),
    "realtime.realtimesessionrecording": ("content", "Session recordings"),
    "courses.guidevideo": ("content", "Guide videos"),
    # Students & sales
    "courses.enrollment": ("students", "Enrolment requests"),
    "courses.liveclassenrollment": ("students", "Live-class requests"),
    "payments.payment": ("students", "Payments"),
    "payments.successfulpaymentuser": ("students", "Successful payment users"),
    "payments.batchpass": ("students", "Batch passes"),
    "users.user": ("students", "People"),
    "join_requests.joinapplication": ("students", "Join forms"),
    "courses.publicenrollmentlead": ("students", "Public leads"),
    "campaigns.campaignvolunteer": ("students", "Campaign volunteers"),
    "courses.pentestingapplication": ("students", "Pentesting applications"),
    "payments.platformplan": ("students", "Plans & prices"),
    "payments.platformsubscription": ("students", "Subscriptions"),
    "payments.platformgrant": ("students", "Plan grants"),
    "payments.membershipbundle": ("students", "Membership bundles"),
    # Billing (apps.billing): catalogue, plans, purchases, entitlements
    "billing.plan": ("billing", "Plans"),
    "billing.product": ("billing", "Products"),
    "billing.price": ("billing", "Prices"),
    "billing.purchase": ("billing", "Purchases"),
    "billing.entitlementgrant": ("billing", "Entitlement grants"),
    "billing.entitlementkey": ("billing", "Entitlement keys"),
    # Assessments
    "reports.reporttask": ("assessments", "Report tasks"),
    "reports.reportsubmission": ("assessments", "Report submissions"),
    "reports.reportsubmissionversion": ("assessments", "Submission versions"),
    "reports.reportfile": ("assessments", "Report files"),
    "reports.reportattachment": ("assessments", "Reference attachments"),
    "reports.reportgrade": ("assessments", "Report grades"),
    "reports.reportgradeaudit": ("assessments", "Grade audit log"),
    "reports.reportquarantinerecord": ("assessments", "Quarantined files"),
    "reports.reportpolicy": ("assessments", "Report policy"),
    "reports.reportnoticelog": ("assessments", "Report notices"),
    "ctf.ctfexam": ("assessments", "CTF exams"),
    "ctf.ctfparticipation": ("assessments", "CTF scores"),
    "ctf.ctfattempt": ("assessments", "CTF attempts"),
    "ctf.ctfexamresult": ("assessments", "CTF results"),
    "ctf.ctfmaterial": ("assessments", "CTF materials"),
    "osint_labs.osintchallenge": ("assessments", "Free OSINT directory"),
    "osint_labs.osintpath": ("assessments", "OSINT learning paths"),
    "osint_labs.osintchallengeprogress": ("assessments", "OSINT directory progress"),
    # Community
    "courses.lecturequestion": ("community", "Lecture questions"),
    "courses.lecturecomment": ("community", "Lecture comments"),
    "courses.coursereview": ("community", "Course reviews"),
    "notifications.notification": ("community", "Notifications"),
    "courses.enrollmentrequestnotification": ("community", "Enrolment request notifications"),
    # Settings
    "core.featureflag": ("settings", "Features"),
    "core.featureflagchange": ("settings", "Feature switch history"),
    "users.authconfiguration": ("settings", "Sign-in & registration"),
    "site_media.youtubechannel": ("settings", "YouTube channel"),
    "join_requests.joinformsettings": ("settings", "Join form settings"),
    "national_desk.nationaldesksettings": ("settings", "National Desk settings"),
    "national_desk.firfilingguide": ("settings", "National Desk: FIR guide"),
    "national_desk.lawssection": ("settings", "National Desk: Laws page"),
    "national_desk.lawtopic": ("settings", "National Desk: Law topics"),
    "national_desk.lawtopicvideo": ("settings", "National Desk: Law videos"),
    "national_desk.trackeroverview": ("settings", "National Desk: Tracker page"),
    "national_desk.trackerupdate": ("settings", "National Desk: Tracker updates"),
    "social_accounts.socialaccount": ("settings", "AS accounts"),
    "social_accounts.socialaccountcategory": ("settings", "AS account categories"),
    "campaigns.campaign": ("settings", "Campaigns"),
    "campaigns.campaignsitevisit": ("settings", "Campaign site visits"),
    # System
    "core.outboxevent": ("system", "Outbox events"),
    "users.asyncjob": ("system", "Async jobs"),
    "core.idempotencykey": ("system", "Idempotency keys"),
    "payments.paymentwebhookevent": ("system", "Webhook events"),
    "recording_uploads.recordinguploadtoken": ("system", "Upload tokens"),
    "authtoken.tokenproxy": ("system", "API tokens"),
    "authtoken.token": ("system", "API tokens"),
    "token_blacklist.outstandingtoken": ("system", "JWT tokens"),
    "token_blacklist.blacklistedtoken": ("system", "Blacklisted JWT tokens"),
    "users.usertermsstatus": ("system", "Terms acceptances"),
    "courses.lecturelike": ("system", "Lecture likes"),
    "notifications.notificationrecipient": ("system", "Notification deliveries"),
    "notifications.webpushsubscription": ("system", "Push subscriptions"),
    "auth.group": ("system", "Groups"),
    "auth.permission": ("system", "Permissions"),
}

# Screens whose daily work lives in the Console (decision D4: they stay
# editable this round, with a banner that points to the Console page).
CONSOLE_HOMES = {
    "ctf.ctfexam": ("Assessments", "Exams", "/console/admin/exams"),
    "reports.reporttask": ("Assessments", "Grading", "/console/admin/grading"),
    "realtime.classrecording": ("Content", "Recordings", "/console/admin/recordings"),
    "recording_uploads.recordinguploadtoken": ("Content", "Upload", "/console/admin/recordings/upload"),
    "courses.lecturequestion": ("Community", "Questions", "/console/admin/community?tab=questions"),
    "courses.enrollment": ("Students & sales", "Requests", "/console/admin/requests"),
    "courses.liveclassenrollment": ("Students & sales", "Requests", "/console/admin/requests"),
}

# One calm sentence per empty list: what will appear here and why.
EMPTY_STATES = {
    "payments.payment": "Payments appear here as soon as a student starts a checkout.",
    "payments.successfulpaymentuser": "Students who paid successfully appear here, ready for their login details.",
    "courses.enrollment": "Course requests from students appear here for approval.",
    "courses.liveclassenrollment": "Live-class requests from students appear here for approval.",
    "courses.course": "Create your first course to start selling and teaching it.",
    "payments.platformplan": "Plans appear here once seeded. Each one stays off until you confirm its price.",
    "payments.platformsubscription": "Monthly memberships appear here when someone subscribes.",
    "osint_labs.osintchallenge": "Free OSINT challenges appear here once you add or import them.",
    "realtime.classrecording": "Class recordings appear here after each live class ends.",
    "recording_uploads.recordingupload": "Recordings uploaded from OBS or the Console appear here.",
    "realtime.realtimesession": "Live sessions appear here when a class is scheduled or goes live.",
    "reports.reportsubmission": "Weekly report submissions appear here once students upload them.",
    "reports.reportquarantinerecord": "Nothing is quarantined. Files the antivirus blocks would appear here.",
    "ctf.ctfexam": "Import an exam from the Console to see it here.",
    "join_requests.joinapplication": "Join Al Syed forms appear here when someone applies.",
    "courses.publicenrollmentlead": "Enrolment enquiries from the website appear here.",
    "courses.lecturequestion": "Questions students ask under lectures appear here.",
    "courses.lecturecomment": "Comments students post under lectures appear here.",
    "courses.coursereview": "Course reviews appear here once students rate a course.",
    "notifications.notification": "Announcements and automatic notifications appear here.",
    "core.outboxevent": "Background events appear here. Failed ones can be retried.",
    "users.asyncjob": "Background jobs appear here while they run.",
    "realtime.owncastchatidentity": "Viewers appear here once they chat in a live class. Ban, time out or promote them from here.",
}

QUEUE_BACK_OFFICE = {
    # Attention queue -> the Django list that holds the same records.
    "enrolment_requests": ("admin:courses_enrollment_changelist", "?payment_status__exact=pending"),
    "payments_to_action": ("admin:payments_payment_changelist", ""),
    "leads": ("admin:join_requests_joinapplication_changelist", "?status__exact=new"),
    "quarantined_files": ("admin:reports_reportquarantinerecord_changelist", ""),
    "flagged_content": ("admin:courses_lecturequestion_changelist", ""),
    "recordings_to_review": ("admin:realtime_classrecording_changelist", ""),
    "uploads_failed": ("admin:recording_uploads_recordingupload_changelist", ""),
    "system_issues": ("admin:core_outboxevent_changelist", ""),
    "exams_to_publish": ("admin:ctf_ctfexam_changelist", ""),
    "reports_to_grade": ("admin:reports_reportsubmission_changelist", ""),
}

SERVER_PROFILE_OFFLINE_SECONDS = 600


def model_key(opts) -> str:
    return f"{opts.app_label}.{opts.model_name}"


def job_for(key: str):
    return MODEL_JOBS.get(key)


def job_label(opts) -> str:
    """The friendly plural name of a model (falls back to its verbose name)."""
    job = MODEL_JOBS.get(model_key(opts))
    if job:
        return job[1]
    return str(opts.verbose_name_plural)[:1].upper() + str(opts.verbose_name_plural)[1:]


def _model_entry(app, model, path):
    app_label = app.get("app_label")
    object_name = str(model.get("object_name") or "").lower()
    key = f"{app_label}.{object_name}"
    url = model.get("admin_url") or ""
    job = MODEL_JOBS.get(key)
    return key, {
        "key": key,
        "name": job[1] if job else str(model.get("name") or object_name),
        "admin_url": url,
        "add_url": model.get("add_url") or "",
        "view_only": bool(model.get("view_only")),
        "is_current": bool(url) and str(path or "").startswith(url),
    }


@register.simple_tag
def enterprise_nav_groups(available_apps, current_path=""):
    """Group the viewer's admin models into the 7 job groups (Today is pinned).

    Returns ``[{key, title, icon, models: [...], is_current, count}]`` in
    ``JOB_GROUPS`` order, plus "Not grouped yet" at the end when a model is
    missing from ``MODEL_JOBS``.
    """
    order = {key: index for index, key in enumerate(MODEL_JOBS)}
    buckets: dict[str, list] = {key: [] for key, _title, _icon in JOB_GROUPS}
    ungrouped = []
    for app in available_apps or []:
        for model in app.get("models", []):
            key, entry = _model_entry(app, model, current_path)
            job = MODEL_JOBS.get(key)
            (buckets[job[0]] if job else ungrouped).append(entry)

    groups = []
    for key, title, icon in JOB_GROUPS:
        models = sorted(buckets[key], key=lambda entry: order.get(entry["key"], 999))
        if models:
            groups.append(
                {
                    "key": key,
                    "title": title,
                    "icon": icon,
                    "models": models,
                    "count": len(models),
                    "is_current": any(entry["is_current"] for entry in models),
                }
            )
    if ungrouped:
        key, title, icon = UNGROUPED
        groups.append(
            {
                "key": key,
                "title": title,
                "icon": icon,
                "models": ungrouped,
                "count": len(ungrouped),
                "is_current": any(entry["is_current"] for entry in ungrouped),
            }
        )
    return groups


@register.simple_tag
def enterprise_section_count(groups):
    return sum(group["count"] for group in groups or [])


# ------------------------------------------------------------------- titles
def site_name() -> str:
    return getattr(settings, "ADMIN_SITE_NAME", "") or "Al Syed Admin"


@register.simple_tag
def enterprise_site_name():
    return site_name()


@register.simple_tag
def enterprise_brand():
    """The site name split for the header: ``("Al Syed", "Admin")``."""
    head, _space, tail = site_name().rpartition(" ")
    return {"head": head or tail, "tail": tail if head else ""}


@register.filter
def enterprise_model_title(opts):
    """Plain changelist title: the job label ("Live chat moderation")."""
    try:
        return job_label(opts)
    except AttributeError:
        return ""


@register.simple_tag(takes_context=True)
def enterprise_change_title(context):
    """Change form title: the object's name; "New <thing>" when adding."""
    opts = context.get("opts")
    if context.get("add"):
        name = str(getattr(opts, "verbose_name", "") or "item")
        words = name.split()
        if len(words) > 1 and all(word[:1].isupper() and word[1:].islower() for word in words):
            name = name.lower()  # "Live Class" -> "live class"; "YouTube channel" stays.
        return f"New {name}"
    original = context.get("original")
    text = " ".join(str(original if original is not None else "").split())
    if len(text) > 80:
        text = f"{text[:77]}..."
    return text or str(context.get("title") or "")


# ----------------------------------------------------------- console homes
@register.simple_tag
def enterprise_console_home(opts):
    """``{group, page, href}`` when this screen's daily work lives in the Console."""
    try:
        home = CONSOLE_HOMES.get(model_key(opts))
    except AttributeError:
        return None
    if not home:
        return None
    group, page, href = home
    return {"group": group, "page": page, "href": href}


@register.simple_tag
def enterprise_empty_state(opts):
    try:
        key = model_key(opts)
    except AttributeError:
        return ""
    sentence = EMPTY_STATES.get(key)
    if sentence:
        return sentence
    return "New entries appear here as they are created."


@register.simple_tag
def enterprise_active_filter_count(cl):
    """How many list filters are applied (search and paging do not count)."""
    try:
        return len(cl.get_filters_params())
    except Exception:  # noqa: BLE001 - a broken count must never break a list
        return 0


# ------------------------------------------------------------- course tabs
@register.filter
def enterprise_fieldset_tab(fieldset):
    """The ``tab-<key>`` class of a fieldset (course form tabs), or ""."""
    for name in str(getattr(fieldset, "classes", "") or "").split():
        if name.startswith("tab-"):
            return name[4:]
    return ""


# -------------------------------------------------------------- attention
def _age(value):
    if not value:
        return ""
    moment = value if isinstance(value, datetime) else parse_datetime(str(value))
    if not moment:
        return ""
    if timezone.is_naive(moment):
        moment = timezone.make_aware(moment)
    seconds = max(0, int((timezone.now() - moment).total_seconds()))
    if seconds < 3600:
        return f"{max(1, seconds // 60)} min"
    if seconds < 86400:
        return f"{seconds // 3600} h"
    return f"{seconds // 86400} d"


def _back_office_href(key):
    target = QUEUE_BACK_OFFICE.get(key)
    if not target:
        return ""
    name, query = target
    try:
        return reverse(name) + query
    except NoReverseMatch:
        return ""


@register.simple_tag(takes_context=True)
def enterprise_attention(context):
    """The index's attention data from ``apps.console_api.attention.get_queues``.

    Returns ``{busy: [...], clear: [labels], live_today, switches, total}``.
    Busy queues are sorted by count (busiest first; its button is the one
    champagne action on the page). A failing service shows nothing rather
    than breaking the admin home.
    """
    request = context.get("request")
    cached = getattr(request, "_enterprise_attention", None)
    if cached is not None:
        return cached
    result = _attention_for(getattr(request, "user", None))
    if request is not None:
        request._enterprise_attention = result
    return result


def _attention_for(user):
    empty = {"busy": [], "clear": [], "live_today": [], "switches": [], "total": 0, "error": False}
    if not user or not user.is_authenticated:
        return empty
    try:
        from apps.console_api.attention import get_queues

        payload = get_queues(user) or {}
    except Exception:  # noqa: BLE001 - the admin home must always render
        logger.exception("admin index: attention queues failed")
        return {**empty, "error": True}

    busy, clear = [], []
    for queue in payload.get("queues") or []:
        count = queue.get("count") or 0
        if count > 0:
            busy.append(
                {
                    **queue,
                    "age": _age(queue.get("oldest_at")),
                    "back_office_href": _back_office_href(queue.get("key")),
                }
            )
        else:
            clear.append(str(queue.get("label") or "").strip())
    busy.sort(key=lambda queue: (queue.get("severity") != "high", -(queue.get("count") or 0)))
    live_today = []
    for item in payload.get("live_today") or []:
        moment = parse_datetime(str(item.get("starts_at") or ""))
        live_today.append({**item, "starts_at_dt": timezone.localtime(moment) if moment else None})
    return {
        "busy": busy,
        "clear": [label for label in clear if label],
        "live_today": live_today,
        "switches": list(payload.get("switches") or []),
        "total": len(busy),
        "error": False,
    }


@register.simple_tag(takes_context=True)
def enterprise_greeting(context):
    request = context.get("request")
    user = getattr(request, "user", None)
    hour = timezone.localtime().hour
    part = "morning" if hour < 12 else "afternoon" if hour < 17 else "evening"
    name = " ".join(str(getattr(user, "full_name", "") or "").split()).split(" ")[0]
    return f"Good {part}, {name}" if name else f"Good {part}"


@register.simple_tag(takes_context=True)
def enterprise_greeting_parts(context):
    """The greeting split so the first name can carry the one handwritten
    accent: ``{"lead": "Good morning,", "name": "Ayesha"}``. Its text is the
    same as :func:`enterprise_greeting`."""
    text = enterprise_greeting(context)
    lead, sep, name = text.partition(", ")
    return {"lead": f"{lead}," if sep else lead, "name": name if sep else ""}


@register.simple_tag
def enterprise_home_stats(attention):
    """Cells for the Overview stat strip, from the attention payload already
    loaded for the page (no extra queries)."""
    attention = attention or {}
    switches = list(attention.get("switches") or [])
    live_today = list(attention.get("live_today") or [])
    cells = [
        {"value": attention.get("total") or 0, "label": "Need you"},
        {"value": len(live_today), "label": "Classes today"},
    ]
    if switches:
        on = sum(1 for switch in switches if switch.get("enabled"))
        cells.append({"value": f"{on}/{len(switches)}", "label": "Switches on"})
    return cells


@register.simple_tag
def enterprise_server_profile_needs_attention():
    """The server profile shows on the index only while its agent is offline
    for more than 10 minutes (or has never reported); it lives in Live
    classes otherwise."""
    try:
        from apps.realtime.models import ServerResourceProfile

        profile = ServerResourceProfile.get_solo()
    except Exception:  # noqa: BLE001
        return False
    if not profile.agent_last_seen_at:
        return True
    return (timezone.now() - profile.agent_last_seen_at).total_seconds() > SERVER_PROFILE_OFFLINE_SECONDS


# ----------------------------------------------------------- quick actions
def _safe_reverse(name, *args):
    try:
        return reverse(name, args=args)
    except NoReverseMatch:
        return ""


def quick_actions(user):
    """Static task shortcuts (index + palette), filtered by permission."""
    actions = [
        {"label": "Go live", "href": "/console/admin/classes", "hint": "Console"},
        {"label": "Upload recording", "href": "/console/admin/recordings/upload", "hint": "Console"},
    ]
    if user.has_perm("courses.add_liveclass"):
        actions.append({"label": "New live class", "href": _safe_reverse("admin:courses_liveclass_add"), "hint": "Back office"})
    actions.append({"label": "Import exam", "href": "/console/admin/exams", "hint": "Console"})
    if user.has_perm("reports.add_reporttask"):
        actions.append({"label": "New report task", "href": _safe_reverse("admin:reports_reporttask_add"), "hint": "Back office"})
    features_href = _safe_reverse("admin-settings-features")
    if features_href:
        actions.append({"label": "Turn features on or off", "href": features_href, "hint": "Settings"})
    return [action for action in actions if action["href"]]


@register.simple_tag(takes_context=True)
def enterprise_quick_actions(context):
    request = context.get("request")
    user = getattr(request, "user", None)
    if not user or not user.is_authenticated:
        return []
    return quick_actions(user)


@register.simple_tag(takes_context=True)
def enterprise_palette_data(context, available_apps):
    """Static palette entries: tasks and every section the viewer can open."""
    request = context.get("request")
    user = getattr(request, "user", None)
    if not user or not user.is_authenticated:
        return {"actions": [], "destinations": []}
    tasks = [{"label": action["label"], "href": action["href"], "hint": action["hint"]} for action in quick_actions(user)]
    tasks.append({"label": "Open the Console admin", "href": CONSOLE_ADMIN_HREF, "hint": "Console"})
    destinations = [{"label": "Overview", "href": reverse("admin:index"), "hint": "Today"}]
    dashboard = _safe_reverse("insights-dashboard")
    if dashboard and user.is_superuser:
        destinations.append({"label": "Dashboard", "href": dashboard, "hint": "Today"})
    for group in enterprise_nav_groups(available_apps):
        for model in group["models"]:
            if model["admin_url"]:
                destinations.append({"label": model["name"], "href": model["admin_url"], "hint": group["title"]})
    return {"actions": tasks, "destinations": destinations}


@register.simple_tag
def enterprise_admin_tokens_href():
    """URL of the generated ``admin-tokens.css`` (WS-A), or "" while it does not
    exist yet. ``enterprise.css`` carries fallback values for every token."""
    from django.contrib.staticfiles import finders
    from django.templatetags.static import static

    name = "admin/css/admin-tokens.css"
    try:
        if settings.DEBUG and not finders.find(name):
            return ""
        return static(name)
    except ValueError:  # not in the manifest (collectstatic ran before it existed)
        return ""
    except Exception:  # noqa: BLE001
        return ""


@register.simple_tag
def enterprise_tab_label(model_admin, key):
    for tab_key, label in getattr(model_admin, "form_tabs", ()) or ():
        if tab_key == key:
            return label
    return ""
