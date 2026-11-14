"""iCalendar (RFC 5545) output for the personal feed and single classes.

Times are written in UTC (``...Z``) so every client shows the right local
time without a VTIMEZONE block. Text is escaped, lines are folded at 75
octets and end with CRLF.
"""

from __future__ import annotations

from datetime import datetime
from datetime import timezone as dt_timezone

from django.utils import timezone

PRODID = "-//Al Syed Initiative//Class calendar//EN"
UID_DOMAIN = "alsyedinitiative.com"


def escape_text(value) -> str:
    text = str(value or "")
    text = text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n")
    return text


def fold(line: str) -> str:
    """Fold a content line at 75 octets (continuation lines start with a space)."""
    encoded = line.encode("utf-8")
    if len(encoded) <= 75:
        return line
    parts = []
    current = b""
    limit = 75
    for char in line:
        piece = char.encode("utf-8")
        if len(current) + len(piece) > limit:
            parts.append(current.decode("utf-8"))
            current = b""
            limit = 74  # the leading space counts
        current += piece
    if current:
        parts.append(current.decode("utf-8"))
    return "\r\n ".join(parts)


def utc_stamp(value: datetime) -> str:
    if timezone.is_naive(value):
        value = timezone.make_aware(value, dt_timezone.utc)
    return value.astimezone(dt_timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def event_lines(event: dict, *, now: datetime) -> list[str]:
    lines = [
        "BEGIN:VEVENT",
        f"UID:{escape_text(event['uid'])}@{UID_DOMAIN}",
        f"DTSTAMP:{utc_stamp(now)}",
        f"DTSTART:{utc_stamp(event['starts_at'])}",
        f"DTEND:{utc_stamp(event['ends_at'])}",
        f"SUMMARY:{escape_text(event['title'])}",
        f"STATUS:{'CANCELLED' if event.get('cancelled') else 'CONFIRMED'}",
        f"SEQUENCE:{int(event.get('sequence') or 0)}",
    ]
    if event.get("description"):
        lines.append(f"DESCRIPTION:{escape_text(event['description'])}")
    if event.get("location"):
        lines.append(f"LOCATION:{escape_text(event['location'])}")
    if event.get("url"):
        lines.append(f"URL:{event['url']}")
    if event.get("updated_at"):
        lines.append(f"LAST-MODIFIED:{utc_stamp(event['updated_at'])}")
    if not event.get("cancelled"):
        lines += [
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            f"DESCRIPTION:{escape_text(event['title'])}",
            "TRIGGER:-PT15M",
            "END:VALARM",
        ]
    lines.append("END:VEVENT")
    return lines


def calendar(events: list[dict], *, name: str = "Al Syed Initiative classes", now: datetime | None = None) -> str:
    now = now or timezone.now()
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{PRODID}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{escape_text(name)}",
        "X-WR-TIMEZONE:Asia/Kolkata",
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
        "X-PUBLISHED-TTL:PT1H",
    ]
    for event in events:
        lines += event_lines(event, now=now)
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(line) for line in lines) + "\r\n"
