"""HTTP mapping for ``/api/console/today/``. OWNER: WS-C."""

from __future__ import annotations

from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle, ClientIpUserRateThrottle
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import permissions
from rest_framework.views import APIView

from apps.core.errors import ValidationFailed

from . import today


class TodayView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]
    throttle_scope = "console_read"

    @extend_schema(
        operation_id="console_today_retrieve",
        parameters=[OpenApiParameter("workspace", str, enum=list(today.WORKSPACES), required=False)],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        workspace = str(request.query_params.get("workspace") or "learn").strip().lower()
        if workspace not in today.WORKSPACES:
            raise ValidationFailed(details={"workspace": ["Choose learn or teach."]})
        return api_response(data=today.build_today(request.user, workspace, request=request))
