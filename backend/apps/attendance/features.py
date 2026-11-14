"""Feature switch for attendance and the class calendar (autodiscovered by ``apps.core``).

``attendance`` ships ON. Off => every ``/api/attendance/*`` and
``/api/calendar/*`` endpoint answers 403 ``feature_disabled`` (the public
upcoming-classes list answers an empty list), presence and join events are
not recorded, sessions are not finalised and schedules are not materialised.
Stored attendance and schedules are kept; switching it back on resumes (the
finalise sweep catches up on classes that ended in the last 72 hours).
"""

from apps.core.features import GROUP_SETTINGS, Feature, register_feature

from .conf import FEATURE_KEY


def _impact() -> dict[str, int]:
    from django.apps import apps as django_apps

    try:
        schedule_model = django_apps.get_model("attendance", "ClassSchedule")
        session_model = django_apps.get_model("realtime", "RealtimeSession")
        return {
            "active_schedules": schedule_model.objects.filter(is_active=True).count(),
            "live_now": session_model.objects.filter(status="live").count(),
        }
    except Exception:  # noqa: BLE001 - informative only
        return {}


ATTENDANCE = register_feature(
    Feature(
        key=FEATURE_KEY,
        label="Attendance & class calendar",
        summary=(
            "Records live-class attendance (present = 40+ minutes live), shows students their attendance and "
            "class calendar, and builds upcoming classes from each batch's schedule."
        ),
        group=GROUP_SETTINGS,
        audience="students",
        default=True,  # owner decision: on from day one
        disabled_reason="Attendance and the class calendar are switched off for now.",
        notices=(
            "When off: attendance is not recorded, the Attendance and Calendar pages are hidden and schedules stop "
            "creating classes · Stored attendance is kept · Live classes themselves are not affected"
        ),
        impact=_impact,
    )
)
