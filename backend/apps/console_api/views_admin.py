"""HTTP mapping for ``/api/admin/`` (Console Admin workspace). OWNER: WS-G.

Staff only (``IsStaffMember``); finer Django model permissions are applied by
each service (attention, requests, health, activity). Every response uses the
project envelope (``config.response.api_response``).
"""

from __future__ import annotations

from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle, ClientIpUserRateThrottle
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.views import APIView

from apps.core.errors import ValidationFailed

from . import activity, attention, health, recordings, requests, search
from .permissions import IsStaffMember


def _int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _body(request) -> dict:
    body = request.data
    if not isinstance(body, dict):
        raise ValidationFailed(details={"body": ["Send a JSON object."]})
    return body


class _AdminView(APIView):
    permission_classes = [IsStaffMember]
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]
    throttle_scope = "console_read"


class _AdminActionView(_AdminView):
    throttle_scope = "admin_action"


class AttentionView(_AdminView):
    @extend_schema(operation_id="admin_attention_retrieve", responses={200: OpenApiTypes.OBJECT})
    def get(self, request):
        return api_response(data=attention.get_queues(request.user))


class SearchView(_AdminView):
    throttle_scope = "admin_search"

    @extend_schema(
        operation_id="admin_search_retrieve",
        parameters=[OpenApiParameter("q", str, required=True)],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        return api_response(data=search.search(request.user, request.query_params.get("q", "")))


class RequestsView(_AdminView):
    @extend_schema(
        operation_id="admin_requests_list",
        parameters=[
            OpenApiParameter("status", str, enum=list(requests.STATUSES), required=False),
            OpenApiParameter("kind", str, enum=list(requests.KIND_FILTERS), required=False),
            OpenApiParameter("q", str, required=False),
            OpenApiParameter("page", int, required=False),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        params = request.query_params
        return api_response(
            data=requests.list_requests(
                request.user,
                status=params.get("status") or "pending",
                kind=params.get("kind") or requests.KIND_ALL,
                q=params.get("q") or "",
                page=_int(params.get("page"), 1),
                page_size=_int(params.get("page_size"), requests.DEFAULT_PAGE_SIZE),
            )
        )


class RequestActionsView(_AdminActionView):
    @extend_schema(operation_id="admin_requests_action", request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
    def post(self, request):
        body = _body(request)
        result = requests.act(request.user, ids=body.get("ids"), action=str(body.get("action") or ""), request=request)
        return api_response(data=result)


class RecordingsView(_AdminView):
    @extend_schema(
        operation_id="admin_recordings_list",
        parameters=[
            OpenApiParameter("filter", str, enum=["", *recordings.FILTERS], required=False),
            OpenApiParameter("page", int, required=False),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        params = request.query_params
        return api_response(
            data=recordings.list_recordings(
                request.user,
                filter_key=params.get("filter") or "",
                page=_int(params.get("page"), 1),
                page_size=_int(params.get("page_size"), recordings.DEFAULT_PAGE_SIZE),
            )
        )


class RecordingDetailView(_AdminView):
    @extend_schema(operation_id="admin_recordings_retrieve", responses={200: OpenApiTypes.OBJECT})
    def get(self, request, item_id):
        return api_response(data=recordings.get_recording(request.user, item_id))


class RecordingActionView(_AdminActionView):
    @extend_schema(operation_id="admin_recordings_action", request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
    def post(self, request, item_id):
        body = _body(request)
        result = recordings.act(request.user, item_id, str(body.get("action") or ""), request=request)
        return api_response(message=result["message"], data=result)


class HealthView(_AdminView):
    @extend_schema(operation_id="admin_health_retrieve", responses={200: OpenApiTypes.OBJECT})
    def get(self, request):
        return api_response(data=health.system_health(request.user))


class HealthRetryView(_AdminActionView):
    @extend_schema(operation_id="admin_health_retry", request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
    def post(self, request):
        body = _body(request)
        return api_response(data=health.retry(request.user, kind=str(body.get("kind") or ""), ids=body.get("ids")))


class ActivityView(_AdminView):
    @extend_schema(
        operation_id="admin_activity_list",
        parameters=[
            OpenApiParameter("group", str, required=False),
            OpenApiParameter("before", int, required=False),
            OpenApiParameter("limit", int, required=False),
        ],
        responses={200: OpenApiTypes.OBJECT},
    )
    def get(self, request):
        params = request.query_params
        return api_response(
            data=activity.recent(
                request.user,
                group=params.get("group") or "",
                before=params.get("before"),
                limit=_int(params.get("limit"), activity.DEFAULT_LIMIT),
            )
        )
