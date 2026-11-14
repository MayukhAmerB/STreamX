"""Streak arithmetic: pure functions over a user's IST study days.

A study day is an IST calendar day with any XP-earning activity. A streak is a
run of study days on consecutive days; one free "freeze" per IST week (Monday
to Sunday, the week of the missed day) automatically covers a single missed
day between two study days. A frozen day keeps the streak alive but does not
add to its length. Today without activity yet never breaks a streak (the day
is not over); yesterday missed is covered by this week's freeze if it is still
free.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta

from .rules import week_start


@dataclass
class StreakState:
    current: int = 0
    best: int = 0
    last_day: date | None = None
    freeze_week: date | None = None  # Monday of the most recent week whose freeze was used
    freeze_used_on: date | None = None  # the most recent frozen day
    frozen_days: list[date] = field(default_factory=list)
    continuing_days: set[date] = field(default_factory=set)  # days that extended a streak (>= 2nd day)


def compute(days: Iterable[date]) -> StreakState:
    """Walk every study day once, oldest first (history, not "today")."""
    ordered = sorted(set(days))
    state = StreakState()
    used_weeks: set[date] = set()
    run = 0
    previous: date | None = None
    for day in ordered:
        if previous is None:
            run = 1
        else:
            gap = (day - previous).days
            if gap == 1:
                run += 1
                state.continuing_days.add(day)
            elif gap == 2 and week_start(previous + timedelta(days=1)) not in used_weeks:
                missed = previous + timedelta(days=1)
                used_weeks.add(week_start(missed))
                state.frozen_days.append(missed)
                state.freeze_week = week_start(missed)
                state.freeze_used_on = missed
                run += 1
                state.continuing_days.add(day)
            else:
                run = 1
        state.best = max(state.best, run)
        previous = day
    state.current = run
    state.last_day = previous
    return state


@dataclass(frozen=True)
class EffectiveStreak:
    current: int
    best: int
    alive: bool
    studied_today: bool
    freeze_available: bool  # this week's freeze is still unused
    freeze_covering: date | None  # the missed day the freeze is covering right now, if any


def effective(*, current: int, best: int, last_day: date | None, freeze_week: date | None, today: date) -> EffectiveStreak:
    """What the user sees today, from the stored summary fields (no queries)."""
    this_week = week_start(today)
    if last_day is None or current <= 0:
        return EffectiveStreak(0, best, False, False, freeze_week != this_week, None)
    gap = (today - last_day).days
    if gap <= 1:
        return EffectiveStreak(current, best, True, gap == 0, freeze_week != this_week, None)
    if gap == 2:
        missed = today - timedelta(days=1)
        missed_week = week_start(missed)
        if freeze_week != missed_week:
            return EffectiveStreak(
                current,
                best,
                True,
                False,
                freeze_week != this_week and missed_week != this_week,
                missed,
            )
    return EffectiveStreak(0, best, False, False, freeze_week != this_week, None)
