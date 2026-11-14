"""``GET /api/me/identity/``: the signed-in student's own identity block.

Read-only and auto-filled: the Console shows it at the top of the report
submission and exam screens, and the labs Examination tab asks for it
through the LMS. ``?course=<id>`` scopes the stats to one batch.
"""

from __future__ import annotations

from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle, ClientIpUserRateThrottle
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import permissions
from rest_framework.views import APIView

from . import identity
from .identity_serializers import StudentIdentitySerializer


class MeIdentityView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]
    throttle_scope = "console_read"

    @extend_schema(
        operation_id="me_identity_retrieve",
        parameters=[OpenApiParameter("course", int, required=False, description="Scope the stats to one batch.")],
        responses={200: StudentIdentitySerializer},
    )
    def get(self, request):
        course_id = None
        raw = str(request.query_params.get("course") or "").strip()
        if raw.isdigit():
            course_id = int(raw)
        # The student's own header: unreleased report marks never count here.
        block = identity.block_for_user(request.user, course_id=course_id, include_unreleased=False)
        response = api_response(data=StudentIdentitySerializer(block).data)
        response["Cache-Control"] = "private, no-store"
        return response


class ExamCandidateIdentityView(APIView):
    """``GET /api/ctf/exams/<slug>/identity/``: the candidate block for one exam paper.

    Lives under ``/api/ctf/`` so the labs Examination tab can read it (the
    labs origin is scoped to the CTF API, config/labs_origin.py). Once the
    student started, the handle is the snapshot taken at start and the most
    recent handle is shown next to it; stats are scoped to their batch. Only
    the caller's own data is returned, so no exam access check is needed.
    """

    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]
    throttle_scope = "console_read"

    @extend_schema(operation_id="ctf_exam_identity_retrieve", responses={200: StudentIdentitySerializer})
    def get(self, request, slug):
        from apps.ctf.models import CtfParticipation

        participation = (
            CtfParticipation.objects.filter(exam__slug=slug, user=request.user)
            .only("pk", "batch_course_id", *identity.SNAPSHOT_FIELDS)
            .first()
        )
        block = identity.block_for_user(
            request.user,
            record=participation,
            course_id=participation.batch_course_id if participation else None,
            include_unreleased=False,
        )
        response = api_response(data=StudentIdentitySerializer(block).data)
        response["Cache-Control"] = "private, no-store"
        return response
