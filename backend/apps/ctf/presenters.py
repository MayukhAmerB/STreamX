"""Plain dicts sent to students (rendered through ``serializers.py``).

Nothing here reads ``answer_hashes`` or ``normalization``: those fields never
leave the server. Urdu text falls back to English field by field.
"""

from __future__ import annotations

from django.db.models import Count, Sum

from . import answers
from .models import CtfExam, CtfParticipation
from .services import active_questions, question_progress

# Why Start is disabled (``start_reason``); "ok" means it is enabled.
START_OK = "ok"
START_REASON_CHOICES = [
    (START_OK, "Can start"),
    ("started", "Already started"),
    ("completed", "Already finished"),
    ("not_open", "Not open yet"),
    ("closed", "Closed"),
    ("no_questions", "No questions yet"),
    ("not_configured", "Answer checking not ready"),
]

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


def material_list(materials, resolve=None):
    """``resolve(path)`` returns ``(material_id, url)`` for evidence uploaded
    to the LMS (a short-lived signed URL), or ``None`` to keep the labs path."""
    items = []
    for item in materials if isinstance(materials, list) else []:
        if not isinstance(item, dict) or not item.get("path"):
            continue
        path = str(item["path"])
        resolved = resolve(path) if resolve else None
        items.append(
            {
                "id": resolved[0] if resolved else None,
                "label": localized_text(item.get("label"), fallback=path.rsplit("/", 1)[-1]),
                "url": resolved[1] if resolved else path,
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


def _answer_key_ready(exam):
    try:
        return bool(exam.answer_key_id) and exam.answer_key_id == answers.answer_key_id()
    except answers.CtfNotConfigured:
        return False


def start_reason(exam, participation, *, is_staff, at, question_count):
    """Why the Start button is disabled ("ok" when it is enabled)."""
    if participation is not None:
        return "started" if participation.status == CtfParticipation.STATUS_ACTIVE else "completed"
    if not question_count:
        return "no_questions"
    if not is_staff:
        window = exam.window(at)
        if window == CtfExam.WINDOW_NOT_OPEN:
            return "not_open"
        if window == CtfExam.WINDOW_CLOSED:
            return "closed"
    if not _answer_key_ready(exam):
        return "not_configured"
    return START_OK


def exam_summary(exam, participation, *, is_staff, at):
    question_count, total_points = _totals(exam)
    reason = start_reason(exam, participation, is_staff=is_staff, at=at, question_count=question_count)
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
        "can_start": reason == START_OK,
        "start_reason": reason,
        "participation": participation_dict(participation),
    }


def question_dict(question, exam, progress, resolve=None):
    entry = progress.get(question.pk, {"used": 0, "solved": False, "points": 0})
    return {
        "key": question.key,
        "order": question.order,
        "category": question.category,
        "difficulty": question.difficulty,
        "points": question.points,
        "title": localized_text(question.title, fallback=f"Question {question.order}"),
        "prompt": localized_prompt(question.prompt),
        "materials": material_list(question.materials, resolve),
        "max_attempts": question.effective_max_attempts(exam),
        "attempts_used": entry["used"],
        "solved": entry["solved"],
        "points_awarded": entry["points"],
    }


def exam_detail(exam, participation, *, is_staff, at, resolve=None):
    summary = exam_summary(exam, participation, is_staff=is_staff, at=at)
    questions = []
    # Questions (and their evidence paths) are only revealed once the student
    # has started; a closed exam keeps showing them for review.
    if participation is not None:
        progress = question_progress(participation)
        questions = [question_dict(question, exam, progress, resolve) for question in active_questions(exam)]
    return {
        "exam": {
            **{key: summary[key] for key in ("slug", "title", "status", "window", "opens_at", "closes_at")},
            "briefing": localized_lines(exam.briefing),
            "rules": localized_lines(exam.rules),
            "time_limit_minutes": exam.time_limit_minutes,
            "question_count": summary["question_count"],
            "total_points": summary["total_points"],
            "can_start": summary["can_start"],
            "start_reason": summary["start_reason"],
        },
        "participation": participation_dict(participation),
        "server_time": at,
        "questions": questions,
    }


def participations_by_exam(user, exams):
    return {item.exam_id: item for item in CtfParticipation.objects.filter(user=user, exam__in=exams)}
