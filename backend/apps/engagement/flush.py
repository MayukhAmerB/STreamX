"""Write-behind flush: Redis counters -> database, every 5 minutes.

Watch buffer fields are ``<user>:<lecture>:<IST day>``, live presence fields
``<session>:<user>:<IST day>``; values are credited seconds. One batch is
applied in one transaction together with its ``FlushLog`` row (exactly once)
and one ``engagement.watch_award`` outbox event per user, so watch XP is
always paid even if the worker dies right after the commit.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date

from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from apps.core.outbox import publish

from . import buffer, services
from .models import FlushLog, LiveAttendance

logger = logging.getLogger("apps.engagement.flush")


def _parse_day(text: str) -> date | None:
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def flush_watch(*, now=None) -> dict[str, int]:
    from .signals import EVENT_WATCH_AWARD

    now = now or timezone.now()
    stats = {"batches": 0, "users": 0, "seconds": 0}
    for token, data in buffer.take_batches("watch"):
        per_user: dict[int, dict[date, int]] = defaultdict(lambda: defaultdict(int))
        for field, seconds in data.items():
            parts = field.split(":")
            if len(parts) != 3:
                continue
            day = _parse_day(parts[2])
            if day is None or not parts[0].isdigit():
                continue
            per_user[int(parts[0])][day] += int(seconds)
        try:
            with transaction.atomic():
                FlushLog.objects.create(token=token, kind="watch", rows=len(data))
                for user_id, days in per_user.items():
                    services.apply_time(user_id, days, kind="watch", now=now)
                    publish(
                        EVENT_WATCH_AWARD,
                        {"user_id": user_id, "days": sorted(day.isoformat() for day in days)},
                        dedupe_key=f"eng-watch:{token}:{user_id}",
                    )
        except IntegrityError:
            logger.info("engagement.flush: batch %s already applied", token)
        buffer.ack("watch", token)
        stats["batches"] += 1
        stats["users"] += len(per_user)
        stats["seconds"] += sum(sum(days.values()) for days in per_user.values())
    return stats


def flush_live(*, now=None) -> dict[str, int]:
    now = now or timezone.now()
    stats = {"batches": 0, "rows": 0}
    for token, data in buffer.take_batches("live"):
        per_pair: dict[tuple[int, int], int] = defaultdict(int)
        per_user_day: dict[int, dict[date, int]] = defaultdict(lambda: defaultdict(int))
        for field, seconds in data.items():
            parts = field.split(":")
            if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
                continue
            day = _parse_day(parts[2])
            if day is None:
                continue
            per_pair[(int(parts[0]), int(parts[1]))] += int(seconds)
            per_user_day[int(parts[1])][day] += int(seconds)
        try:
            with transaction.atomic():
                FlushLog.objects.create(token=token, kind="live", rows=len(data))
                for (session_id, user_id), seconds in per_pair.items():
                    updated = LiveAttendance.objects.filter(session_id=session_id, user_id=user_id).update(
                        seconds=F("seconds") + seconds, last_seen_at=now
                    )
                    if not updated:
                        LiveAttendance.objects.create(
                            session_id=session_id, user_id=user_id, seconds=seconds, first_seen_at=now, last_seen_at=now
                        )
                for user_id, days in per_user_day.items():
                    services.apply_time(user_id, days, kind="live", now=now)
        except IntegrityError:
            logger.info("engagement.flush: live batch %s already applied", token)
        buffer.ack("live", token)
        stats["batches"] += 1
        stats["rows"] += len(per_pair)
    return stats


def flush_all(*, now=None) -> dict[str, dict[str, int]]:
    return {"watch": flush_watch(now=now), "live": flush_live(now=now)}
