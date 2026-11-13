"""HTTP mapping for CTF exams (``/api/ctf/``), called from the labs site.

Business rules live in ``services.py``; visibility rules in ``access.py``.
The labs page calls these endpoints cross-origin with credentials; CORS for
the labs origin is limited to ``/api/ctf/`` (see ``signals.py`` and
``config/labs_origin.py``).
"""

from __future__ import annotations

from config.audit import log_security_event
from config.client_ip import resolve_client_ip
from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle, ClientIpUserRateThrottle
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.parsers import JSONParser
from rest_framework.views import APIView

from apps.core.errors import Conflict
from apps.core.idempotency import IdempotencyMixin

from . import access, presenters, services
from .serializers import (
    AttemptRequestSerializer,
    AttemptResponseSerializer,
    ExamDetailSerializer,
    ExamListSerializer,
    ParticipationResponseSerializer,
)


def _ok(serializer_class, payload, message="", status_code=200):
    return api_response(message=message, data=serializer_class(payload).data, status_code=status_code)


class _CtfView(APIView):
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]
    throttle_scope = "ctf_read"
    parser_classes = [JSONParser]


class ExamListView(_CtfView):
    @extend_schema(operation_id="ctf_exams_list", responses={200: ExamListSerializer})
    def get(self, request):
        now = timezone.now()
        is_staff = access.is_staff_user(request.user)
        exams = list(access.visible_exams(request.user).order_by("opens_at", "id"))
        participations = presenters.participations_by_exam(request.user, exams)
        results = [
            presenters.exam_summary(
                exam,
                services.expire_if_due(participations.get(exam.pk), now),
                is_staff=is_staff,
                at=now,
            )
            for exam in exams
        ]
        return _ok(ExamListSerializer, {"results": results, "server_time": now})


class ExamDetailView(_CtfView):
    @extend_schema(operation_id="ctf_exams_retrieve", responses={200: ExamDetailSerializer})
    def get(self, request, slug):
        now = timezone.now()
        exam = access.exam_or_404(request.user, slug)
        participation = services.expire_if_due(
            exam.participations.filter(user=request.user).first(), now
        )
        payload = presenters.exam_detail(exam, participation, is_staff=access.is_staff_user(request.user), at=now)
        return _ok(ExamDetailSerializer, payload)


def _log_refusal(request, exc, exam, question_key=""):
    log_security_event(
        "ctf.submission_refused",
        request=request,
        reason=exc.code,
        exam=exam.slug,
        question=question_key,
    )


class ExamStartView(_CtfView):
    throttle_scope = "ctf_attempt"

    @extend_schema(
        operation_id="ctf_exams_start_create",
        request=None,
        responses={200: ParticipationResponseSerializer, 201: ParticipationResponseSerializer},
    )
    def post(self, request, slug):
        exam = access.exam_or_404(request.user, slug)
        participation, created = services.start_participation(exam=exam, user=request.user)
        return _ok(
            ParticipationResponseSerializer,
            {"participation": presenters.participation_dict(participation)},
            message="Exam started. Good luck." if created else "You have already started this exam.",
            status_code=201 if created else 200,
        )


class AttemptCreateView(IdempotencyMixin, _CtfView):
    idempotency_scope = "ctf.attempt"
    idempotency_required = True
    throttle_scope = "ctf_attempt"

    @extend_schema(
        operation_id="ctf_exams_questions_attempts_create",
        request=AttemptRequestSerializer,
        responses={201: AttemptResponseSerializer},
        parameters=[OpenApiParameter("Idempotency-Key", str, OpenApiParameter.HEADER, required=True)],
    )
    def post(self, request, slug, key):
        exam = access.exam_or_404(request.user, slug)
        serializer = AttemptRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            outcome = services.submit_attempt(
                exam=exam,
                user=request.user,
                question_key=key,
                answer=serializer.validated_data["answer"],
                client_ip=resolve_client_ip(request),
                user_agent=request.headers.get("User-Agent", ""),
            )
        except Conflict as exc:
            _log_refusal(request, exc, exam, key)
            raise
        attempt = outcome.attempt
        payload = {
            "attempt": {
                "attempt_number": attempt.attempt_number,
                "correct": attempt.is_correct,
                "points_awarded": attempt.points_awarded,
                "attempts_remaining": outcome.attempts_remaining,
            },
            "participation": presenters.participation_dict(outcome.participation),
        }
        return _ok(
            AttemptResponseSerializer,
            payload,
            message="Correct." if attempt.is_correct else "Incorrect.",
            status_code=201,
        )


class ExamSubmitView(_CtfView):
    throttle_scope = "ctf_attempt"

    @extend_schema(
        operation_id="ctf_exams_submit_create",
        request=None,
        responses={200: ParticipationResponseSerializer},
    )
    def post(self, request, slug):
        exam = access.exam_or_404(request.user, slug)
        participation = services.finish_participation(exam=exam, user=request.user)
        return _ok(
            ParticipationResponseSerializer,
            {"participation": presenters.participation_dict(participation)},
            message="Exam submitted.",
        )
