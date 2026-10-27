from config.audit import log_security_event
from config.client_ip import resolve_client_ip
from config.response import api_response
from config.turnstile import enforce_turnstile
from drf_spectacular.utils import extend_schema
from rest_framework import permissions, status
from rest_framework.throttling import AnonRateThrottle, ScopedRateThrottle
from rest_framework.views import APIView

from .india_locations import location_directory
from .models import JoinApplication, JoinFormSettings
from .serializers import (
    JoinApplicationCreateResponseSerializer,
    JoinApplicationCreateSerializer,
    JoinFormSettingsResponseSerializer,
    JoinLocationDirectoryResponseSerializer,
)


class JoinLocationDirectoryThrottle(AnonRateThrottle):
    scope = "join_location_directory"
    rate = "120/min"


class JoinLocationDirectoryView(APIView):
    authentication_classes = []
    permission_classes = (permissions.AllowAny,)
    throttle_classes = (JoinLocationDirectoryThrottle,)

    @extend_schema(
        operation_id="join_locations_list",
        tags=("Join Al Syed",),
        responses={200: JoinLocationDirectoryResponseSerializer},
    )
    def get(self, request):
        response = api_response(message="State and district directory fetched.", data=location_directory())
        response["Cache-Control"] = "public, max-age=3600, stale-while-revalidate=86400"
        return response


class JoinFormSettingsView(APIView):
    authentication_classes = []
    permission_classes = (permissions.AllowAny,)
    throttle_classes = (JoinLocationDirectoryThrottle,)

    @extend_schema(
        operation_id="join_settings_retrieve",
        tags=("Join Al Syed",),
        responses={200: JoinFormSettingsResponseSerializer},
    )
    def get(self, request):
        settings_row = JoinFormSettings.load()
        response = api_response(
            message="Joining form settings fetched.",
            data={"instagram_url": settings_row.instagram_url},
        )
        response["Cache-Control"] = "public, max-age=60, stale-while-revalidate=120"
        return response


class JoinApplicationCreateView(APIView):
    authentication_classes = []
    permission_classes = (permissions.AllowAny,)
    throttle_classes = (ScopedRateThrottle,)
    throttle_scope = "join_application"

    @extend_schema(
        operation_id="join_applications_create",
        tags=("Join Al Syed",),
        request=JoinApplicationCreateSerializer,
        responses={201: JoinApplicationCreateResponseSerializer, 400: JoinApplicationCreateResponseSerializer},
    )
    def post(self, request):
        turnstile_response = enforce_turnstile(request, action="join_alsyed")
        if turnstile_response is not None:
            return turnstile_response

        serializer = JoinApplicationCreateSerializer(data=request.data)
        if not serializer.is_valid():
            log_security_event("join_application.invalid", request=request, errors=serializer.errors)
            return api_response(
                success=False,
                message="Joining form submission failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        application = serializer.save(
            source_ip=resolve_client_ip(request),
            user_agent=(request.META.get("HTTP_USER_AGENT", "") or "")[:500],
        )
        log_security_event(
            "join_application.created",
            request=request,
            application_id=application.id,
            role=application.role,
        )
        return api_response(
            message="Joining form received.",
            data={"application_id": application.id, "status": application.status},
            status_code=status.HTTP_201_CREATED,
        )
