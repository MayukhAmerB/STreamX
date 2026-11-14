"""Feature switches owned by the courses app (autodiscovered by ``CoreConfig.ready``).

``pentesting``: master gate for every NEW acquisition of a Pentesting
(``category=web_pentesting``) course: create-order, free enrol, application,
live-class enrol, enrolment lead, platform orders and subscriptions that
include Pentesting courses. Browsing (list, detail, module outline) always
stays open. Off never revokes access somebody already has, and never blocks
verification or webhooks of an order that already exists (money may have been
captured).
"""

from __future__ import annotations

from apps.core.features import GROUP_SETTINGS, Feature, register_feature

PENTESTING_FEATURE_KEY = "pentesting"
AUDIENCE_EVERYONE = "everyone"


def _pentesting_impact() -> dict[str, int]:
    from django.apps import apps as django_apps

    course_model = django_apps.get_model("courses", "Course")
    pentesting = course_model.objects.filter(category="web_pentesting", is_published=True)
    try:
        from apps.payments.plans import enabled_plan_ids

        ready = 0
        waiting = 0
        for course in pentesting.filter(launch_status="live", registration_closed=False).iterator():
            if enabled_plan_ids(course):
                ready += 1
            else:
                waiting += 1
    except Exception:  # noqa: BLE001 - informative only
        ready = waiting = 0
    return {
        "pentesting_courses": pentesting.count(),
        "ready_to_sell": ready,
        "waiting_for_price": waiting,
    }


PENTESTING = register_feature(
    Feature(
        key=PENTESTING_FEATURE_KEY,
        label="Pentesting section",
        summary=(
            "Lets visitors enrol in, buy or subscribe to Pentesting courses and plans. "
            "Browsing stays open while it is off."
        ),
        group=GROUP_SETTINGS,
        audience=AUDIENCE_EVERYONE,
        default=False,
        disabled_reason="Pentesting is coming soon. You can browse every course now; enrolment opens at launch.",
        notices=(
            "When off: every Pentesting buy, enrol and subscribe button is greyed out with this reason · "
            "Browsing stays open · Students who already have access keep it"
        ),
        impact=_pentesting_impact,
    )
)


def pentesting_enabled() -> bool:
    from apps.core import features

    return features.is_enabled(PENTESTING_FEATURE_KEY)


def is_pentesting_course(course) -> bool:
    return str(getattr(course, "category", "") or "") == "web_pentesting"


def pentesting_gate_error():
    """``FeatureDisabled`` (403 ``feature_disabled``) carrying the reason twice (detail + reason)."""
    from apps.core import features
    from apps.core.errors import FeatureDisabled

    reason = features.reason_for(PENTESTING_FEATURE_KEY)
    features.disabled_error(PENTESTING_FEATURE_KEY)  # logs the refusal
    return FeatureDisabled(reason, details={"feature": PENTESTING_FEATURE_KEY, "reason": reason})


def course_acquisition_blocked(course) -> bool:
    """True when ``course`` is a Pentesting course and the switch is off."""
    return is_pentesting_course(course) and not pentesting_enabled()


def require_course_acquisition(course) -> None:
    if course_acquisition_blocked(course):
        raise pentesting_gate_error()


# ---------------------------------------------------------------------------
# Public purchase gate of one course (contract §1 CourseCard.purchase / §2)
# ---------------------------------------------------------------------------
PURCHASE_AVAILABLE = "available"
PURCHASE_COMING_SOON = "coming_soon"
PURCHASE_UNAVAILABLE = "unavailable"
_COMING_SOON_BLOCKS = {"feature_disabled", "course_not_live"}


def purchase_gate(course, *, block=None) -> dict:
    """``{state, code, reason}`` for buying / enrolling in ``course`` now.

    ``state`` is ``available`` (the buttons work), ``coming_soon`` (the
    Pentesting switch is off or the course is not live yet) or
    ``unavailable`` (registration closed, no price, checkout off ...). The UI
    disables, never hides, the action and shows ``reason``.
    """
    from apps.payments.plans import course_block_message, course_purchase_block

    code = course_purchase_block(course) if block is None else block
    if not code:
        return {"state": PURCHASE_AVAILABLE, "code": "", "reason": ""}
    state = PURCHASE_COMING_SOON if code in _COMING_SOON_BLOCKS else PURCHASE_UNAVAILABLE
    return {"state": state, "code": code, "reason": course_block_message(code)}
