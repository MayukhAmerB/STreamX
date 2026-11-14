"""PII guard engine: an extensible registry of detectors.

A detector is a small class with a stable ``code`` (part of the API contract:
the editor maps codes to help text), a user-facing ``label`` and a
``find(text, ctx)`` generator of ``(start, end)`` spans over the
*normalised* text (``normalize.normalize``)::

    from apps.profiles.pii import engine

    @engine.register
    class StudentIdDetector(engine.Detector):
        code = "student_id"
        label = "a student ID"
        priority = 40
        pattern = re.compile(r"\\bSID-\\d{6}\\b")

        def find(self, text, ctx):
            for match in self.pattern.finditer(text):
                yield match.start(), match.end()

``scan_text`` runs every registered detector, drops overlapping duplicates
(the higher ``priority`` wins) and returns ``Finding`` objects whose excerpt
is masked, so neither the API response nor any log repeats the identifier in
full. Nothing here touches the database or the network.
"""

from __future__ import annotations

import threading
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

from .normalize import mask, normalize


@dataclass(frozen=True)
class ScanContext:
    """What the detectors know about the profile owner.

    ``full_name``/``email``/``phone`` are the account's own values, used by
    the own-identity detector; ``allow_real_name`` turns the name part of it
    off (the admin allows real names and the owner chose to show theirs).
    """

    full_name: str = ""
    email: str = ""
    phone: str = ""
    allow_real_name: bool = False
    # Detector codes to skip for this scan (e.g. a field that is a URL).
    skip: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class Finding:
    code: str
    label: str
    path: str
    start: int
    end: int
    excerpt: str
    message: str

    def as_dict(self) -> dict:
        return {
            "code": self.code,
            "label": self.label,
            "path": self.path,
            "start": self.start,
            "end": self.end,
            "excerpt": self.excerpt,
            "message": self.message,
        }


class Detector:
    code: str = ""
    label: str = ""
    # Higher wins when two detectors claim overlapping text.
    priority: int = 0
    advice: str = "Remove it, then publish again."

    def find(self, text: str, ctx: ScanContext) -> Iterator[tuple[int, int]]:  # pragma: no cover - interface
        raise NotImplementedError

    def message(self) -> str:
        return f"This looks like {self.label}. {self.advice}"


_registry: dict[str, Detector] = {}
_lock = threading.RLock()


def register(detector_cls: type[Detector]) -> type[Detector]:
    """Class decorator: add (or replace) a detector in the registry."""
    instance = detector_cls()
    if not instance.code or not instance.label:
        raise ValueError("a detector needs a code and a label")
    with _lock:
        _registry[instance.code] = instance
    return detector_cls


def unregister(code: str) -> None:
    with _lock:
        _registry.pop(code, None)


def detectors() -> list[Detector]:
    with _lock:
        return sorted(_registry.values(), key=lambda item: (-item.priority, item.code))


def _excerpt(text: str, start: int, end: int) -> str:
    return mask(text[start:end])


def scan_text(text: str, ctx: ScanContext | None = None, *, path: str = "") -> list[Finding]:
    """Findings in one string (already-normalised or raw; it is normalised here)."""
    ctx = ctx or ScanContext()
    normal = normalize(text)
    if not normal:
        return []
    claimed: list[tuple[int, int, Detector]] = []
    for detector in detectors():
        if detector.code in ctx.skip:
            continue
        for start, end in detector.find(normal, ctx):
            if start >= end:
                continue
            if any(start < other_end and other_start < end for other_start, other_end, _ in claimed):
                continue  # a higher-priority detector already reported this text
            claimed.append((start, end, detector))
    claimed.sort(key=lambda item: item[0])
    return [
        Finding(
            code=detector.code,
            label=detector.label,
            path=path,
            start=start,
            end=end,
            excerpt=_excerpt(normal, start, end),
            message=detector.message(),
        )
        for start, end, detector in claimed
    ]


def scan_fields(fields: Iterable[tuple[str, str]], ctx: ScanContext | None = None) -> list[Finding]:
    """Findings across ``(path, text)`` pairs, in field order."""
    findings: list[Finding] = []
    for path, text in fields:
        findings.extend(scan_text(text, ctx, path=path))
    return findings


def summary(findings: list[Finding]) -> str:
    """One sentence for the publish refusal: "Remove the phone number in Bio ..." style."""
    if not findings:
        return ""
    labels: list[str] = []
    for finding in findings:
        if finding.label not in labels:
            labels.append(finding.label)
    if len(labels) == 1:
        found = labels[0]
    else:
        found = ", ".join(labels[:-1]) + f" and {labels[-1]}"
    return (
        f"Your profile can't be published yet: it contains what looks like {found}. "
        "Remove the highlighted text, then publish again."
    )
