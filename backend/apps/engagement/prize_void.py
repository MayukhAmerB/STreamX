"""Re-check a closed period's prizes under the current prize rules and void the
ones that no longer qualify (``manage.py engagement_void_prizes``).

Nothing is deleted. A voided prize gets a reversing ledger row (same kind,
negative points, key ``revoke:<event id>``: the key staff revocations use, so
a prize can never be reversed twice by either path), an audit entry with the
reason "Prize voided: rule change", and the Podium Week badge it granted is
revoked (with its achievement, so its certificate stops verifying) unless the
student is still on a podium that period under the new rules. Dry run unless
``apply``; a second run finds everything already voided and changes nothing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from . import rules, services, standings
from .badges import AwardedItem
from .models import Achievement, BadgeAward, EngagementAuditLog, EngagementSummary, XpEvent

VOID_REASON = "Prize voided: rule change"

STATUS_KEPT = "kept"
STATUS_VOID = "voided"
STATUS_ALREADY = "voided earlier"


@dataclass
class PrizeRow:
    event_id: int
    user_id: int
    handle: str
    batch_id: int
    batch_title: str
    points: int
    status: str
    reason: str
    badge_revoked: bool = False


@dataclass
class VoidReport:
    kind: str
    period: date
    label: str
    rows: list[PrizeRow]
    applied: bool

    @property
    def voided_xp(self) -> int:
        return sum(row.points for row in self.rows if row.status in (STATUS_VOID, STATUS_ALREADY))

    @property
    def kept_xp(self) -> int:
        return sum(row.points for row in self.rows if row.status == STATUS_KEPT)


def parse_period(text: str) -> tuple[str, date, str]:
    """``("week" | "month", first day, label)`` from "2026-W46", "2026-11-09" (a Monday) or "2026-10"."""
    raw = str(text or "").strip().upper()
    match = re.fullmatch(r"(\d{4})-W(\d{1,2})", raw)
    if match:
        week = date.fromisocalendar(int(match.group(1)), int(match.group(2)), 1)
        return "week", week, f"{int(match.group(1))}-W{int(match.group(2)):02d}"
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if match:
        day = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        week = rules.week_start(day)
        year, number, _ = week.isocalendar()
        return "week", week, f"{year}-W{number:02d}"
    match = re.fullmatch(r"(\d{4})-(\d{2})", raw)
    if match:
        month = date(int(match.group(1)), int(match.group(2)), 1)
        return "month", month, month.strftime("%Y-%m")
    raise ValueError("Use an ISO week (2026-W46), a Monday (2026-11-09) or a month (2026-10).")


def _awarded(kind: str, period: date) -> list[XpEvent]:
    if kind == "week":
        tag, xp_kind = period.isoformat(), rules.KIND_LEADERBOARD_WEEKLY
    else:
        tag, xp_kind = period.strftime("%Y-%m"), rules.KIND_LEADERBOARD_MONTHLY
    return list(
        XpEvent.objects.filter(
            kind=xp_kind, points__gt=0, source_type=standings.SOURCE_LEADERBOARD, source_id__endswith=f":{tag}"
        ).order_by("source_id", "-points", "id")
    )


def _batch_of(event: XpEvent) -> int:
    head = str(event.source_id or "").split(":", 1)[0]
    return int(head) if head.isdigit() else 0


def void_prizes(period_text: str, *, apply: bool = False) -> VoidReport:
    from apps.courses.models import Course
    from apps.profiles.handles import public_handles

    kind, period, label = parse_period(period_text)
    plan = standings.plan_week(period) if kind == "week" else standings.plan_month(period)
    events = _awarded(kind, period)
    reversed_ids = {
        int(key.split(":", 1)[1])
        for key in XpEvent.objects.filter(idempotency_key__in=[f"revoke:{event.pk}" for event in events]).values_list(
            "idempotency_key", flat=True
        )
    }
    handles = public_handles({event.user_id for event in events}) if events else {}
    titles = dict(Course.objects.filter(pk__in={_batch_of(event) for event in events}).values_list("pk", "title"))
    rows = []
    for event in events:
        batch_id = _batch_of(event)
        prize = plan.prize_for(batch_id, event.user_id)
        if event.pk in reversed_ids:
            status, reason = STATUS_ALREADY, plan.explain(batch_id, event.user_id) or "reversed earlier"
        elif prize is not None:
            status = STATUS_KEPT
            reason = f"qualifies (#{prize.rank})"
            if prize.points != event.points:
                reason += f"; the new rules would pay {prize.points}"
        else:
            status, reason = STATUS_VOID, plan.explain(batch_id, event.user_id)
        rows.append(
            PrizeRow(
                event_id=event.pk,
                user_id=event.user_id,
                handle=handles.get(event.user_id) or "",
                batch_id=batch_id,
                batch_title=titles.get(batch_id, ""),
                points=event.points,
                status=status,
                reason=reason,
            )
        )
    if apply:
        by_id = {event.pk: event for event in events}
        for row in rows:
            if row.status == STATUS_VOID:
                _reverse(by_id[row.event_id])
        if kind == "week":
            for row in rows:
                if row.status in (STATUS_VOID, STATUS_ALREADY):
                    row.badge_revoked = _revoke_podium(row, period, plan)
    else:
        for row in rows:
            if row.status in (STATUS_VOID, STATUS_ALREADY) and kind == "week":
                row.badge_revoked = _podium_to_revoke(row, period, plan) is not None
    return VoidReport(kind=kind, period=period, label=label, rows=rows, applied=apply)


def _reverse(event: XpEvent) -> None:
    with transaction.atomic():
        result = services.award_many(
            event.user_id,
            [
                AwardedItem(
                    kind=event.kind,  # a standing kind: never ranked, never a study day
                    points=-int(event.points),
                    key=f"revoke:{event.pk}",
                    source_type=XpEvent.SOURCE_XP_EVENT,
                    source_id=str(event.pk),
                    occurred_at=event.occurred_at,  # belongs to the closed period
                )
            ],
            force=True,
        )
        if result.events:
            services._audit(
                actor=None,
                target_user_id=event.user_id,
                action=EngagementAuditLog.ACTION_REVOKE_XP,
                reason=VOID_REASON,
                points=result.events[0].points,
                xp_event=result.events[0],
            )


def _podium_to_revoke(row: PrizeRow, week: date, plan) -> BadgeAward | None:
    """The Podium Week badge this prize granted, when the new rules put the student on no podium that week."""
    if row.user_id in plan.podium_users():
        return None
    return BadgeAward.objects.filter(
        user_id=row.user_id,
        badge_key=standings.PODIUM_BADGE,
        revoked_at__isnull=True,
        note=f"week {week.isoformat()} batch {row.batch_id}",
    ).first()


def _revoke_podium(row: PrizeRow, week: date, plan) -> bool:
    now = timezone.now()
    with transaction.atomic():
        services._lock_summary(row.user_id)
        award = _podium_to_revoke(row, week, plan)
        if award is None:
            return False
        BadgeAward.objects.filter(pk=award.pk, revoked_at__isnull=True).update(revoked_at=now)
        Achievement.objects.filter(
            user_id=row.user_id, kind=Achievement.KIND_BADGE, key=standings.PODIUM_BADGE, revoked_at__isnull=True
        ).update(revoked_at=now)
        EngagementSummary.objects.filter(user_id=row.user_id).update(
            badges_count=F("badges_count") - 1, version=F("version") + 1, updated_at=now
        )
        services._audit(
            actor=None,
            target_user_id=row.user_id,
            action=EngagementAuditLog.ACTION_REVOKE_BADGE,
            reason=VOID_REASON,
            badge_key=standings.PODIUM_BADGE,
        )
    return True


def render(report: VoidReport) -> str:
    """A plain-text table of every prize of the period (handles only, never names)."""
    header = ("user id", "handle", "batch", "XP", "status", "badge", "reason")
    body = [
        (
            str(row.user_id),
            row.handle or "-",
            f"{row.batch_id} {row.batch_title}"[:48],
            str(row.points),
            row.status,
            "Podium Week revoked" if row.badge_revoked and report.applied
            else ("Podium Week to revoke" if row.badge_revoked else "-"),
            row.reason,
        )
        for row in report.rows
    ]
    widths = [max(len(header[i]), *(len(line[i]) for line in body)) if body else len(header[i]) for i in range(len(header))]
    lines = [
        f"{'APPLIED' if report.applied else 'DRY RUN (nothing written; add --apply)'}: "
        f"{'weekly' if report.kind == 'week' else 'monthly'} prizes {report.label} "
        f"({report.period.isoformat()})",
        "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(header)),
        "  ".join("-" * width for width in widths),
    ]
    lines += ["  ".join(cell.ljust(widths[i]) for i, cell in enumerate(line)) for line in body]
    counts = {status: sum(1 for row in report.rows if row.status == status) for status in (STATUS_KEPT, STATUS_VOID, STATUS_ALREADY)}
    lines.append("")
    lines.append(
        f"{len(report.rows)} prize(s): {counts[STATUS_KEPT]} kept ({report.kept_xp} XP), "
        f"{counts[STATUS_VOID]} to void{'ed' if report.applied else ''}, {counts[STATUS_ALREADY]} voided earlier "
        f"({report.voided_xp} XP voided in all)."
    )
    return "\n".join(lines)
