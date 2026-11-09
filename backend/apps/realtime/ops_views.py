"""Internal endpoints for the host ops agent that applies server CPU profiles.

The agent is the only component with Docker access. It reads the desired
profile name here and reports what it applied; Django can only choose among the
allow-listed profile names, never commands or values. The endpoints are
disabled unless OPS_AGENT_TOKEN is configured, and nginx refuses /api/internal/
publicly.
"""

import hmac

from django.conf import settings
from django.http import Http404
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import permissions, status
from rest_framework.parsers import JSONParser
from rest_framework.views import APIView

from config.audit import log_security_event
from config.response import api_response

from .models import ServerResourceProfile

_MAX_ERROR_LENGTH = 2000
_PROFILE_NAMES = {name for name, _label in ServerResourceProfile.PROFILE_CHOICES}


def _agent_token_valid(request):
    expected = str(getattr(settings, "OPS_AGENT_TOKEN", "") or "").strip()
    if not expected:
        raise Http404
    header = str(request.headers.get("Authorization", "") or "")
    presented = header[len("Bearer "):].strip() if header.startswith("Bearer ") else ""
    if presented and hmac.compare_digest(presented.encode(), expected.encode()):
        return True
    log_security_event("ops.agent_token_rejected", request=request)
    return False


def _unauthorized():
    return api_response(success=False, message="Unauthorized.", status_code=status.HTTP_401_UNAUTHORIZED)


def _desired_payload(profile):
    return {"profile": profile.profile}


@extend_schema(exclude=True)
class ResourceProfileDesiredView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    throttle_classes = []

    def get(self, request):
        if not _agent_token_valid(request):
            return _unauthorized()
        return api_response(
            success=True,
            message="Desired server resource profile.",
            data=_desired_payload(ServerResourceProfile.get_solo()),
        )


@extend_schema(exclude=True)
class ResourceProfileReportView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    throttle_classes = []
    parser_classes = [JSONParser]

    def post(self, request):
        if not _agent_token_valid(request):
            return _unauthorized()

        data = request.data if isinstance(request.data, dict) else {}
        applied = str(data.get("applied_profile") or "").strip()
        if applied and applied not in _PROFILE_NAMES:
            return api_response(success=False, message="Invalid report.", status_code=status.HTTP_400_BAD_REQUEST)

        profile = ServerResourceProfile.get_solo()
        previous = profile.applied_profile
        now = timezone.now()
        profile.agent_last_seen_at = now
        profile.agent_last_error = str(data.get("error") or "")[:_MAX_ERROR_LENGTH]
        if applied and applied != previous:
            profile.applied_profile = applied
            profile.applied_at = now
        profile.save(update_fields=["agent_last_seen_at", "agent_last_error", "applied_profile", "applied_at"])
        if profile.applied_profile != previous:
            log_security_event(
                "ops.resource_profile_applied",
                request=request,
                previous_profile=previous or None,
                applied_profile=profile.applied_profile,
            )
        return api_response(success=True, message="Report recorded.", data=_desired_payload(profile))
