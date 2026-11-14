"""Student profile API (``/api/profiles/``). Views map HTTP onto services only.

Every endpoint answers 403 ``feature_disabled`` while the ``public_profiles``
switch is off, except the staff moderation endpoints (moderators can always
hide a profile). JSON responses carry the API CSP
(``config.security.APISecurityHeadersMiddleware``); image responses carry a
sandboxing CSP of their own.
"""

from __future__ import annotations

from django.http import FileResponse
from rest_framework import permissions, serializers
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.views import APIView

from apps.core.errors import NotFound, PermissionDenied, ValidationFailed
from config.response import api_response
from config.throttling import ClientIpUserRateThrottle

from . import services
from .models import ProfileImage, ProfileReport, StudentProfile
from .throttles import (
    ProfilePublicThrottle,
    ProfilePublishThrottle,
    ProfileReadThrottle,
    ProfileReportThrottle,
    ProfileStaffThrottle,
    ProfileUploadThrottle,
    ProfileWriteThrottle,
)

IMAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
READ = [ClientIpUserRateThrottle, ProfileReadThrottle]
WRITE = [ClientIpUserRateThrottle, ProfileWriteThrottle]


def _errors(serializer) -> ValidationFailed:
    return ValidationFailed(details=serializer.errors)


class _Owner(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]

    def get_throttles(self):
        group = READ if self.request.method in ("GET", "HEAD", "OPTIONS") else WRITE
        return [throttle() for throttle in group]

    def profile(self, request) -> StudentProfile:
        services.require_enabled()
        return services.get_or_create_profile(request.user, request=request)

    def ok(self, request, profile, message, **extra):
        data = services.owner_payload(profile, request=request)
        data.update(extra)
        return api_response(success=True, message=message, data=data)


class MyProfileView(_Owner):
    def get(self, request):
        profile = self.profile(request)
        return self.ok(request, profile, "Your profile.")


class DraftSerializer(serializers.Serializer):
    document = serializers.JSONField()
    draft_version = serializers.IntegerField(required=False, allow_null=True)


class MyDraftView(_Owner):
    def put(self, request):
        profile = self.profile(request)
        serializer = DraftSerializer(data=request.data)
        if not serializer.is_valid():
            raise _errors(serializer)
        values = serializer.validated_data
        profile, findings = services.save_draft(
            profile, values["document"], expected_version=values.get("draft_version"), actor=request.user, request=request
        )
        return self.ok(
            request, profile, "Draft saved.", warnings=[finding.as_dict() for finding in findings]
        )


class MyPublishView(_Owner):
    def get_throttles(self):
        return [ClientIpUserRateThrottle(), ProfilePublishThrottle()]

    def post(self, request):
        profile = self.profile(request)
        profile = services.publish(profile, actor=request.user, request=request)
        return self.ok(request, profile, "Your profile is published.")


class MyUnpublishView(_Owner):
    def post(self, request):
        profile = self.profile(request)
        profile = services.unpublish(profile, actor=request.user, request=request)
        return self.ok(request, profile, "Your profile is no longer published.")


class SettingsSerializer(serializers.Serializer):
    visibility = serializers.ChoiceField(choices=StudentProfile.VISIBILITY_CHOICES, required=False)
    show_real_name = serializers.BooleanField(required=False)
    show_on_leaderboards = serializers.BooleanField(required=False)


class MySettingsView(_Owner):
    def patch(self, request):
        profile = self.profile(request)
        serializer = SettingsSerializer(data=request.data)
        if not serializer.is_valid():
            raise _errors(serializer)
        profile = services.update_settings(profile, dict(serializer.validated_data), actor=request.user, request=request)
        return self.ok(request, profile, "Privacy settings saved.")


class HandleSerializer(serializers.Serializer):
    handle = serializers.CharField(max_length=64, allow_blank=False, trim_whitespace=True)


class MyHandleView(_Owner):
    def post(self, request):
        profile = self.profile(request)
        serializer = HandleSerializer(data=request.data)
        if not serializer.is_valid():
            raise _errors(serializer)
        profile = services.change_handle(profile, serializer.validated_data["handle"], actor=request.user, request=request)
        return self.ok(request, profile, "Handle changed.")


class MyHandlePromptDismissView(_Owner):
    """``POST``: the student keeps the automatic handle; the one-time prompt is not shown again."""

    def post(self, request):
        profile = services.dismiss_handle_prompt(self.profile(request), actor=request.user, request=request)
        return self.ok(request, profile, "Handle prompt dismissed.")


class MyPreviewView(_Owner):
    def get(self, request):
        profile = self.profile(request)
        data = services.public_payload(profile, request.user, draft=True)
        return api_response(success=True, message="Draft preview.", data=data)


class MyImagesView(_Owner):
    parser_classes = [MultiPartParser, FormParser]

    def get_throttles(self):
        return [ClientIpUserRateThrottle(), ProfileUploadThrottle()]

    def post(self, request):
        profile = self.profile(request)
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationFailed(details={"file": ["Choose an image to upload."]})
        kind = str(request.data.get("kind") or "")
        image = services.add_image(profile, upload, kind=kind, actor=request.user, request=request)
        profile.refresh_from_db()
        return self.ok(request, profile, "Image added.", image={"id": str(image.id), "kind": image.kind, "src": services.media_url(image.id)})


