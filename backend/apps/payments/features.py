"""Feature switches owned by the payments app (autodiscovered by ``CoreConfig.ready``).

* ``memberships``: creating any Razorpay subscription (CTF Labs membership,
  Starter plans, Pentesting membership). Off never cancels or shortens a
  subscription that already exists and never blocks its webhooks.
* ``labs_membership_required``: labs.alsyedinitiative.com requires LMS sign-in
  and an active ``ctf_labs`` / ``ctf_starter`` entitlement. Off = the labs are
  exactly as open as before this switch existed.
"""

from __future__ import annotations

from apps.core.features import GROUP_SETTINGS, Feature, register_feature

MEMBERSHIPS_FEATURE_KEY = "memberships"
LABS_MEMBERSHIP_FEATURE_KEY = "labs_membership_required"


def _memberships_impact() -> dict[str, int]:
    from django.apps import apps as django_apps
    from django.utils import timezone

    plan_model = django_apps.get_model("payments", "PlatformPlan")
    subscription_model = django_apps.get_model("payments", "PlatformSubscription")
    return {
        "plans_confirmed": plan_model.objects.filter(kind="subscription", price_confirmed_at__isnull=False).count(),
        "plans_waiting_for_price": plan_model.objects.filter(kind="subscription", price_confirmed_at__isnull=True).count(),
        "active_subscriptions": subscription_model.objects.filter(access_until__gt=timezone.now()).count(),
    }


def _labs_impact() -> dict[str, int]:
    from django.apps import apps as django_apps
    from django.utils import timezone

    subscription_model = django_apps.get_model("payments", "PlatformSubscription")
    grant_model = django_apps.get_model("payments", "PlatformGrant")
    now = timezone.now()
    members = set(
        subscription_model.objects.filter(
            access_until__gt=now, plan__product__in=("ctf_labs", "ctf_starter")
        ).values_list("user_id", flat=True)
    )
    members.update(
        grant_model.objects.filter(is_active=True, plan__product__in=("ctf_labs", "ctf_starter"))
        .exclude(expires_at__lte=now)
        .values_list("user_id", flat=True)
    )
    return {"members_with_access": len(members)}


MEMBERSHIPS = register_feature(
    Feature(
        key=MEMBERSHIPS_FEATURE_KEY,
        label="Memberships (Razorpay Subscriptions)",
        summary=(
            "Lets signed-in students start a monthly subscription: CTF Labs membership, Starter plans "
            "and the Pentesting membership. Each plan also needs a confirmed price."
        ),
        group=GROUP_SETTINGS,
        audience="everyone",
        default=False,
        disabled_reason="Monthly memberships are not open yet.",
        notices=(
            "When off: subscribe buttons are greyed out with this reason · "
            "Existing members keep access until their paid period ends"
        ),
        impact=_memberships_impact,
    )
)

LABS_MEMBERSHIP = register_feature(
    Feature(
        key=LABS_MEMBERSHIP_FEATURE_KEY,
        label="Labs: members only",
        summary=(
            "labs.alsyedinitiative.com asks visitors to sign in and checks their membership: CTF Labs members "
            "open every lab, Starter members the easy and medium challenges. Staff always get in."
        ),
        group=GROUP_SETTINGS,
        audience="everyone",
        default=False,
        disabled_reason="The labs are open to everyone right now.",
        notices=(
            "When on: visitors without a membership see a sign-in / join page instead of the labs · "
            "When off: the labs are open to everyone, as before"
        ),
        impact=_labs_impact,
    )
)


def memberships_enabled() -> bool:
    from apps.core import features

    return features.is_enabled(MEMBERSHIPS_FEATURE_KEY)


def labs_membership_required() -> bool:
    from apps.core import features

    return features.is_enabled(LABS_MEMBERSHIP_FEATURE_KEY)


def gate_error(key: str):
    """``FeatureDisabled`` for ``key`` with ``errors.reason`` (contract §0)."""
    from apps.core import features
    from apps.core.errors import FeatureDisabled

    reason = features.reason_for(key)
    features.disabled_error(key)
    return FeatureDisabled(reason, details={"feature": key, "reason": reason})
