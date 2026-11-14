"""The attendance rule (pure functions, fully unit-tested).

Owner rule:

* PRESENT  at least ``present_min_minutes`` (40) minutes present while the
           session was on air;
* short session: when the class itself was on air for less than that, present
           means at least ``short_session_ratio`` (80 %) of the on-air time,
           and the session is flagged for staff;
* PARTIAL  joined but below the bar (not counted as attended);
* ABSENT   never joined;
* EXCUSED  only ever set by staff (manual override).

Recordings never count: only live presence (pings while ``status == live``)
feeds ``seconds_present``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

PRESENT = "present"
PARTIAL = "partial"
ABSENT = "absent"
EXCUSED = "excused"


@dataclass(frozen=True)
class Rule:
    present_min_minutes: int = 40
    short_session_ratio: float = 0.80

    @classmethod
    def from_policy(cls, policy) -> Rule:
        return cls(
            present_min_minutes=max(1, int(policy.present_min_minutes or 40)),
            short_session_ratio=min(1.0, max(0.05, float(policy.short_session_ratio or 0.8))),
        )

    @property
    def present_min_seconds(self) -> int:
        return self.present_min_minutes * 60

    def label(self) -> str:
        return f"Attended = {self.present_min_minutes}+ minutes live"


@dataclass(frozen=True)
class Threshold:
    seconds: int
    short_session: bool


def threshold_for(on_air_seconds: int, rule: Rule) -> Threshold:
    on_air = max(0, int(on_air_seconds or 0))
    if on_air >= rule.present_min_seconds:
        return Threshold(seconds=rule.present_min_seconds, short_session=False)
    return Threshold(seconds=int(math.ceil(on_air * rule.short_session_ratio)), short_session=True)


def classify(*, seconds_present: int, joined: bool, on_air_seconds: int, rule: Rule) -> tuple[str, Threshold]:
    """Status for one student once the class has ended."""
    threshold = threshold_for(on_air_seconds, rule)
    seconds = max(0, min(int(seconds_present or 0), max(0, int(on_air_seconds or 0))))
    joined = bool(joined or seconds > 0)
    if not joined:
        return ABSENT, threshold
    if seconds >= max(1, threshold.seconds):
        return PRESENT, threshold
    return PARTIAL, threshold


def percent(seconds_present: int, on_air_seconds: int) -> float:
    on_air = max(0, int(on_air_seconds or 0))
    if on_air <= 0:
        return 0.0
    return round(min(100.0, 100.0 * max(0, int(seconds_present or 0)) / on_air), 1)


def counts_as_attended(status: str) -> bool:
    return status == PRESENT


def counts_in_total(status: str) -> bool:
    """Excused classes are left out of "attended X of Y"."""
    return status in (PRESENT, PARTIAL, ABSENT)


def streaks(statuses_newest_first) -> tuple[int, int]:
    """(current, best) run of PRESENT classes; excused neither breaks nor extends it."""
    current = 0
    best = 0
    run = 0
    current_open = True
    for status in statuses_newest_first:
        if status == EXCUSED:
            continue
        if status == PRESENT:
            run += 1
            if current_open:
                current = run
        else:
            current_open = False
            run = 0
        best = max(best, run)
    return current, best