class MyImageDetailView(_Owner):
    def delete(self, request, image_id):
        profile = self.profile(request)
        services.delete_image(profile, image_id, actor=request.user, request=request)
        profile.refresh_from_db()
        return self.ok(request, profile, "Image deleted.")


# --- public -----------------------------------------------------------------------------------
class PublicProfileView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ProfilePublicThrottle]

    def get(self, request, handle):
        services.require_enabled()
        profile = services.find_by_handle(handle)
        services.check_can_view(profile, request.user)
        if not profile.is_published:
            # Owner or staff opening an unpublished profile: show the draft, marked as a preview.
            data = services.public_payload(profile, request.user, draft=True)
        else:
            data = services.public_payload(profile, request.user)
        response = api_response(success=True, message="Profile.", data=data)
        response["Cache-Control"] = "private, no-store"
        response["X-Robots-Tag"] = "noindex" if profile.visibility != StudentProfile.VISIBILITY_PUBLIC else "noarchive"
        return response


class ReportSerializer(serializers.Serializer):
    reason = serializers.ChoiceField(choices=ProfileReport.REASON_CHOICES)
    details = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")


class ReportProfileView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]

    def get_throttles(self):
        return [ClientIpUserRateThrottle(), ProfileReportThrottle()]

    def post(self, request, handle):
        services.require_enabled()
        profile = services.find_by_handle(handle)
        services.check_can_view(profile, request.user)
        serializer = ReportSerializer(data=request.data)
        if not serializer.is_valid():
            raise _errors(serializer)
        values = serializer.validated_data
        services.report_profile(
            profile, reporter=request.user, reason=values["reason"], details=values.get("details", ""), request=request
        )
        return api_response(
            success=True, message="Thanks. A moderator will review this profile.", data={"reported": True}, status_code=201
        )


class ProfileMediaView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ProfilePublicThrottle]

    def get(self, request, image_id):
        services.require_enabled()
        image = ProfileImage.objects.select_related("profile__user").filter(pk=image_id).first()
        if image is None or not services.can_view_image(image, request.user):
            raise NotFound("Image not found.", code="image_not_found")
        try:
            handle = image.file.open("rb")
        except (OSError, ValueError):
            raise NotFound("Image not found.", code="image_not_found") from None
        response = FileResponse(handle, content_type=image.content_type or "image/webp")
        response["Content-Disposition"] = f'inline; filename="{image.id}.webp"'
        response["X-Content-Type-Options"] = "nosniff"
        response["Content-Security-Policy"] = IMAGE_CSP
        response["Cache-Control"] = "private, max-age=300"
        response["Referrer-Policy"] = "no-referrer"
        response["ETag"] = f'"{image.sha256[:32]}"'
        return response


# --- staff moderation -------------------------------------------------------------------------
class _Staff(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]

    def get_throttles(self):
        return [ClientIpUserRateThrottle(), ProfileStaffThrottle()]

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if not services.is_staff(request.user):
            raise PermissionDenied()


def _report_dict(report: ProfileReport) -> dict:
    return {
        "id": report.pk,
        "handle": report.profile.handle,
        "reason": report.reason,
        "reason_label": report.get_reason_display(),
        "details": report.details,
        "status": report.status,
        "profile_status": report.profile.status,
        "created_at": report.created_at.isoformat(),
    }


class ModerationReportsView(_Staff):
    def get(self, request):
        status = request.query_params.get("status") or ProfileReport.STATUS_OPEN
        if status not in dict(ProfileReport.STATUS_CHOICES):
            raise ValidationFailed(details={"status": ["Unknown status."]})
        rows = ProfileReport.objects.select_related("profile").filter(status=status).order_by("-created_at", "-id")[:200]
        return api_response(success=True, message="Profile reports.", data={"reports": [_report_dict(row) for row in rows]})


class ModerationNoteSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=300, required=False, allow_blank=True, default="")


class ModerationHideView(_Staff):
    def post(self, request, handle):
        profile = services.find_by_handle(handle)
        serializer = ModerationNoteSerializer(data=request.data)
        if not serializer.is_valid():
            raise _errors(serializer)
        profile = services.hide_profile(profile, actor=request.user, reason=serializer.validated_data["reason"], request=request)
        return api_response(success=True, message="Profile hidden.", data={"handle": profile.handle, "status": profile.status})


class ModerationRestoreView(_Staff):
    def post(self, request, handle):
        profile = services.find_by_handle(handle)
        serializer = ModerationNoteSerializer(data=request.data)
        if not serializer.is_valid():
            raise _errors(serializer)
        profile = services.restore_profile(profile, actor=request.user, note=serializer.validated_data["reason"], request=request)
        return api_response(success=True, message="Profile restored.", data={"handle": profile.handle, "status": profile.status})


class ModerationDismissView(_Staff):
    def post(self, request, report_id):
        report = ProfileReport.objects.select_related("profile").filter(pk=report_id).first()
        if report is None:
            raise NotFound("Report not found.", code="report_not_found")
        serializer = ModerationNoteSerializer(data=request.data)
        if not serializer.is_valid():
            raise _errors(serializer)
        report = services.dismiss_report(report, actor=request.user, note=serializer.validated_data["reason"], request=request)
        return api_response(success=True, message="Report dismissed.", data=_report_dict(report))
