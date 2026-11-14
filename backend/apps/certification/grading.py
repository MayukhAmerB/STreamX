"""Server-side scoring of one participation against a certification policy.

Two modes:

* ``reverify=False`` (the automatic decision): a question counts as solved
  when one of the student's recorded attempts was marked correct when it was
  submitted (the same verdict the student saw).
* ``reverify=True`` (re-grade after an answer-key correction): every recorded
  answer is checked again against the question's CURRENT accepted answers
  (``apps.ctf.answers.verify``). Attempts are never changed; only the decision
  is re-evaluated.

Only active questions count; points are the question's current points.
Pass = ``score * 100 >= pass_mark * total`` (exact, no rounding up) AND every
configured section (question category) minimum is met.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_DOWN, Decimal

from apps.ctf import answers
from apps.ctf.models import CtfAttempt, CtfQuestion

BANDS = (
    (Decimal("90"), "Distinction", "90% and above"),
    (Decimal("80"), "Merit", "80% to 89%"),
    (Decimal("0"), "Pass", "the pass mark to 79%"),
)


class AnswerKeyMismatch(RuntimeError):
    """The stored answer hashes were made with another pepper: re-grading would mark everything wrong."""


@dataclass
class Evaluation:
    score: int
    total_points: int
    percent: Decimal
    passed: bool
    band: str
    sections: dict = field(default_factory=dict)
    reasons: list = field(default_factory=list)
    answer_key_id: str = ""

    def as_dict(self) -> dict:
        return {
            "score": self.score,
            "total_points": self.total_points,
            "percent": str(self.percent),
            "passed": self.passed,
            "band": self.band,
            "sections": self.sections,
            "reasons": self.reasons,
            "answer_key_id": self.answer_key_id,
        }


def band_for(percent: Decimal, passed: bool) -> str:
    if not passed:
        return ""
    for floor, name, _range in BANDS:
        if percent >= floor:
            return name
    return "Pass"


def band_range(band: str) -> str:
    return next((text for _floor, name, text in BANDS if name == band), "")


def _percent(score: int, total: int) -> Decimal:
    if not total:
        return Decimal("0.00")
    return (Decimal(score) * 100 / Decimal(total)).quantize(Decimal("0.01"), rounding=ROUND_DOWN)


def _decimal(value, default: Decimal) -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:  # noqa: BLE001
        return default


def solved_question_ids(participation, questions, *, reverify: bool) -> set[int]:
    by_id = {question.pk: question for question in questions}
    attempts = (
        CtfAttempt.objects.filter(participation=participation, question_id__in=list(by_id))
        .order_by("question_id", "attempt_number", "id")
        .only("id", "question_id", "attempt_number", "is_correct", "submitted_answer")
    )
    solved: set[int] = set()
    if not reverify:
        return {attempt.question_id for attempt in attempts if attempt.is_correct}
    exam = participation.exam
    if exam.answer_key_id != answers.answer_key_id():
        raise AnswerKeyMismatch(f"Exam {exam.slug}: answer key does not match CTF_ANSWER_PEPPER; reload the exam file first.")
    for attempt in attempts:
        question = by_id[attempt.question_id]
        if attempt.question_id in solved or attempt.attempt_number > question.effective_max_attempts(exam):
            continue
        correct, _normalized = answers.verify(
            exam.slug, question.key, attempt.submitted_answer, question.normalization, question.answer_hashes
        )
        if correct:
            solved.add(attempt.question_id)
    return solved


def evaluate(participation, policy, *, reverify: bool = False) -> Evaluation:
    questions = list(
        CtfQuestion.objects.filter(exam_id=participation.exam_id, is_active=True)
        .order_by("order", "id")
        .select_related("exam")
    )
    solved = solved_question_ids(participation, questions, reverify=reverify)
    total = sum(int(question.points) for question in questions)
    score = sum(int(question.points) for question in questions if question.pk in solved)
    pass_mark = _decimal(policy.pass_mark_percent, Decimal("70"))
    reasons = []
    passed = bool(total) and Decimal(score) * 100 >= pass_mark * Decimal(total)
    if not total:
        reasons.append("The exam has no active questions.")
    elif not passed:
        reasons.append(f"Score below the pass mark of {pass_mark}%.")

    per_category: dict[str, list[int]] = {}
    for question in questions:
        bucket = per_category.setdefault(question.category, [0, 0])
        bucket[1] += int(question.points)
        if question.pk in solved:
            bucket[0] += int(question.points)
    minimums = policy.section_minimums if isinstance(policy.section_minimums, dict) else {}
    sections = {}
    for category, (got, available) in sorted(per_category.items()):
        entry = {"score": got, "total": available, "percent": str(_percent(got, available))}
        if category in minimums:
            minimum = _decimal(minimums[category], Decimal("0"))
            met = Decimal(got) * 100 >= minimum * Decimal(available)
            entry.update({"minimum": str(minimum), "met": met})
            if not met:
                passed = False
                reasons.append(f"Section {category}: below the minimum of {minimum}%.")
        sections[category] = entry
    for category in minimums:
        if category not in per_category:
            sections[category] = {"score": 0, "total": 0, "percent": "0.00", "minimum": str(minimums[category]),
                                  "met": True, "note": "not in this exam"}
    percent = _percent(score, total)
    return Evaluation(
        score=score,
        total_points=total,
        percent=percent,
        passed=passed,
        band=band_for(percent, passed),
        sections=sections,
        reasons=reasons,
        answer_key_id=participation.exam.answer_key_id or "",
    )
