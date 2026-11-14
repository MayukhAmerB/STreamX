"""Deterministic seed data for the end-to-end journeys.

``seed()`` assumes an empty database (``reset()`` flushes first) and returns a
manifest (ids, e-mails, passwords) the Playwright journeys read through the
control API. Every row is built with the production models and services.
"""

from __future__ import annotations

import json
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone

PASSWORD = "E2e-Pass-2026!secure"
EXAM_SLUG = "e2e-osint-exam"
CONSOLE_EXAM_SLUG = "e2e-console-exam"

USERS = {
    "admin": {"email": "admin@e2e.test", "full_name": "Ayesha Admin", "staff": True},
    "instructor": {"email": "instructor@e2e.test", "full_name": "Imran Instructor", "role": "instructor"},
    "student1": {"email": "student1@e2e.test", "full_name": "Sana Student"},
    "student2": {"email": "student2@e2e.test", "full_name": "Bilal Student"},
    "outsider": {"email": "outsider@e2e.test", "full_name": "Omar Outsider"},
}

# Exam answers (fixture only; the loader stores peppered hashes, never these).
EXAM_QUESTIONS = [
    {
        "key": "first-handle",
        "order": 1,
        "category": "socmint",
        "difficulty": "medium",
        "points": 10,
        "title": {"en": "Find the handle"},
        "prompt": {"en": {"task": "Which username does the target use on the forum?", "answer_format": "username"}},
        "answers": ["night_owl_42"],
    },
    {
        "key": "second-city",
        "order": 2,
        "category": "geoint",
        "difficulty": "hard",
        "points": 20,
        "title": {"en": "Name the city"},
        "prompt": {"en": {"task": "In which city was the photo taken?", "answer_format": "City name"}},
        "answers": ["Lahore"],
    },
]


def exam_document(*, slug, title, course_ids=None, opens_at=None, closes_at=None, time_limit=None):
    exam = {"slug": slug, "title": {"en": title}, "briefing": {"en": ["E2E exam briefing."]}, "rules": {"en": ["Work alone."]}}
    if opens_at is not None:
        exam["opens_at"] = opens_at.isoformat()
    if closes_at is not None:
        exam["closes_at"] = closes_at.isoformat()
    if time_limit is not None:
        exam["time_limit_minutes"] = time_limit
    if course_ids is not None:
        exam["eligible_course_ids"] = list(course_ids)
    return {"schema_version": 1, "exam": exam, "questions": EXAM_QUESTIONS}


def _user(key, spec):
    from apps.users.models import TermsAcceptance, User
    from apps.users.terms import TERMS_VERSION

    user = User.objects.create_user(email=spec["email"], password=PASSWORD, full_name=spec["full_name"])
    user.role = spec.get("role", User.ROLE_STUDENT)
    user.is_staff = bool(spec.get("staff"))
    user.is_superuser = bool(spec.get("staff"))
    user.terms_accepted_version = TERMS_VERSION
    user.terms_accepted_at = timezone.now()
    user.save()
    TermsAcceptance.objects.create(user=user, terms_version=TERMS_VERSION)
    return user


def _course(instructor):
    from apps.courses.models import Course, Lecture, LectureResource, Section

    course = Course.objects.create(
        title="OSINT Foundations",
        batch="Batch 7",
        description="Open-source intelligence from first principles: collection, verification and reporting.",
        category=Course.CATEGORY_OSINT,
        level=Course.LEVEL_BEGINNER,
        launch_status=Course.STATUS_LIVE,
        price=Decimal("1499.00"),
        instructor=instructor,
        is_published=True,
        is_flagship=True,
    )
    modules = []
    lectures = []
    for order, (title, lecture_titles) in enumerate(
        [
            ("Module 1: Introduction to OSINT", ["What OSINT is", "Setting up a research workspace"]),
            ("Module 2: Search engine intelligence", ["Search operators", "Verifying sources"]),
        ],
        start=1,
    ):
        module = Section.objects.create(course=course, title=title, order=order, description=f"{title} (E2E).")
        modules.append(module)
        for index, lecture_title in enumerate(lecture_titles, start=1):
            lecture = Lecture(section=module, title=lecture_title, order=index, is_published=True, is_preview=False)
            lecture.save()
            lectures.append(lecture)
    first = lectures[0]
    first.video_file.save("intro.mp4", ContentFile(b"\x00\x00\x00\x18ftypmp42E2E-LECTURE-VIDEO"), save=True)
    resource = LectureResource(lecture=first, title="Workspace checklist", order=1)
    resource.resource_file.save("workspace-checklist.pdf", ContentFile(b"%PDF-1.4\n% E2E resource\n%%EOF\n"), save=True)
    return course, modules, lectures, resource


