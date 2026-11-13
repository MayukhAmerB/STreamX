"""Plain factory functions for tests (no third-party factory library).

Every factory takes keyword overrides and fills the rest with valid,
unique defaults, so a test states only what it cares about::

    from tests import factories as f

    student = f.make_user()
    course = f.make_course(price=Decimal("999.00"))
    enrollment = f.make_enrollment(user=student, course=course)   # paid by default
    payment = f.make_payment(user=student, course=course, status="paid")

Related objects are created on demand: ``make_lecture()`` builds a course,
section and instructor for you. Models are imported lazily so importing
this module never touches the app registry before Django is set up.
"""

from __future__ import annotations

import itertools
from decimal import Decimal

DEFAULT_PASSWORD = "StrongFactoryPassword123!"

_sequence = itertools.count(1)


def _next() -> int:
    return next(_sequence)


def make_user(*, email: str | None = None, password: str = DEFAULT_PASSWORD, **overrides):
    from django.contrib.auth import get_user_model

    n = _next()
    fields = {"full_name": f"Test User {n}"}
    fields.update(overrides)
    return get_user_model().objects.create_user(
        email=email or f"user{n}@factory.test",
        password=password,
        **fields,
    )


def make_instructor(**overrides):
    from apps.users.models import User

    overrides.setdefault("role", User.ROLE_INSTRUCTOR)
    return make_user(**overrides)


def make_admin(**overrides):
    from django.contrib.auth import get_user_model

    n = _next()
    return get_user_model().objects.create_superuser(
        email=overrides.pop("email", f"admin{n}@factory.test"),
        password=overrides.pop("password", DEFAULT_PASSWORD),
        **{"full_name": f"Admin {n}", **overrides},
    )


def make_course(**overrides):
    from apps.courses.models import Course

    n = _next()
    fields = {
        "title": f"Factory Course {n}",
        "description": "Factory course description.",
        "price": Decimal("499.00"),
        "is_published": True,
    }
    fields.update(overrides)
    if "instructor" not in fields:
        fields["instructor"] = make_instructor()
    return Course.objects.create(**fields)


def make_section(*, course=None, **overrides):
    from apps.courses.models import Section

    n = _next()
    fields = {"title": f"Module {n}", "order": n}
    fields.update(overrides)
    return Section.objects.create(course=course or make_course(), **fields)


def make_lecture(*, section=None, **overrides):
    from apps.courses.models import Lecture

    n = _next()
    fields = {"title": f"Lecture {n}", "order": n}
    fields.update(overrides)
    return Lecture.objects.create(section=section or make_section(), **fields)


def make_enrollment(*, user=None, course=None, **overrides):
    from apps.courses.models import Enrollment

    fields = {"payment_status": Enrollment.STATUS_PAID}
    fields.update(overrides)
    return Enrollment.objects.create(user=user or make_user(), course=course or make_course(), **fields)


def make_payment(*, user=None, course=None, **overrides):
    from apps.payments.models import Payment

    n = _next()
    course = course or make_course()
    fields = {
        "amount": getattr(course, "price", None) or Decimal("499.00"),
        "currency": "INR",
        "status": Payment.STATUS_CREATED,
        "razorpay_order_id": f"order_factory_{n}",
    }
    fields.update(overrides)
    return Payment.objects.create(user=user, course=course, **fields)


def make_realtime_session(*, host=None, **overrides):
    from apps.realtime.models import RealtimeSession

    n = _next()
    fields = {
        "title": f"Factory Live Room {n}",
        "session_type": RealtimeSession.TYPE_BROADCASTING,
        "status": RealtimeSession.STATUS_SCHEDULED,
    }
    fields.update(overrides)
    return RealtimeSession.objects.create(host=host or make_instructor(), **fields)


def make_ctf_exam(*, eligible_courses=(), **overrides):
    """A published, open exam (1 hour limit) whose answer key matches the
    current pepper. Pass ``eligible_courses=[course]`` to let students in."""
    from datetime import timedelta

    from django.utils import timezone

    from apps.ctf.answers import answer_key_id
    from apps.ctf.models import CtfExam

    n = _next()
    now = timezone.now()
    fields = {
        "slug": f"factory-exam-{n}",
        "title": f"Factory Exam {n}",
        "status": CtfExam.STATUS_PUBLISHED,
        "opens_at": now - timedelta(hours=1),
        "closes_at": now + timedelta(days=1),
        "time_limit_minutes": 60,
        "default_max_attempts": 5,
        "answer_key_id": answer_key_id(),
    }
    fields.update(overrides)
    exam = CtfExam.objects.create(**fields)
    if eligible_courses:
        exam.eligible_courses.set(list(eligible_courses))
    return exam


def make_ctf_question(*, exam=None, answers=("fake answer",), normalization=None, **overrides):
    """A question whose accepted answers are hashed exactly as the loader does."""
    from apps.ctf.answers import hash_answers, validate_rules
    from apps.ctf.models import CtfQuestion

    exam = exam or make_ctf_exam()
    n = _next()
    rules = validate_rules(normalization)
    fields = {
        "key": f"q{n}",
        "order": n,
        "category": "geoint",
        "difficulty": "hard",
        "points": 100,
        "title": {"en": f"Question {n}", "ur": ""},
        "prompt": {"en": {"task": "Find the thing.", "answer_format": "Exact name"}},
        "materials": [],
    }
    fields.update(overrides)
    fields["normalization"] = rules
    fields["answer_hashes"] = hash_answers(exam.slug, fields["key"], answers, rules)
    return CtfQuestion.objects.create(exam=exam, **fields)
