"""Refuse a deploy while a class is live or inside the weekly class window.

Used by ``infra/hostinger/deploy-guard.sh`` (run inside the backend
container). Exit codes:

  0  safe to deploy (or --force)
  3  a class is active right now
  4  inside the class window (Fri-Sun 18:30-20:30 IST)

``--json`` prints the reasons for scripts.
"""

from __future__ import annotations

import json
from datetime import datetime, time

from django.core.management.base import BaseCommand
from django.utils import timezone

EXIT_OK = 0
EXIT_ACTIVE_CLASS = 3
EXIT_CLASS_WINDOW = 4

GUARD_WINDOW_START = time(18, 30)
GUARD_WINDOW_END = time(20, 30)


def in_guard_window(now=None) -> bool:
    from apps.realtime.schedule import LIVE_CLASS_TIMEZONE, LIVE_CLASS_WEEKDAYS

    local = (now or timezone.now()).astimezone(LIVE_CLASS_TIMEZONE)
    if local.weekday() not in LIVE_CLASS_WEEKDAYS:
        return False
    start = datetime.combine(local.date(), GUARD_WINDOW_START, tzinfo=LIVE_CLASS_TIMEZONE)
    end = datetime.combine(local.date(), GUARD_WINDOW_END, tzinfo=LIVE_CLASS_TIMEZONE)
    return start <= local < end


def active_classes(now=None) -> list[dict]:
    """Live sessions with a feed, a fresh host heartbeat, or recent activity."""
    from apps.realtime import lifecycle
    from apps.realtime.models import RealtimeSession

    rows = []
    for session in RealtimeSession.objects.filter(status=RealtimeSession.STATUS_LIVE).order_by("-updated_at")[:50]:
        streaming = session.stream_status in {
            RealtimeSession.STREAM_STARTING,
            RealtimeSession.STREAM_LIVE,
            RealtimeSession.STREAM_INTERRUPTED,
        }
        heartbeat = lifecycle.read_host_heartbeat(session.pk) is not None
        lost = lifecycle.feed_lost_age(session.pk, now)
        recent_feed = lost is not None and lost < 600
        if streaming or heartbeat or recent_feed:
            rows.append(
                {
                    "id": session.pk,
                    "title": session.title,
                    "session_type": session.session_type,
                    "stream_status": session.stream_status,
                    "host_heartbeat": heartbeat,
                }
            )
    return rows


class Command(BaseCommand):
    help = "Exit non-zero when a deploy would interrupt a live class (see infra/hostinger/deploy-guard.sh)."

    def add_arguments(self, parser):
        parser.add_argument("--force", action="store_true", help="Report, but always exit 0.")
        parser.add_argument("--skip-window", action="store_true", help="Only check for active classes.")
        parser.add_argument("--json", action="store_true", help="Print the result as JSON.")

    def handle(self, *args, **options):
        now = timezone.now()
        active = active_classes(now)
        window = False if options.get("skip_window") else in_guard_window(now)
        code = EXIT_OK
        reasons = []
        if active:
            code = EXIT_ACTIVE_CLASS
            reasons.append(f"{len(active)} class(es) live: " + ", ".join(f"#{row['id']} {row['title']}" for row in active))
        elif window:
            code = EXIT_CLASS_WINDOW
            reasons.append("Inside the live-class window (Fri-Sun 18:30-20:30 IST).")
        forced = bool(options.get("force"))
        result = {"safe": code == EXIT_OK, "forced": forced, "reasons": reasons, "active": active, "window": window}
        if options.get("json"):
            self.stdout.write(json.dumps(result))
        elif reasons:
            self.stderr.write("deploy-guard: " + " ".join(reasons))
        else:
            self.stdout.write("deploy-guard: safe to deploy.")
        if forced and code != EXIT_OK:
            self.stderr.write("deploy-guard: FORCED, continuing despite the guard.")
            return
        if code != EXIT_OK:
            raise SystemExit(code)
