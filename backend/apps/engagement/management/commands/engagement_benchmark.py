"""Seed N students x M XP events, time the read endpoints, roll everything back.

    python manage.py engagement_benchmark --students 5000 --events 50 --requests 300

Everything runs inside one transaction that is rolled back at the end, so the
database is left unchanged (use a scratch database anyway: seeding takes a
write lock for the duration). Reports p50/p95/max latency and the query count
per request for ``GET /api/engagement/me/`` (cold = extras cache empty, warm)
and ``GET /api/engagement/leaderboard/`` (week and all-time), measured in
process through the full Django/DRF stack with a forced authentication (the
JWT cookie check is the same for every endpoint and is excluded).
"""

from __future__ import annotations

import random
import statistics
import time
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management.base import BaseCommand
from django.db import connection, transaction
from django.test.utils import CaptureQueriesContext, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.engagement import rules
from apps.engagement.models import EngagementSummary, XpEvent


class _Rollback(Exception):
    pass


def _percentile(values, pct):
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(pct / 100.0 * (len(ordered) - 1)))))
    return ordered[index]


class Command(BaseCommand):
    help = "Benchmark engagement reads on a seeded dataset (rolled back afterwards)."

    def add_arguments(self, parser):
        parser.add_argument("--students", type=int, default=5000)
        parser.add_argument("--events", type=int, default=50)
        parser.add_argument("--requests", type=int, default=300)
        parser.add_argument("--seed", type=int, default=7)

    def handle(self, *args, **options):
        self.report = []
        caches = None
        if "locmem" in str(settings.CACHES["default"]["BACKEND"]).lower():
            # Development cache: lift locmem's 300-entry cull so the cached paths are
            # measured as they behave on Redis in production.
            caches = {
                "default": {
                    "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
                    "LOCATION": "engagement-bench",
                    "OPTIONS": {"MAX_ENTRIES": 1_000_000},
                }
            }
        try:
            with override_settings(**({"CACHES": caches} if caches else {})), transaction.atomic():
                self._run(options)
                raise _Rollback()
        except _Rollback:
            pass
        for line in self.report:
            self.stdout.write(line)

    def _run(self, options):
        rng = random.Random(options["seed"])
        students, per_user = int(options["students"]), int(options["events"])
        from apps.courses.models import Course, Enrollment

        started = time.perf_counter()
        user_model = get_user_model()
        instructor = user_model.objects.create(email="bench-instructor@bench.test", full_name="Bench Instructor", password="!")
        course = Course.objects.create(title="Benchmark batch", description="bench", price=0, instructor=instructor, is_published=True)
        users = user_model.objects.bulk_create(
            [user_model(email=f"bench{n}@bench.test", full_name=f"Bench Student {n}", password="!") for n in range(students)],
            batch_size=1000,
        )
        if users[0].pk is None:  # backends without RETURNING
            users = list(user_model.objects.filter(email__endswith="@bench.test", role="student").exclude(pk=instructor.pk).order_by("pk"))
        Enrollment.objects.bulk_create(
            [Enrollment(user=user, course=course, payment_status=Enrollment.STATUS_PAID) for user in users], batch_size=1000
        )
        now = timezone.now()
        week = rules.current_week_start(now)
        kinds = [rules.KIND_LECTURE_COMPLETED, rules.KIND_WATCH_TIME, rules.KIND_REPORT_SUBMITTED, rules.KIND_STREAK_BONUS]
        batch, summaries = [], []
        for user in users:
            total = weekly = 0
            for n in range(per_user):
                points = rng.choice([1, 5, 20, 30, 40])
                occurred = now - timedelta(minutes=rng.randint(0, 60 * 24 * 60))
                total += points
                if rules.week_start(rules.ist_day(occurred)) == week:
                    weekly += points
                batch.append(
                    XpEvent(user_id=user.pk, kind=rng.choice(kinds), source_type="day", source_id=str(n), points=points,
                            occurred_at=occurred, created_at=occurred, idempotency_key=f"bench:{user.pk}:{n}")
                )
            if len(batch) >= 10000:
                XpEvent.objects.bulk_create(batch, batch_size=5000)
                batch = []
            summaries.append(
                EngagementSummary(
                    user_id=user.pk, total_xp=total, level=rules.level_for(total).number,
                    xp_reached_at=now - timedelta(seconds=rng.randint(0, 10**6)), week_start=week, weekly_xp=weekly,
                    weekly_reached_at=now - timedelta(seconds=rng.randint(0, 10**5)), current_streak=rng.randint(0, 30),
                    best_streak=30, version=1,
                )
            )
        if batch:
            XpEvent.objects.bulk_create(batch, batch_size=5000)
        EngagementSummary.objects.bulk_create(summaries, batch_size=2000)
        if connection.vendor == "postgresql":
            with connection.cursor() as cursor:
                cursor.execute("ANALYZE engagement_xpevent; ANALYZE engagement_engagementsummary;")
        seeded = time.perf_counter() - started
        self.report.append(
            f"Seeded {len(users)} students x {per_user} events = {len(users) * per_user} XP events in {seeded:.1f}s "
            f"({connection.vendor})"
        )
        client = APIClient()
        sample = [rng.choice(users) for _ in range(int(options["requests"]))]
        cache.clear()
        self._measure(client, sample, "/api/engagement/me/", "GET /me (cold extras)")
        self._measure(client, sample, "/api/engagement/me/", "GET /me (warm)")
        # One batch: the shared board is computed once per 60 s; each request then
        # costs the viewer's own rows and rank.
        self._measure(client, sample, "/api/engagement/leaderboard/?period=week", "GET leaderboard week")
        self._measure(client, sample, "/api/engagement/leaderboard/?period=all", "GET leaderboard all-time")
        self._measure(client, sample[:50], "/api/engagement/leaderboard/?period=week", "GET leaderboard 304", conditional=True)
        self._measure(client, sample[:50], "/api/engagement/me/", "GET /me 304 (If-None-Match)", conditional=True)

    def _measure(self, client, users, url, label, *, conditional=False):
        timings, queries, statuses = [], [], set()
        for user in users:
            client.force_authenticate(user)
            headers = {}
            if conditional:
                first = client.get(url, HTTP_HOST="localhost")
                headers["HTTP_IF_NONE_MATCH"] = first["ETag"]
            with CaptureQueriesContext(connection) as captured:
                start = time.perf_counter()
                response = client.get(url, HTTP_HOST="localhost", **headers)
                timings.append((time.perf_counter() - start) * 1000)
            queries.append(len(captured.captured_queries))
            statuses.add(response.status_code)
        self.report.append(
            f"{label:32s} n={len(timings):4d} p50={statistics.median(timings):6.2f} ms "
            f"p95={_percentile(timings, 95):6.2f} ms max={max(timings):7.2f} ms "
            f"queries p50={statistics.median(queries):.0f} max={max(queries)} status={sorted(statuses)}"
        )
