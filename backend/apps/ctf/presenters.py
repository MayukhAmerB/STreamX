"""Plain dicts sent to students (rendered through ``serializers.py``).

Nothing here reads ``answer_hashes`` or ``normalization``: those fields never
leave the server. Urdu text falls back to English field by field.
"""

from __future__ import annotations

from django.db.models import Count, Sum

from .models import CtfExam, CtfParticipation
from .services import active_questions, question_progress

PROMPT_TEXT_FIELDS = ("artifact", "task", "constraints", "answer_format")
PROMPT_LIST_FIELDS = ("briefing", "search_patterns")


def _text(value):
    return str(value or "").strip()


def _lines(value):
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    return [str(item) for item in value if str(item or "").strip()]


def localized_text(mapping, fallback=""):
    mapping = mapping if isinstance(mapping, dict) else {}
    english = _text(mapping.get("en")) or _text(fallback)
    return {"en": english, "ur": _text(mapping.get("ur")) or english}


def localized_lines(mapping):
    mapping = mapping if isinstance(mapping, dict) else {}
    english = _lines(mapping.get("en"))
    return {"en": english, "ur": _lines(mapping.get("ur")) or english}


def _prompt_body(body, fallback=None):
    body = body if isinstance(body, dict) else {}
    fallback = fallback or {}
    result = {}
    for name in PROMPT_LIST_FIELDS:
        result[name] = _lines(body.get(name)) or list(fallback.get(name, []))
    for name in PROMPT_TEXT_FIELDS:
        result[name] = _text(body.get(name)) or fallback.get(name, "")
    return result


def localized_prompt(prompt):
    prompt = prompt if isinstance(prompt, dict) else {}
    english = _prompt_body(prompt.get("en"))
    return {"en": english, "ur": _prompt_body(prompt.get("ur"), english)}


def material_list(materials):
    items = []
    for item in materials if isinstance(materials, list) else []:
        if not isinstance(item, dict) or not item.get("path"):
            continue
        items.append(
            {
                "label": localized_text(item.get("label"), fallback=str(item.get("path")).rsplit("/", 1)[-1]),
                "url": str(item["path"]),
                "kind": "image" if item.get("kind") == "image" else "file",
                "alt": localized_text(item.get("alt")),
            }
        )
    return items


def exam_title(exam):
    return {"en": exam.title, "ur": exam.title_ur or exam.title}


def participation_dict(participation):
    if participation is None:
        return None
    return {
        "status": participation.status,
        "started_at": participation.started_at,
        "deadline_at": participation.deadline_at,
        "submitted_at": participation.submitted_at,
        "score": participation.score,
        "solved_count": participation.solved_count,
        "wrong_count": participation.wrong_count,
    }


def _totals(exam):
    totals = active_questions(exam).aggregate(count=Count("id"), points=Sum("points"))
    return int(totals["count"] or 0), int(totals["points"] or 0)


def can_start(exam, participation, *, is_staff, at):
    if participation is not None:
        return False
    return is_staff or exam.window(at) == CtfExam.WINDOW_OPEN


def exam_summary(exam, participation, *, is_staff, at):
    question_count, total_points = _totals(exam)
    return {
        "slug": exam.slug,
        "title": exam_title(exam),
        "status": exam.status,
        "window": exam.window(at),
        "opens_at": exam.opens_at,
        "closes_at": exam.closes_at,
        "time_limit_minutes": exam.time_limit_minutes,
        "question_count": question_count,
        "total_points": total_points,
        "can_start": can_start(exam, participation, is_staff=is_staff, at=at) and question_count > 0,
        "participation": participation_dict(participation),
    }


def question_dict(question, exam, progress):
    entry = progress.get(question.pk, {"used": 0, "solved": False, "points": 0})
    return {
        "key": question.key,
        "order": question.order,
        "category": question.category,
        "difficulty": question.difficulty,
        "points": question.points,
        "title": localized_text(question.title, fallback=f"Question {question.order}"),
        "prompt": localized_prompt(question.prompt),
        "materials": material_list(question.materials),
        "max_attempts": question.effective_max_attempts(exam),
        "attempts_used": entry["used"],
        "solved": entry["solved"],
        "points_awarded": entry["points"],
    }


def exam_detail(exam, participation, *, is_staff, at):
    summary = exam_summary(exam, participation, is_staff=is_staff, at=at)
    questions = []
    # Questions (and their evidence paths) are only revealed once the student
    # has started; a closed exam keeps showing them for review.
    if participation is not None:
        progress = question_progress(participation)
        questions = [question_dict(question, exam, progress) for question in active_questions(exam)]
    return {
        "exam": {
            **{key: summary[key] for key in ("slug", "title", "status", "window", "opens_at", "closes_at")},
            "briefing": localized_lines(exam.briefing),
            "rules": localized_lines(exam.rules),
            "time_limit_minutes": exam.time_limit_minutes,
            "question_count": summary["question_count"],
            "total_points": summary["total_points"],
            "can_start": summary["can_start"],
        },
        "participation": participation_dict(participation),
        "server_time": at,
        "questions": questions,
    }


def participations_by_exam(user, exams):
    return {item.exam_id: item for item in CtfParticipation.objects.filter(user=user, exam__in=exams)}
