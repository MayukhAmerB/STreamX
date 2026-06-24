from pathlib import Path

from django.conf import settings
from django.contrib.auth import authenticate
from django.core import signing
from django.db.models import Count, Q
from django.http import HttpResponse
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from config.audit import log_security_event
from config.client_ip import resolve_client_ip
from config.response import api_response

from .models import Campaign, CampaignVolunteer
from .serializers import (
    CampaignAdminSerializer,
    CampaignPublicSerializer,
    CampaignVolunteerAdminSerializer,
    CampaignVolunteerCreateSerializer,
)

CAMPAIGN_ADMIN_COOKIE = "campaign_admin_session"
CAMPAIGN_ADMIN_COOKIE_MAX_AGE = 60 * 60 * 12


def _campaigns_file(filename):
    packaged_path = Path(__file__).resolve().parent / "pages" / filename
    if packaged_path.exists():
        return packaged_path
    return settings.BASE_DIR.parent / "Campaigns" / filename


def _campaign_page_response(filename):
    path = _campaigns_file(filename)
    if not path.exists():
        return HttpResponse("Campaign page not found.", status=404, content_type="text/plain; charset=utf-8")
    response = HttpResponse(path.read_text(encoding="utf-8"), content_type="text/html; charset=utf-8")
    response["Cache-Control"] = "no-store, max-age=0"
    response["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; "
        "connect-src 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'self'; "
        "object-src 'none'; base-uri 'self'"
    )
    return response


class CampaignPublicPageView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return _campaign_page_response("index.html")


class CampaignAdminPageView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return _campaign_page_response("admin.html")


def _make_admin_cookie(user):
    return signing.dumps(
        {"user_id": user.pk, "staff": bool(user.is_staff), "iat": int(timezone.now().timestamp())},
        salt="campaign-admin-session",
    )


def _get_campaign_admin_user(request):
    raw = request.COOKIES.get(CAMPAIGN_ADMIN_COOKIE, "")
    if not raw:
        return None
    try:
        payload = signing.loads(raw, salt="campaign-admin-session", max_age=CAMPAIGN_ADMIN_COOKIE_MAX_AGE)
    except signing.BadSignature:
        return None

    user_id = payload.get("user_id")
    if not user_id:
        return None
    user_model = settings.AUTH_USER_MODEL
    app_label, model_name = user_model.split(".", 1)
    from django.apps import apps

    User = apps.get_model(app_label, model_name)
    return User.objects.filter(pk=user_id, is_active=True, is_staff=True).first()


class CampaignAdminPermission(permissions.BasePermission):
    def has_permission(self, request, view):
        request.campaign_admin_user = _get_campaign_admin_user(request)
        return request.campaign_admin_user is not None


class CampaignListView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        campaigns = Campaign.objects.filter(is_active=True)
        serializer = CampaignPublicSerializer(campaigns, many=True)
        return api_response(success=True, message="Campaigns fetched.", data=serializer.data)


class CampaignVolunteerCreateView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "campaign_volunteer"

    def post(self, request):
        serializer = CampaignVolunteerCreateSerializer(data=request.data)
        if not serializer.is_valid():
            log_security_event("campaign_volunteer.invalid", request=request, errors=serializer.errors)
            return api_response(
                success=False,
                message="Volunteer registration failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        volunteer = serializer.save(
            source_ip=resolve_client_ip(request),
            user_agent=(request.META.get("HTTP_USER_AGENT", "") or "")[:500],
        )
        log_security_event(
            "campaign_volunteer.created",
            request=request,
            volunteer_id=volunteer.id,
            campaign_id=volunteer.campaign_id,
            whatsapp_number=volunteer.whatsapp_number,
        )
        return api_response(
            success=True,
            message="Volunteer registration received.",
            data={"volunteer_id": volunteer.id, "status": CampaignVolunteer.STATUS_NEW},
            status_code=status.HTTP_201_CREATED,
        )


