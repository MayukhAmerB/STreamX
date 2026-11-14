"""Feature switch for student profiles (autodiscovered by ``apps.core``).

``public_profiles`` ships ON (owner decision: on from release day). Off =>
every ``/api/profiles/*`` endpoint answers 403 ``feature_disabled`` and the
editor and the ``/u/<handle>`` page show the reason. Stored profiles are kept.
Profiles stay private until their owner publishes them.
"""

from apps.core.features import GROUP_SETTINGS, Feature, register_feature


def _impact() -> dict[str, int]:
    from django.apps import apps as django_apps

    try:
        profile_model = django_apps.get_model("profiles", "StudentProfile")
        report_model = django_apps.get_model("profiles", "ProfileReport")
        return {
            "published_profiles": profile_model.objects.filter(published_at__isnull=False, status="active").count(),
            "open_reports": report_model.objects.filter(status="open").count(),
        }
    except Exception:  # noqa: BLE001 - informative only
        return {}


PUBLIC_PROFILES = register_feature(
    Feature(
        key="public_profiles",
        label="Student profiles",
        summary=(
            "Students build a public profile page (/u/handle) with a bio, badges, skills, write-ups, images and links. "
            "Personal details are blocked before publishing."
        ),
        group=GROUP_SETTINGS,
        audience="students",
        default=True,  # owner decision: on from release day
        disabled_reason="Student profiles are coming soon.",
        notices=(
            "When off: profile pages and the profile editor show 'coming soon' · "
            "Saved profiles are kept · Teachers and admins: not affected"
        ),
        impact=_impact,
    )
)
