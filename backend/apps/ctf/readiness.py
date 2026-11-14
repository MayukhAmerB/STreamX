"""The exam readiness checklist (Console -> Exams).

Publishing (or scheduling) an exam is refused until every item passes, and
the Console shows each failing item with the reason, so staff never publish
an exam that would answer 503 or mark every answer wrong:

* ``pepper``     CTF_ANSWER_PEPPER is set and strong (production has no
                 fallback and refuses a weak one);
* ``answer_key`` the stored answer hashes were made with the current pepper;
* ``questions``  at least one active question;
* ``window``     opening and closing times set, closing after opening and
                 still in the future;
* ``batches``    at least one eligible batch (course);
* ``materials``  every evidence file the questions reference is uploaded.

The scheduler re-runs the checklist before an automatic publish.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from django.utils import timezone

from . import answers
from .models import CtfExam, CtfMaterial, CtfQuestion


@dataclass(frozen=True)
class ReadinessItem:
    id: str
    label: str
    ok: bool
    detail: str = ""


@dataclass(frozen=True)
class Readiness:
    items: list = field(default_factory=list)

    @property
    def ready(self):
        return all(item.ok for item in self.items)

    @property
    def blocking(self):
        return [item for item in self.items if not item.ok]

    def reasons(self):
        return [item.detail or item.label for item in self.blocking]

    def as_dict(self):
        return {
            "ready": self.ready,
            "items": [
                {"id": item.id, "label": item.label, "ok": item.ok, "detail": item.detail} for item in self.items
            ],
            "reasons": self.reasons(),
        }


def _pepper_item(production):
    """A missing or weak pepper disables exams in production (apps/ctf/checks.py
    reports it at startup without stopping the LMS); this item is where staff
    see why Publish stays disabled."""
    problem = answers.pepper_problem()
    if not problem:
        return ReadinessItem("pepper", "Answer pepper configured", True)
    if production:
        return ReadinessItem("pepper", "Answer pepper configured", False, answers.PEPPER_PROBLEMS[problem])
    if problem == answers.PEPPER_MISSING:
        return ReadinessItem("pepper", "Answer pepper configured", True, "Development stand-in pepper.")
    return ReadinessItem(
        "pepper", "Answer pepper configured", True, "Weak development pepper: production would refuse it."
    )


def _current_key_id():
    try:
        return answers.answer_key_id()
    except answers.CtfNotConfigured:
        return None


def referenced_material_paths(exam):
    paths = []
    for materials in CtfQuestion.objects.filter(exam=exam, is_active=True).values_list("materials", flat=True):
        for item in materials if isinstance(materials, list) else []:
            if isinstance(item, dict) and item.get("path"):
                paths.append(str(item["path"]))
    return sorted(set(paths))


def material_status(exam):
    """``(referenced paths, uploaded paths)`` for the materials checklist item."""
    referenced = referenced_material_paths(exam)
    uploaded = set(CtfMaterial.objects.filter(exam=exam).values_list("path", flat=True))
    return referenced, uploaded


def check_exam(exam, *, at=None):
    now = at or timezone.now()
    items = []

    items.append(_pepper_item(answers._is_production()))

    key_id = _current_key_id()
    if key_id is None:
        items.append(
            ReadinessItem("answer_key", "Answer key matches", False, "Set a valid pepper, then load the exam file.")
        )
    elif not exam.answer_key_id:
        items.append(ReadinessItem("answer_key", "Answer key matches", False, "Upload the exam file to load its answers."))
    elif exam.answer_key_id != key_id:
        items.append(
            ReadinessItem(
                "answer_key",
                "Answer key matches",
                False,
                "The answers were hashed with a different pepper. Upload the exam file again.",
            )
        )
    else:
        items.append(ReadinessItem("answer_key", "Answer key matches", True))

    question_count = CtfQuestion.objects.filter(exam=exam, is_active=True).count()
    items.append(
        ReadinessItem(
            "questions",
            "Questions loaded",
            question_count > 0,
            f"{question_count} question(s)." if question_count else "The exam has no questions yet.",
        )
    )

    if not exam.opens_at or not exam.closes_at:
        window = ReadinessItem("window", "Exam window set", False, "Set both the opening and the closing time.")
    elif exam.closes_at <= exam.opens_at:
        window = ReadinessItem("window", "Exam window set", False, "The closing time must be after the opening time.")
    elif exam.closes_at <= now:
        window = ReadinessItem("window", "Exam window set", False, "The closing time has already passed.")
    else:
        window = ReadinessItem("window", "Exam window set", True)
    items.append(window)

    batch_count = exam.eligible_courses.count() if exam.pk else 0
    items.append(
        ReadinessItem(
            "batches",
            "Batches chosen",
            batch_count > 0,
            f"{batch_count} batch(es)." if batch_count else "Choose at least one batch that may sit the exam.",
        )
    )

    referenced, uploaded = material_status(exam)
    missing = [path for path in referenced if path not in uploaded]
    if missing:
        items.append(
            ReadinessItem(
                "materials",
                "Evidence files uploaded",
                False,
                f"{len(missing)} of {len(referenced)} evidence file(s) still need uploading.",
            )
        )
    else:
        detail = f"{len(referenced)} file(s)." if referenced else "No evidence files needed."
        items.append(ReadinessItem("materials", "Evidence files uploaded", True, detail))
    return Readiness(items)


def is_scheduled(exam):
    return exam.status == CtfExam.STATUS_DRAFT and bool(exam.auto_publish)