def _live_classes(course, admin):
    from apps.courses.models import LiveClass, LiveClassEnrollment
    from apps.realtime.models import RealtimeSession

    def live_class(title, minutes=60):
        return LiveClass.objects.create(
            title=title, description=f"{title} (E2E).", linked_course=course, class_duration_minutes=minutes
        )

    obs_class = live_class("OSINT live: OBS class")
    studio_class = live_class("OSINT live: Host Studio class")
    meeting_class = live_class("OSINT live: mentoring meeting")
    sessions = {
        "obs": RealtimeSession.objects.create(
            title="E2E OBS broadcast",
            description="OBS class for the end-to-end journey.",
            session_type=RealtimeSession.TYPE_BROADCASTING,
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            host=admin,
            linked_course=course,
            linked_live_class=obs_class,
        ),
        "studio": RealtimeSession.objects.create(
            title="E2E Host Studio broadcast",
            description="Browser Host Studio class.",
            session_type=RealtimeSession.TYPE_BROADCASTING,
            stream_service=RealtimeSession.STREAM_SERVICE_ALSYED,
            host=admin,
            linked_course=course,
            linked_live_class=studio_class,
        ),
        "meeting": RealtimeSession.objects.create(
            title="E2E mentoring meeting",
            description="LiveKit meeting.",
            session_type=RealtimeSession.TYPE_MEETING,
            host=admin,
            linked_course=course,
            linked_live_class=meeting_class,
        ),
    }
    classes = {"obs": obs_class, "studio": studio_class, "meeting": meeting_class}
    return classes, sessions, LiveClassEnrollment


def _exam(course, now):
    from apps.ctf.loader import load_exam
    from apps.ctf.models import CtfExam

    document = exam_document(
        slug=EXAM_SLUG,
        title="E2E OSINT examination",
        course_ids=[course.pk],
        opens_at=now - timedelta(days=1),
        closes_at=now + timedelta(days=7),
        time_limit=120,
    )
    load_exam(json.dumps(document).encode("utf-8"))
    exam = CtfExam.objects.get(slug=EXAM_SLUG)
    exam.status = CtfExam.STATUS_PUBLISHED
    exam.published_at = now
    # Announced already: the journeys look at attempts, not notifications.
    exam.publish_notified_at = now
    exam.opening_soon_notified_at = now
    exam.save()
    return exam


def _pentesting_catalog() -> dict:
    """WS catalog-plans: the 20 browsable, not-for-sale Pentesting courses, the
    disabled platform plans and the free OSINT directory (switches stay off)."""
    from apps.courses.management.commands.seed_pentesting_catalog import apply_actions, plan_actions
    from apps.osint_labs.management.commands.import_osint_directory import DEFAULT_FILE, import_rows, load_rows
    from apps.payments.platform_plans import seed_platform_plans

    apply_actions(plan_actions())
    seed_platform_plans(apply=True)
    paths, rows = load_rows(DEFAULT_FILE)
    import_rows(paths, rows, apply=True)
    from apps.courses.models import Course

    courses = dict(Course.objects.filter(slug__startswith="pt-").values_list("slug", "id"))
    return {"courseId": courses.get("pt-command-line"), "courses": courses}


@transaction.atomic
def seed() -> dict:
    from apps.courses.models import Enrollment, LiveClassEnrollment
    from apps.reports.models import ReportPolicy
    from apps.site_media.models import YouTubeChannel

    now = timezone.now()
    users = {key: _user(key, spec) for key, spec in USERS.items()}
    course, modules, lectures, resource = _course(users["instructor"])
    for key in ("student1", "student2"):
        Enrollment.objects.create(
            user=users[key],
            course=course,
            payment_status=Enrollment.STATUS_PAID,
            access_type=Enrollment.ACCESS_LIFETIME,
        )
    classes, sessions, _ = _live_classes(course, users["admin"])
    for key in ("student1", "student2"):
        for live_class in classes.values():
            LiveClassEnrollment.objects.create(
                user=users[key], live_class=live_class, status=LiveClassEnrollment.STATUS_APPROVED
            )
    # Self-service weekly reports with the owner's defaults (no admin work per week).
    ReportPolicy.objects.create(course=course, self_service=True, updated_by=users["admin"])
    exam = _exam(course, now)
    channel = YouTubeChannel.objects.filter(pk=1).first() or YouTubeChannel(pk=1)
    channel.section_enabled = True
    channel.channel_title = "Al Syed (E2E)"
    channel.save()
    pentesting = _pentesting_catalog()

    return {
        "password": PASSWORD,
        "users": {key: {"id": user.pk, "email": user.email, "name": user.full_name} for key, user in users.items()},
        "course": {"id": course.pk, "slug": course.slug, "title": course.title},
        "modules": [{"id": module.pk, "title": module.title} for module in modules],
        "lectures": [{"id": lecture.pk, "title": lecture.title, "module_id": lecture.section_id} for lecture in lectures],
        "resource": {
            "id": resource.pk,
            "lecture_id": resource.lecture_id,
            "media_path": f"{settings.MEDIA_URL}{resource.resource_file.name}",
        },
        "lecture_video_media_path": f"{settings.MEDIA_URL}{lectures[0].video_file.name}",
        "live_classes": {key: {"id": item.pk, "title": item.title} for key, item in classes.items()},
        "sessions": {key: {"id": item.pk, "title": item.title, "room": item.room_name} for key, item in sessions.items()},
        "exam": {"id": exam.pk, "slug": exam.slug, "title": exam.title},
        "console_exam_slug": CONSOLE_EXAM_SLUG,
        "exam_answers": {question["key"]: question["answers"][0] for question in EXAM_QUESTIONS},
        "pentesting": pentesting,
    }
