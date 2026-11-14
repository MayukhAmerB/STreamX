"""Rebuild the Redis leaderboard sorted sets from ``EngagementSummary``.

    python manage.py engagement_rebuild_leaderboards            # every batch
    python manage.py engagement_rebuild_leaderboards --batch 12 --batch 15

Safe at any time (each set is built in a temporary key and swapped in with
RENAME). Without Redis there is nothing to rebuild: the database answers.
"""

from django.core.management.base import BaseCommand

from apps.engagement import leaderboard
from apps.engagement.buffer import redis_client


class Command(BaseCommand):
    help = "Rebuild engagement leaderboards (Redis sorted sets) from the summary table."

    def add_arguments(self, parser):
        parser.add_argument("--batch", type=int, action="append", help="Course (batch) id; repeat for several.")

    def handle(self, *args, **options):
        if redis_client() is None:
            self.stdout.write("No Redis cache configured: leaderboards are read from the database; nothing to rebuild.")
            return
        stats = leaderboard.rebuild_all(options.get("batch"))
        self.stdout.write(self.style.SUCCESS(f"Rebuilt {stats['batches']} batch(es), {stats['members']} ranked member row(s)."))
