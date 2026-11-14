"""Feature switches of the CTF app (autodiscovered by ``CoreConfig.ready``).

``monthly_ctf``: the free Monthly OSINT CTF (seasons, leaderboard, rewards).
Ships ON (owner decision: rewards from release day). With no season scheduled
the pages say the next case is being prepared; seasons are created and
scheduled in the admin (``python manage.py ctf_first_season`` reports the state).
Off => every ``/api/ctf/seasons/*`` endpoint answers
403 ``feature_disabled``, the scheduler neither opens, closes nor finalises
seasons, and active cosmetics are not shown. Stored seasons, entries and
rewards are kept, so switching it back on resumes exactly where it stopped.
"""

from apps.core.features import GROUP_SETTINGS, Feature, register_feature

FEATURE_KEY = "monthly_ctf"


def _impact():
    from django.utils import timezone

    from .season_models import CtfSeason, CtfSeasonReward

    now = timezone.now()
    try:
        scheduled = CtfSeason.objects.filter(
            status__in=(CtfSeason.STATUS_SCHEDULED, CtfSeason.STATUS_OPEN), closes_at__gt=now
        ).count()
        auras = (
            CtfSeasonReward.objects.filter(
                kind__in=CtfSeasonReward.COSMETIC_KINDS, revoked_at__isnull=True, starts_at__lte=now, ends_at__gt=now
            )
            .values("user_id")
            .distinct()
            .count()
        )
    except Exception:  # noqa: BLE001 - informative only
        scheduled, auras = 0, 0
    return {"seasons_scheduled_or_open": scheduled, "members_with_active_cosmetics": auras}


MONTHLY_CTF = register_feature(
    Feature(
        key=FEATURE_KEY,
        label="Monthly OSINT CTF",
        summary=(
            "One free OSINT challenge every month for every registered student, with its own leaderboard "
            "and automatic rewards (Golden Aura, podium frames, trophies, Finalist certificates, XP)."
        ),
        group=GROUP_SETTINGS,
        audience="students",
        default=True,  # owner decision: on from release day
        disabled_reason="The Monthly CTF is not open yet.",
        notices=(
            "When off: the Monthly CTF pages and rewards are hidden and seasons do not open, close or finalise · "
            "Seasons, solves and rewards already stored are kept · Labs and exams: not affected"
        ),
        impact=_impact,
    )
)
