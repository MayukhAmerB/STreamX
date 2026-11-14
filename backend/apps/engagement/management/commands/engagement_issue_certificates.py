"""Issue certificates (reference numbers) for earned items that have none yet:
achievements, and Monthly CTF finalist certificates (rewards of kind ``certificate``).

New items are certified as they are granted; this covers the rows created
before certificates existed. Safe to run twice and while the site is live (one
short transaction per item, race-safe issuing). It does not depend on the
``engagement`` switch: it only certifies what was already earned.

    python manage.py engagement_issue_certificates            # dry run: counts only
    python manage.py engagement_issue_certificates --apply
"""

from django.core.management.base import BaseCommand

from apps.engagement.certificates import _ctf_certificate_rewards, ensure_for_achievement, ensure_for_ctf_reward
from apps.engagement.models import Achievement


class Command(BaseCommand):
    help = "Issue certificates for achievements and Monthly CTF finalist rewards that have none (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Write the certificates (default: count only).")
        parser.add_argument("--limit", type=int, default=0, help="Stop after this many (0 = all).")

    def handle(self, *args, apply=False, limit=0, **options):
        achievements = Achievement.objects.filter(certificate__isnull=True).order_by("earned_at", "id")
        rewards = _ctf_certificate_rewards().filter(engagement_certificate__isnull=True).order_by("starts_at", "id")
        counts = (achievements.count(), rewards.count())
        if not apply:
            self.stdout.write(
                f"{counts[0]} achievement(s) and {counts[1]} Monthly CTF certificate reward(s) have no certificate. "
                "Run with --apply to issue them."
            )
            return
        issued = 0
        for source, ensure in ((achievements, ensure_for_achievement), (rewards, ensure_for_ctf_reward)):
            for row in source.iterator(chunk_size=500):
                if limit and issued >= limit:
                    break
                certificate = ensure(row)
                issued += 1
                if issued % 500 == 0:
                    self.stdout.write(f"... {issued} issued (last {certificate.reference})")
        self.stdout.write(self.style.SUCCESS(f"Issued {issued} certificate(s) of {sum(counts)} pending."))
