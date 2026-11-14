"""Certificate API (``/api/engagement/certificates/`` and ``/api/engagement/staff/certificates/``).

Public endpoints need no sign-in and work whatever the ``engagement`` switch
says: a certificate that was issued stays verifiable. They expose the holder's
name and the achievement only (no e-mail, phone, user id or revocation reason).

``<ref>`` is a reference number (any case, spaces or dashes) or the older
achievement slug; anything but the canonical reference answers ``301`` to the
canonical URL, so ``/certificates/<slug>`` and ``/certificates/asi-2026-...``
both end at ``/certificates/ASI-2026-...``.
"""

from __future__ import annotations

from urllib.parse import urlencode

from config.response import api_response
from config.throttling import ClientIpAnonRateThrottle, ClientIpUserRateThrottle
from django.http import HttpResponse, HttpResponsePermanentRedirect
from django.urls import reverse
from django.utils.html import escape
from rest_framework import permissions, serializers
from rest_framework.views import APIView

from apps.core.errors import PermissionDenied, ValidationFailed

from . import certificate_render, certificates
from .throttles import CertificateLookupThrottle, EngagementPublicThrottle, EngagementStaffThrottle

PUBLIC_MAX_AGE = 60
FILE_MAX_AGE = 300


def _canonical(request, ref: str, url_name: str):
    """``(certificate, None)`` or ``(None, redirect)`` when ``ref`` is not the canonical reference."""
    certificate, canonical = certificates.resolve(ref)
    if canonical:
        return certificate, None
    location = reverse(url_name, kwargs={"ref": certificate.reference})
    query = request.GET.urlencode()
    response = HttpResponsePermanentRedirect(location + (f"?{query}" if query else ""))
    response["Cache-Control"] = f"public, max-age={PUBLIC_MAX_AGE}"
    response["X-Robots-Tag"] = "noindex"
    return None, response


def _public_headers(response, max_age: int):
    response["Cache-Control"] = f"public, max-age={int(max_age)}"
    response["X-Robots-Tag"] = "noindex"
    response["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


def _absolute(request, path: str) -> str:
    origin = certificates.public_origin()
    return f"{origin}{path}" if origin.startswith("http") else request.build_absolute_uri(path)


class CertificateView(APIView):
    """``GET /api/engagement/certificates/<ref>/``: verify a certificate."""

    permission_classes = [permissions.AllowAny]
    authentication_classes = []
    throttle_classes = [ClientIpAnonRateThrottle, CertificateLookupThrottle]

    def get(self, request, ref):
        certificate, redirect = _canonical(request, ref, "engagement-certificate")
        if redirect is not None:
            return redirect
        valid = certificate.is_valid
        response = api_response(
            success=True,
            message="This certificate is genuine." if valid else "This certificate was revoked.",
            data=certificates.public_dict(certificate, request),
        )
        return _public_headers(response, PUBLIC_MAX_AGE)


class _CertificateFileView(APIView):
    permission_classes = [permissions.AllowAny]
    authentication_classes = []
    throttle_classes = [ClientIpAnonRateThrottle, EngagementPublicThrottle]
    url_name = ""
    content_type = ""
    extension = ""
    always_attachment = False

    def render(self, certificate) -> bytes:  # pragma: no cover - abstract
        raise NotImplementedError

    def get(self, request, ref):
        certificate, redirect = _canonical(request, ref, self.url_name)
        if redirect is not None:
            return redirect
        response = HttpResponse(self.render(certificate), content_type=self.content_type)
        attachment = self.always_attachment or request.GET.get("download") in ("1", "true")
        filename = f"{certificate.reference}{self.extension}"
        response["Content-Disposition"] = f'{"attachment" if attachment else "inline"}; filename="{filename}"'
        return _public_headers(response, FILE_MAX_AGE)


class CertificatePdfView(_CertificateFileView):
    url_name = "engagement-certificate-pdf"
    content_type = "application/pdf"
    extension = ".pdf"
    always_attachment = True

    def render(self, certificate):
        return certificate_render.certificate_pdf(certificate)


class CertificatePngView(_CertificateFileView):
    url_name = "engagement-certificate-png"
    content_type = "image/png"
    extension = ".png"

    def render(self, certificate):
        return certificate_render.certificate_png(certificate)


class CertificateOgView(_CertificateFileView):
    url_name = "engagement-certificate-og"
    content_type = "image/png"
    extension = "-preview.png"

    def render(self, certificate):
        return certificate_render.og_png(certificate)


class CertificateShareView(APIView):
    """``GET .../share/``: a tiny HTML page with Open Graph tags for link-preview crawlers.

    Crawlers (LinkedIn, WhatsApp, X, Slack) do not run JavaScript, so the SPA
    page cannot give them the certificate image. The gateway can send crawler
    user agents asking for ``/certificates/<ref>`` here; people are forwarded
    to the page at once.
    """

    permission_classes = [permissions.AllowAny]
    authentication_classes = []
    throttle_classes = [ClientIpAnonRateThrottle, EngagementPublicThrottle]

    def get(self, request, ref):
        certificate, redirect = _canonical(request, ref, "engagement-certificate-share")
        if redirect is not None:
            return redirect
        valid = certificate.is_valid
        page = certificates.public_url(certificate.reference)
        # People who land here follow this link; nginx always gives "?view=page" the SPA (no loop).
        human = f"{page}?view=page"
        version = certificates.render_version(certificate)
        image = _absolute(request, reverse("engagement-certificate-og", kwargs={"ref": certificate.reference}) + "?" + urlencode({"v": version}))
        name = certificate.recipient_name or "Certificate holder"
        title = f"{name}: {certificate.heading}" if valid else f"Revoked certificate {certificate.reference}"
        description = (
            f"{certificate.title}. Reference {certificate.reference}. Issued by {certificates.ISSUER_NAME}."
            if valid
            else f"{certificates.ISSUER_NAME} revoked this certificate. It is no longer valid."
        )
        tags = [
            ("name", "robots", "noindex"),
            ("property", "og:type", "website"),
            ("property", "og:site_name", certificates.ISSUER_NAME),
            ("property", "og:title", title),
            ("property", "og:description", description),
            ("property", "og:url", page),
            ("property", "og:image", image),
            ("property", "og:image:width", "1200"),
            ("property", "og:image:height", "630"),
            ("property", "og:image:alt", f"{certificate.heading} for {name}, reference {certificate.reference}"),
            ("name", "twitter:card", "summary_large_image"),
            ("name", "twitter:title", title),
            ("name", "twitter:description", description),
            ("name", "twitter:image", image),
            ("name", "description", description),
        ]
        head = "\n".join(f'<meta {attr}="{escape(key)}" content="{escape(value)}">' for attr, key, value in tags)
        html = (
            '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n'
            f"<title>{escape(title)} | {escape(certificates.ISSUER_NAME)}</title>\n"
            f'<link rel="canonical" href="{escape(page)}">\n{head}\n'
            f'<meta http-equiv="refresh" content="0; url={escape(human)}">\n'
            f'</head><body><p><a href="{escape(human)}">View certificate {escape(certificate.reference)}</a></p></body></html>\n'
        )
        response = HttpResponse(html, content_type="text/html; charset=utf-8")
        _public_headers(response, FILE_MAX_AGE)
        # The gateway serves this at /certificates/<ref> to link-preview crawlers only:
        # a shared cache must never hand it to a person.
        response["Cache-Control"] = "private, no-store"
        response["Vary"] = "User-Agent"
        return response


# --- staff ---------------------------------------------------------------------------------------------
class _ReasonSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=300)


