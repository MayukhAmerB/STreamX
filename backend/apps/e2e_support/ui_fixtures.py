"""E2E fixtures for the UI overhaul pages (WS-I).

Used through ``POST /api/__e2e__/fixture/<name>/`` (``views.FIXTURES``):

``features``      read or set the feature switches (``{"set": {"teaching": true}}``)
                  through ``apps.core.features.set_feature`` as the seeded admin,
                  i.e. audited like an admin flip.
``attention``     the admin attention payload (``apps.console_api.attention``).
``admin-queues``  fills the admin "needs attention" queues with a small,
                  deterministic set of rows built with the production models:
                  enrolment + live-class requests, a report waiting for a grade,
                  a recording to review, a failed upload, a payment awaiting
                  credentials, a new lead and an unanswered lecture question.
                  Idempotent per seed (a second call adds nothing).

Everything is created relative to the (frozen) server clock so screenshots are
stable. Nothing here runs outside the E2E settings.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger("apps.e2e_support")

ADMIN_QUEUE_MARK = "E2E queue"


def _admin():
    User = get_user_model()
    return User.objects.filter(is_superuser=True).order_by("pk").first() or User.objects.filter(is_staff=True).order_by(
        "pk"
    ).first()


def _user(email):
    return get_user_model().objects.filter(email=email).first()


# --- features ---------------------------------------------------------------


def features_fixture(body):
    """Read the switches, or set them: ``{"set": {"teaching": true}}``."""
    from apps.core import features

    changes = body.get("set") or {}
    if changes:
        admin = _admin()
        for key, enabled in changes.items():
            if features.is_enabled(str(key)) == bool(enabled):
                continue  # no-op writes nothing (and keeps the history clean)
            features.set_feature(str(key), bool(enabled), by=admin, note="e2e fixture")
        invalidate = getattr(features, "invalidate_cache", None)
        if callable(invalidate):
            invalidate()
    return {"features": features.snapshot()}


def attention_fixture(_body):
    """The admin attention payload for the seeded admin."""
    from apps.console_api import attention

    return attention.get_queues(_admin())


# --- admin queues -----------------------------------------------------------


def _step(created, name, build):
    """Build one queue row in its own savepoint: one model drifting must not
    hide the others (the response says which rows exist)."""
    try:
        with transaction.atomic():
            value = build()
        created[name] = value
    except Exception as exc:  # noqa: BLE001 - reported to the journey, not swallowed
        logger.exception("e2e admin-queues: %s failed", name)
        created[name] = {"error": f"{type(exc).__name__}: {exc}"[:300]}


def admin_queues_fixture(_body):
    from apps.courses.models import (
        Course,
        Enrollment,
        Lecture,
        LectureQuestion,
        LiveClass,
        LiveClassEnrollment,
        PublicEnrollmentLead,
    )

    now = timezone.now()
    course = Course.objects.order_by("pk").first()
    outsider = _user("outsider@e2e.test")
    student1 = _user("student1@e2e.test")
    student2 = _user("student2@e2e.test")
    admin = _admin()
    if course is None or outsider is None or admin is None:
        return {"error": "seed first (reset)"}

    if PublicEnrollmentLead.objects.filter(message__startswith=ADMIN_QUEUE_MARK).exists():
        return {"created": {}, "already": True}

    created: dict = {}

    def enrolment_request():
        row = Enrollment.objects.create(
            user=outsider, course=course, payment_status=Enrollment.STATUS_PENDING, access_type=Enrollment.ACCESS_LIFETIME
        )
        _age(row, "enrolled_at", now - timedelta(days=2, hours=3))
        return {"id": row.pk}

    def live_class_request():
        live_class = LiveClass.objects.order_by("pk").first()
        row = LiveClassEnrollment.objects.create(user=outsider, live_class=live_class, status=LiveClassEnrollment.STATUS_PENDING)
        _age(row, "created_at", now - timedelta(days=1, hours=2))
        return {"id": row.pk, "live_class": live_class.title}

    def lead():
        row = PublicEnrollmentLead.objects.create(
            course=course,
            email="lead@e2e.test",
            phone_number="+919800000001",
            whatsapp_number="+919800000001",
            message=f"{ADMIN_QUEUE_MARK}: I would like to join the next OSINT batch.",
            source_path="/courses",
        )
        _age(row, "created_at", now - timedelta(hours=7))
        return {"id": row.pk}

    def question():
        lecture = Lecture.objects.filter(section__course=course).order_by("section__order", "order").first()
        row = LectureQuestion.objects.create(
            user=student1, lecture=lecture, question="How do I verify a profile photo is not reused?"
        )
        _age(row, "created_at", now - timedelta(hours=20))
        return {"id": row.pk, "lecture_id": lecture.pk}

    def report_to_grade():
        from apps.reports.models import ReportSubmission, ReportTask

        fields = {
            "course": course,
            "title": "Profile the target company",
            "brief": "Collect public facts about the target company and cite every source.",
            "due_at": now + timedelta(days=2),
            "status": ReportTask.STATUS_PUBLISHED,
            "max_marks": Decimal("10.00"),
        }
        if _has_field(ReportTask, "created_by"):
            fields["created_by"] = admin
        task = ReportTask.objects.create(**fields)
        submitted_at = now - timedelta(days=1, hours=3)
        row = ReportSubmission.objects.create(
            task=task,
            student=student2,
            target_name="Acme Analytics",
            target_key="acme analytics",
            status=ReportSubmission.STATUS_SUBMITTED,
            first_submitted_at=submitted_at,
            submitted_at=submitted_at,
        )
        return {"task_id": task.pk, "submission_id": row.pk}

    def recording_to_review():
        from apps.realtime.models import RealtimeSession
        from apps.realtime.recording.models import ClassRecording

        session = RealtimeSession.objects.filter(title="E2E mentoring meeting").first()
        row = ClassRecording.objects.create(
            session=session,
            source=ClassRecording.SOURCE_SERVER,
            state=ClassRecording.STATE_PUBLISHED,
            needs_review=True,
            review_reason="Placed in the automatic \"Class recordings\" module.",
            started_by=admin,
            started_at=now - timedelta(hours=5),
            finalized_at=now - timedelta(hours=4),
            published_at=now - timedelta(hours=4),
            duration_seconds=3540,
        )
        _age(row, "created_at", now - timedelta(hours=5))
        return {"id": row.pk}

    def failed_upload():
        from apps.realtime.models import RealtimeSession
        from apps.recording_uploads.models import RecordingUpload

        session = RealtimeSession.objects.filter(title="E2E OBS broadcast").first()
        row = RecordingUpload.objects.create(
            owner=admin,
            session=session,
            filename="2026-11-13 19-00-04.mkv",
            extension="mkv",
            content_type="video/x-matroska",
            total_bytes=96 * 1024 * 1024,
            chunk_bytes=32 * 1024 * 1024,
            chunk_count=3,
            status=RecordingUpload.STATUS_FAILED,
            error="The file is not a playable video (E2E fixture).",
            expires_at=now + timedelta(days=2),
        )
        # The queue ages failures by when they failed (updated_at).
        _age(row, "created_at", now - timedelta(hours=26))
        _age(row, "updated_at", now - timedelta(hours=25))
        return {"id": str(row.pk)}

    def payment():
        from apps.payments.models import Payment

        row = Payment.objects.create(
            user=outsider,
            course=course,
            amount=Decimal("1499.00"),
            status=Payment.STATUS_PAID,
            provisioning_status=Payment.PROVISION_AWAITING_ADMIN,
            razorpay_order_id="order_E2E1042",
            razorpay_payment_id="pay_E2E1042",
            buyer_name="Omar Outsider",
            buyer_email=outsider.email,
            paid_at=now - timedelta(hours=6),
        )
        _age(row, "created_at", now - timedelta(hours=6))
        return {"id": row.pk}

    for name, build in (
        ("enrolment_request", enrolment_request),
        ("live_class_request", live_class_request),
        ("lead", lead),
        ("question", question),
        ("report_to_grade", report_to_grade),
        ("recording_to_review", recording_to_review),
        ("failed_upload", failed_upload),
        ("payment", payment),
    ):
        _step(created, name, build)
    _forget_attention_cache()
    return {"created": created}


def _age(row, field, when):
    """Back-date an auto timestamp so queues read "oldest 2 d" (fixture data only)."""
    if _has_field(type(row), field):
        type(row).objects.filter(pk=row.pk).update(**{field: when})


def _has_field(model, name):
    try:
        model._meta.get_field(name)
        return True
    except Exception:  # noqa: BLE001
        return False


def _forget_attention_cache():
    """The attention payload is cached for 30 s; a fixture must show at once."""
    from django.core.cache import cache

    try:
        from apps.console_api import attention

        forget = getattr(attention, "bump_version", None) or getattr(attention, "invalidate_cache", None)
        if callable(forget):
            forget()
            return
    except Exception:  # noqa: BLE001
        pass
    cache.clear()
