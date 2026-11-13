"""Load an exam from its private JSON file (``OSINTCTF/private/exams/<slug>.json``).

The file is the only place plaintext answers exist. This loader validates it,
hashes the accepted answers with ``CTF_ANSWER_PEPPER`` (``answers.py``) and
upserts the exam and its questions by ``key`` in ONE transaction. It never
stores ``answers``, ``solution`` or ``sources``, and reports counts only.

Questions that students have already answered are protected: changing their
content (prompt, points, answers, rules...) or dropping them from the file is
refused unless ``allow_content_change`` is set, and such questions are only
ever deactivated, never deleted.

File format (``schema_version`` 1)::

    {"schema_version": 1,
     "exam": {"slug", "title": {"en", "ur"}, "briefing": {"en": [..], "ur": [..]},
              "rules": {"en": [..], "ur": [..]}, "opens_at", "closes_at",
              "time_limit_minutes", "default_max_attempts", "eligible_course_ids": [..]},
     "questions": [{"key", "order", "category", "difficulty", "points", "max_attempts",
                    "title": {"en", "ur"},
                    "prompt": {"en": {"briefing": [..], "artifact", "search_patterns": [..],
                                      "task", "constraints", "answer_format"}, "ur": {..}},
                    "materials": [{"label": {"en", "ur"}, "path", "kind": "image"|"file",
                                   "alt": {"en", "ur"}}],
                    "normalization": [..], "answers": [..],
                    "sources": [..], "solution": ".."}]}
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.courses.models import Course

from . import answers
from .models import (
    CATEGORY_VALUES,
    DEFAULT_MAX_ATTEMPTS,
    DIFFICULTY_VALUES,
    MAX_ANSWER_LENGTH,
    MAX_ATTEMPTS_CAP,
    CtfAttempt,
    CtfExam,
    CtfQuestion,
)

SCHEMA_VERSION = 1
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_QUESTIONS = 200
MAX_ANSWERS = 50
MAX_TEXT = 4000
MAX_LINES = 40
MAX_MATERIALS = 20

SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MATERIAL_EXTENSIONS = ("jpg", "jpeg", "png", "webp", "gif", "pdf", "txt", "csv", "json", "md", "zip")
MATERIAL_SEGMENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]*$")

EXAM_KEYS = {
    "slug",
    "title",
    "briefing",
    "rules",
    "opens_at",
    "closes_at",
    "time_limit_minutes",
    "default_max_attempts",
    "eligible_course_ids",
}
QUESTION_KEYS = {
    "key",
    "order",
    "category",
    "difficulty",
    "points",
    "max_attempts",
    "title",
    "prompt",
    "materials",
    "normalization",
    "answers",
}
# Instructor-only fields: allowed in the file, never loaded.
IGNORED_KEYS = {"sources", "solution", "notes", "instructor_notes"}
PROMPT_KEYS = {"briefing", "artifact", "search_patterns", "task", "constraints", "answer_format"}
MATERIAL_KEYS = {"label", "path", "kind", "alt"}
CONTENT_FIELDS = (
    "category",
    "difficulty",
    "points",
    "max_attempts",
    "title",
    "prompt",
    "materials",
    "normalization",
    "answer_hashes",
)


class ExamFileError(ValueError):
    def __init__(self, problems):
        self.problems = list(problems)
        super().__init__("; ".join(self.problems))


@dataclass
class LoadReport:
    slug: str
    exam_created: bool
    dry_run: bool
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    deactivated: int = 0
    removed: int = 0
    question_count: int = 0
    total_points: int = 0
    eligible_courses: int | None = None
    content_sha256: str = ""
    changed_with_attempts: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# Parsing and validation
# ---------------------------------------------------------------------------
def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ExamFileError([f"duplicate key {key!r} in the exam file"])
        result[key] = value
    return result


def parse_exam_bytes(raw):
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if not raw:
        raise ExamFileError(["the exam file is empty"])
    if len(raw) > MAX_FILE_BYTES:
        raise ExamFileError([f"the exam file is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB"])
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ExamFileError(["the exam file is not UTF-8 text"]) from None
    try:
        document = json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except json.JSONDecodeError as exc:
        raise ExamFileError([f"invalid JSON at line {exc.lineno} column {exc.colno}: {exc.msg}"]) from None
    if not isinstance(document, dict):
        raise ExamFileError(["the exam file must be a JSON object"])
    return document


class _Checker:
    def __init__(self):
        self.problems = []

    def fail(self, where, message):
        self.problems.append(f"{where}: {message}")

    def keys(self, value, where, allowed, ignored=frozenset()):
        if not isinstance(value, dict):
            self.fail(where, "must be an object")
            return False
        unknown = sorted(set(value) - set(allowed) - set(ignored))
        if unknown:
            self.fail(where, f"unknown field(s) {', '.join(unknown)}")
        return True

    def text(self, value, where, *, required=False, limit=MAX_TEXT):
        if value is None or value == "":
            if required:
                self.fail(where, "is required")
            return ""
        if not isinstance(value, str):
            self.fail(where, "must be text")
            return ""
        value = value.strip()
        if required and not value:
            self.fail(where, "is required")
        if len(value) > limit:
            self.fail(where, f"is longer than {limit} characters")
        if "\x00" in value:
            self.fail(where, "contains a NUL character")
        return value

    def lines(self, value, where, *, limit=MAX_TEXT, max_items=MAX_LINES):
        if value is None:
            return []
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            self.fail(where, "must be a list of text")
            return []
        if len(value) > max_items:
            self.fail(where, f"has more than {max_items} items")
        return [line for index, item in enumerate(value) if (line := self.text(item, f"{where}[{index}]", limit=limit))]

    def localized(self, value, where, *, required=False, limit=200):
        if value is None:
            if required:
                self.fail(where, "is required")
            return {"en": "", "ur": ""}
        if isinstance(value, str):
            value = {"en": value}
        if not self.keys(value, where, {"en", "ur"}):
            return {"en": "", "ur": ""}
        return {
            "en": self.text(value.get("en"), f"{where}.en", required=required, limit=limit),
            "ur": self.text(value.get("ur"), f"{where}.ur", limit=limit),
        }

    def localized_lines(self, value, where):
        if value is None:
            return {"en": [], "ur": []}
        if not self.keys(value, where, {"en", "ur"}):
            return {"en": [], "ur": []}
        return {"en": self.lines(value.get("en"), f"{where}.en"), "ur": self.lines(value.get("ur"), f"{where}.ur")}

    def integer(self, value, where, *, minimum, maximum, required=True):
        if value is None:
            if required:
                self.fail(where, "is required")
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            self.fail(where, "must be a whole number")
            return None
        if value < minimum or value > maximum:
            self.fail(where, f"must be between {minimum} and {maximum}")
            return None
        return value

    def moment(self, value, where):
        if value is None:
            return None
        parsed = parse_datetime(value) if isinstance(value, str) else None
        if parsed is None:
            self.fail(where, "must be an ISO 8601 date-time such as 2026-12-01T09:00:00+05:30")
            return None
        if timezone.is_naive(parsed):
            self.fail(where, "must include a UTC offset (e.g. +05:30)")
            return None
        return parsed


def _prompt_body(checker, value, where, *, required):
    if value is None or value == {}:
        if required:
            checker.fail(where, "is required")
        return {}
    if not checker.keys(value, where, PROMPT_KEYS):
        return {}
    body = {
        "briefing": checker.lines(value.get("briefing"), f"{where}.briefing"),
        "artifact": checker.text(value.get("artifact"), f"{where}.artifact"),
        "search_patterns": checker.lines(value.get("search_patterns"), f"{where}.search_patterns", limit=500, max_items=30),
        "task": checker.text(value.get("task"), f"{where}.task"),
        "constraints": checker.text(value.get("constraints"), f"{where}.constraints"),
        "answer_format": checker.text(value.get("answer_format"), f"{where}.answer_format"),
    }
    if required and not (body["task"] or body["briefing"]):
        checker.fail(where, "needs a task or a briefing")
    return {key: item for key, item in body.items() if item}


def _material_path(checker, value, where, slug):
    path = checker.text(value, where, required=True, limit=300)
    if not path:
        return ""
    folder_pattern = re.compile(rf"^/materials/exams/{re.escape(slug)}-[0-9a-f]{{32}}/(.+)$")
    match = folder_pattern.match(path)
    if not match:
        checker.fail(where, f"must start with /materials/exams/{slug}-<32 lowercase hex characters>/")
        return ""
    segments = match.group(1).split("/")
    if any(segment in {".", ".."} or not MATERIAL_SEGMENT.match(segment) for segment in segments):
        checker.fail(where, "contains an unsafe path segment")
        return ""
    extension = segments[-1].rsplit(".", 1)[-1].lower() if "." in segments[-1] else ""
    if extension not in MATERIAL_EXTENSIONS:
        checker.fail(where, f"must end in one of: {', '.join(MATERIAL_EXTENSIONS)}")
        return ""
    return path


def _materials(checker, value, where, slug):
    if value is None:
        return []
    if not isinstance(value, list):
        checker.fail(where, "must be a list")
        return []
    if len(value) > MAX_MATERIALS:
        checker.fail(where, f"has more than {MAX_MATERIALS} items")
    items = []
    for index, item in enumerate(value):
        item_where = f"{where}[{index}]"
        if not checker.keys(item, item_where, MATERIAL_KEYS):
            continue
        kind = item.get("kind") or "file"
        if kind not in {"image", "file"}:
            checker.fail(f"{item_where}.kind", "must be image or file")
        material = {
            "label": checker.localized(item.get("label"), f"{item_where}.label", required=True),
            "path": _material_path(checker, item.get("path"), f"{item_where}.path", slug),
            "kind": kind,
        }
        alt = checker.localized(item.get("alt"), f"{item_where}.alt", limit=500)
        if alt["en"] or alt["ur"]:
            material["alt"] = alt
        items.append(material)
    return items


def validate_document(document):
    """Return a clean, loader-ready dict (answers still in plaintext, in memory
    only) or raise ``ExamFileError`` listing every problem found."""
    checker = _Checker()
    checker.keys(document, "file", {"schema_version", "exam", "questions"})
    if document.get("schema_version") != SCHEMA_VERSION:
        checker.fail("schema_version", f"must be {SCHEMA_VERSION}")

    raw_exam = document.get("exam")
    exam = {}
    if checker.keys(raw_exam, "exam", EXAM_KEYS, IGNORED_KEYS):
        slug = checker.text(raw_exam.get("slug"), "exam.slug", required=True, limit=80)
        if slug and not SLUG_PATTERN.match(slug):
            checker.fail("exam.slug", "must be lowercase letters, digits and single hyphens")
        exam = {
            "slug": slug,
            "title": checker.localized(raw_exam.get("title"), "exam.title", required=True),
            "briefing": checker.localized_lines(raw_exam.get("briefing"), "exam.briefing"),
            "rules": checker.localized_lines(raw_exam.get("rules"), "exam.rules"),
            "opens_at": checker.moment(raw_exam.get("opens_at"), "exam.opens_at"),
            "closes_at": checker.moment(raw_exam.get("closes_at"), "exam.closes_at"),
            "time_limit_minutes": checker.integer(
                raw_exam.get("time_limit_minutes"), "exam.time_limit_minutes", minimum=1, maximum=24 * 60, required=False
            ),
            "default_max_attempts": checker.integer(
                raw_exam.get("default_max_attempts"),
                "exam.default_max_attempts",
                minimum=1,
                maximum=MAX_ATTEMPTS_CAP,
                required=False,
            )
            or DEFAULT_MAX_ATTEMPTS,
            "eligible_course_ids": None,
        }
        if exam["opens_at"] and exam["closes_at"] and exam["closes_at"] <= exam["opens_at"]:
            checker.fail("exam.closes_at", "must be after exam.opens_at")
        if "eligible_course_ids" in raw_exam:
            ids = raw_exam.get("eligible_course_ids")
            if not isinstance(ids, list) or any(isinstance(item, bool) or not isinstance(item, int) for item in ids):
                checker.fail("exam.eligible_course_ids", "must be a list of course ids")
            else:
                exam["eligible_course_ids"] = sorted(set(ids))
                found = set(Course.objects.filter(pk__in=exam["eligible_course_ids"]).values_list("pk", flat=True))
                missing = [item for item in exam["eligible_course_ids"] if item not in found]
                if missing:
                    checker.fail("exam.eligible_course_ids", f"unknown course id(s): {', '.join(map(str, missing))}")

    raw_questions = document.get("questions")
    questions = []
    if not isinstance(raw_questions, list) or not raw_questions:
        checker.fail("questions", "must be a non-empty list")
        raw_questions = []
    elif len(raw_questions) > MAX_QUESTIONS:
        checker.fail("questions", f"has more than {MAX_QUESTIONS} items")
    seen_keys, seen_orders = set(), set()
    slug = exam.get("slug") or "exam"
    for index, raw in enumerate(raw_questions):
        where = f"questions[{index}]"
        if not checker.keys(raw, where, QUESTION_KEYS, IGNORED_KEYS):
            continue
        key = checker.text(raw.get("key"), f"{where}.key", required=True, limit=64)
        if key and not SLUG_PATTERN.match(key):
            checker.fail(f"{where}.key", "must be lowercase letters, digits and single hyphens")
        if key in seen_keys:
            checker.fail(f"{where}.key", f"{key!r} is used twice")
        seen_keys.add(key)
        order = checker.integer(raw.get("order"), f"{where}.order", minimum=1, maximum=999)
        if order is not None and order in seen_orders:
            checker.fail(f"{where}.order", f"{order} is used twice")
        seen_orders.add(order)
        category = raw.get("category")
        if category not in CATEGORY_VALUES:
            checker.fail(f"{where}.category", f"must be one of: {', '.join(CATEGORY_VALUES)}")
        difficulty = raw.get("difficulty")
        if difficulty not in DIFFICULTY_VALUES:
            checker.fail(f"{where}.difficulty", f"must be one of: {', '.join(DIFFICULTY_VALUES)}")
        try:
            rules = answers.validate_rules(raw.get("normalization"))
        except (TypeError, ValueError) as exc:
            checker.fail(f"{where}.normalization", str(exc))
            rules = list(answers.DEFAULT_RULES)
        accepted = raw.get("answers")
        if not isinstance(accepted, list) or not accepted:
            checker.fail(f"{where}.answers", "must be a non-empty list of accepted answers")
            accepted = []
        elif len(accepted) > MAX_ANSWERS:
            checker.fail(f"{where}.answers", f"has more than {MAX_ANSWERS} variants")
        clean_answers = []
        for answer_index, answer in enumerate(accepted):
            # Never echo the answer itself in an error message.
            if not isinstance(answer, str) or not answer.strip():
                checker.fail(f"{where}.answers[{answer_index}]", "must be non-empty text")
            elif len(answer) > MAX_ANSWER_LENGTH:
                checker.fail(f"{where}.answers[{answer_index}]", f"is longer than {MAX_ANSWER_LENGTH} characters")
            elif not answers.normalize(answer, rules):
                checker.fail(f"{where}.answers[{answer_index}]", "is empty after normalisation")
            else:
                clean_answers.append(answer)
        prompt = raw.get("prompt")
        prompt_en = prompt_ur = {}
        if checker.keys(prompt, f"{where}.prompt", {"en", "ur"}):
            prompt_en = _prompt_body(checker, prompt.get("en"), f"{where}.prompt.en", required=True)
            prompt_ur = _prompt_body(checker, prompt.get("ur"), f"{where}.prompt.ur", required=False)
        questions.append(
            {
                "key": key,
                "order": order,
                "category": category,
                "difficulty": difficulty,
                "points": checker.integer(raw.get("points"), f"{where}.points", minimum=1, maximum=100000),
                "max_attempts": checker.integer(
                    raw.get("max_attempts"), f"{where}.max_attempts", minimum=1, maximum=MAX_ATTEMPTS_CAP, required=False
                ),
                "title": checker.localized(raw.get("title"), f"{where}.title", required=True),
                "prompt": {"en": prompt_en, "ur": prompt_ur},
                "materials": _materials(checker, raw.get("materials"), f"{where}.materials", slug),
                "normalization": rules,
                "answers": clean_answers,
            }
        )
    if checker.problems:
        raise ExamFileError(checker.problems)
    return {"exam": exam, "questions": questions}


def check_material_files(validated, materials_root):
    """Optional: confirm every evidence file exists under the labs folder."""
    root = Path(materials_root).resolve()
    missing = []
    for question in validated["questions"]:
        for material in question["materials"]:
            candidate = (root / material["path"].lstrip("/")).resolve()
            if root not in candidate.parents or not candidate.is_file():
                missing.append(f"questions[{question['key']}]: {material['path']} not found under {root}")
    if missing:
        raise ExamFileError(missing)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _signature(values):
    return _canonical({name: values[name] for name in CONTENT_FIELDS})


def _question_values(exam_slug, spec):
    return {
        "category": spec["category"],
        "difficulty": spec["difficulty"],
        "points": spec["points"],
        "max_attempts": spec["max_attempts"],
        "title": spec["title"],
        "prompt": spec["prompt"],
        "materials": spec["materials"],
        "normalization": spec["normalization"],
        "answer_hashes": answers.hash_answers(exam_slug, spec["key"], spec["answers"], spec["normalization"]),
    }


def load_exam(raw_bytes, *, dry_run=False, allow_content_change=False, materials_root=None):
    """Validate and load one exam file. Returns a ``LoadReport`` (counts only)."""
    document = parse_exam_bytes(raw_bytes)
    validated = validate_document(document)
    if materials_root:
        check_material_files(validated, materials_root)
    key_id = answers.answer_key_id()  # raises CtfNotConfigured without a pepper in production
    content_sha256 = hashlib.sha256(raw_bytes if isinstance(raw_bytes, bytes) else raw_bytes.encode("utf-8")).hexdigest()
    exam_spec = validated["exam"]
    slug = exam_spec["slug"]

    with transaction.atomic():
        exam = CtfExam.objects.select_for_update().filter(slug=slug).first()
        report = LoadReport(slug=slug, exam_created=exam is None, dry_run=dry_run, content_sha256=content_sha256)
        if exam is None:
            exam = CtfExam(slug=slug, status=CtfExam.STATUS_DRAFT)
        exam.title = exam_spec["title"]["en"]
        exam.title_ur = exam_spec["title"]["ur"]
        exam.briefing = exam_spec["briefing"]
        exam.rules = exam_spec["rules"]
        exam.opens_at = exam_spec["opens_at"]
        exam.closes_at = exam_spec["closes_at"]
        exam.time_limit_minutes = exam_spec["time_limit_minutes"]
        exam.default_max_attempts = exam_spec["default_max_attempts"]
        exam.content_sha256 = content_sha256
        exam.answer_key_id = key_id
        exam.content_loaded_at = timezone.now()
        exam.save()
        if exam_spec["eligible_course_ids"] is not None:
            exam.eligible_courses.set(exam_spec["eligible_course_ids"])
            report.eligible_courses = len(exam_spec["eligible_course_ids"])

        existing = {question.key: question for question in CtfQuestion.objects.filter(exam=exam).order_by("pk")}
        answered = set(CtfAttempt.objects.filter(exam=exam).values_list("question_id", flat=True).distinct())
        planned = {spec["key"]: (spec, _question_values(slug, spec)) for spec in validated["questions"]}

        changed_with_attempts = []
        for key, (_spec, values) in planned.items():
            question = existing.get(key)
            if question is None or question.pk not in answered:
                continue
            current = {name: getattr(question, name) for name in CONTENT_FIELDS}
            if _signature(current) != _signature(values) or not question.is_active:
                changed_with_attempts.append(key)
        for key, question in existing.items():
            if key not in planned and question.pk in answered and question.is_active:
                changed_with_attempts.append(key)
        report.changed_with_attempts = sorted(changed_with_attempts)
        if changed_with_attempts and not allow_content_change:
            raise ExamFileError(
                [
                    "students have already answered these questions, so they cannot change or be removed: "
                    + ", ".join(report.changed_with_attempts)
                    + ". Re-run with --allow-content-change if you are sure (scores already given stay as they are)."
                ]
            )

        # Retire every existing question first (inside this transaction), so the
        # live questions can swap positions without tripping the unique
        # (exam, order) constraint, which only covers active questions.
        was_active = {key: question.is_active for key, question in existing.items()}
        if existing:
            CtfQuestion.objects.filter(exam=exam).update(is_active=False)

        for key, (spec, values) in planned.items():
            question = existing.get(key)
            if question is None:
                CtfQuestion.objects.create(exam=exam, key=key, order=spec["order"], is_active=True, **values)
                report.created += 1
                continue
            current = {name: getattr(question, name) for name in CONTENT_FIELDS}
            changed = _signature(current) != _signature(values) or not was_active[key]
            for name, value in values.items():
                setattr(question, name, value)
            question.order = spec["order"]
            question.is_active = True
            question.save()
            if changed:
                report.updated += 1
            else:
                report.unchanged += 1

        for key, question in existing.items():
            if key in planned:
                continue
            if question.pk in answered:
                # Already set inactive above; it is never deleted.
                if was_active[key]:
                    report.deactivated += 1
            else:
                question.delete()
                report.removed += 1

        report.question_count = len(planned)
        report.total_points = sum(spec["points"] for spec, _values in planned.values())
        if dry_run:
            transaction.set_rollback(True)
    return report