class _NameSerializer(_ReasonSerializer):
    recipient_name = serializers.CharField(max_length=200)


def _staff(request):
    user = request.user
    if not (user and user.is_authenticated and (user.is_staff or user.is_superuser)):
        raise PermissionDenied("Only staff can do this.", code="engagement_staff_only")


def _validated(serializer_class, data):
    serializer = serializer_class(data=data)
    if not serializer.is_valid():
        raise ValidationFailed(details=serializer.errors)
    return serializer.validated_data


class _StaffCertificateView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle, EngagementStaffThrottle]

    def certificate(self, request, ref):
        _staff(request)
        certificate, _canonical_ref = certificates.resolve(ref)
        return certificate


class StaffCertificateView(_StaffCertificateView):
    """``GET``: the certificate with its holder id and full audit trail."""

    def get(self, request, ref):
        certificate = self.certificate(request, ref)
        return api_response(success=True, message="Certificate.", data=certificates.staff_dict(certificate, request))


class StaffCertificateNameView(_StaffCertificateView):
    """``POST {recipient_name, reason}``: correct the printed name (same reference, revision + 1)."""

    def post(self, request, ref):
        certificate = self.certificate(request, ref)
        values = _validated(_NameSerializer, request.data)
        row = certificates.correct_name(
            certificate, recipient_name=values["recipient_name"], actor=request.user, reason=values["reason"], request=request
        )
        return api_response(success=True, message="Name corrected and certificate re-issued.", data=certificates.staff_dict(row, request))


class StaffCertificateRevokeView(_StaffCertificateView):
    def post(self, request, ref):
        certificate = self.certificate(request, ref)
        values = _validated(_ReasonSerializer, request.data)
        row = certificates.revoke(certificate, actor=request.user, reason=values["reason"], request=request)
        return api_response(success=True, message="Certificate revoked.", data=certificates.staff_dict(row, request))


class StaffCertificateReinstateView(_StaffCertificateView):
    def post(self, request, ref):
        certificate = self.certificate(request, ref)
        values = _validated(_ReasonSerializer, request.data)
        row = certificates.reinstate(certificate, actor=request.user, reason=values["reason"], request=request)
        return api_response(success=True, message="Certificate reinstated.", data=certificates.staff_dict(row, request))