class CampaignAdminLoginView(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "login"

    def post(self, request):
        username = str(request.data.get("username") or "").strip()
        password = str(request.data.get("password") or "")
        user = authenticate(request=request, username=username, password=password)
        if not user or not user.is_active or not user.is_staff:
            log_security_event("campaign_admin.login_failed", request=request, username=username)
            return api_response(
                success=False,
                message="Invalid campaign admin credentials.",
                status_code=status.HTTP_401_UNAUTHORIZED,
            )

        response = api_response(
            success=True,
            message="Campaign admin session started.",
            data={"username": getattr(user, "email", "") or getattr(user, "username", ""), "is_staff": True},
        )
        response.set_cookie(
            CAMPAIGN_ADMIN_COOKIE,
            _make_admin_cookie(user),
            max_age=CAMPAIGN_ADMIN_COOKIE_MAX_AGE,
            httponly=True,
            secure=not settings.DEBUG,
            samesite="Lax",
            path="/",
        )
        return response


class CampaignAdminLogoutView(APIView):
    authentication_classes = []
    permission_classes = [CampaignAdminPermission]

    def post(self, request):
        response = api_response(success=True, message="Campaign admin session ended.", data=None)
        response.delete_cookie(CAMPAIGN_ADMIN_COOKIE, path="/")
        return response


class CampaignAdminSessionView(APIView):
    authentication_classes = []
    permission_classes = [CampaignAdminPermission]

    def get(self, request):
        user = request.campaign_admin_user
        return api_response(
            success=True,
            message="Campaign admin session is active.",
            data={"username": getattr(user, "email", "") or getattr(user, "username", "")},
        )


class CampaignAdminCampaignListCreateView(APIView):
    authentication_classes = []
    permission_classes = [CampaignAdminPermission]

    def get(self, request):
        campaigns = Campaign.objects.annotate(volunteer_count=Count("volunteers"))
        serializer = CampaignAdminSerializer(campaigns, many=True)
        return api_response(success=True, message="Campaigns fetched.", data=serializer.data)

    def post(self, request):
        serializer = CampaignAdminSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Campaign could not be created.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        campaign = serializer.save()
        return api_response(
            success=True,
            message="Campaign created.",
            data=CampaignAdminSerializer(campaign).data,
            status_code=status.HTTP_201_CREATED,
        )


class CampaignAdminCampaignDetailView(APIView):
    authentication_classes = []
    permission_classes = [CampaignAdminPermission]

    def patch(self, request, pk):
        campaign = Campaign.objects.filter(pk=pk).first()
        if not campaign:
            return api_response(success=False, message="Campaign not found.", status_code=status.HTTP_404_NOT_FOUND)
        serializer = CampaignAdminSerializer(campaign, data=request.data, partial=True)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Campaign could not be updated.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        campaign = serializer.save()
        return api_response(success=True, message="Campaign updated.", data=CampaignAdminSerializer(campaign).data)

    def delete(self, request, pk):
        campaign = Campaign.objects.filter(pk=pk).first()
        if not campaign:
            return api_response(success=False, message="Campaign not found.", status_code=status.HTTP_404_NOT_FOUND)
        campaign.is_active = False
        campaign.save(update_fields=["is_active", "updated_at"])
        return api_response(success=True, message="Campaign archived.", data=None)


class CampaignAdminVolunteerListView(APIView):
    authentication_classes = []
    permission_classes = [CampaignAdminPermission]

    def get(self, request):
        volunteers = CampaignVolunteer.objects.select_related("campaign")
        campaign_id = request.query_params.get("campaign")
        status_filter = request.query_params.get("status")
        search = (request.query_params.get("search") or "").strip()
        if campaign_id:
            volunteers = volunteers.filter(campaign_id=campaign_id)
        if status_filter:
            volunteers = volunteers.filter(status=status_filter)
        if search:
            volunteers = volunteers.filter(
                Q(full_name__icontains=search)
                | Q(whatsapp_number__icontains=search)
                | Q(city__icontains=search)
                | Q(state__icontains=search)
                | Q(campaign__name__icontains=search)
            )
        serializer = CampaignVolunteerAdminSerializer(volunteers[:1000], many=True)
        return api_response(success=True, message="Volunteer registrations fetched.", data=serializer.data)


class CampaignAdminVolunteerDetailView(APIView):
    authentication_classes = []
    permission_classes = [CampaignAdminPermission]

    def patch(self, request, pk):
        volunteer = CampaignVolunteer.objects.select_related("campaign").filter(pk=pk).first()
        if not volunteer:
            return api_response(success=False, message="Volunteer not found.", status_code=status.HTTP_404_NOT_FOUND)
        serializer = CampaignVolunteerAdminSerializer(volunteer, data=request.data, partial=True)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Volunteer could not be updated.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        volunteer = serializer.save()
        return api_response(
            success=True,
            message="Volunteer updated.",
            data=CampaignVolunteerAdminSerializer(volunteer).data,
        )
