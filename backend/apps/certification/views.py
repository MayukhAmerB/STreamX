"""Certification API (``/api/certification/``).

Public
    ``GET hall-of-fame/``: the Hall of Fame (handles only, never real names
    or e-mail), paginated, with counters and featured graduates.

Student (signed in)
    ``GET me/``: my certification results, certificates and delivery status.
    ``GET|PATCH me/preferences/``: delivery channel, WhatsApp opt-out,
    Hall of Fame listing.
    ``GET me/letters/<ref>/``: my congratulations letter (PDF).

Staff
    ``GET staff/decisions/<id>/``, ``POST staff/decisions/<id>/confirm-revocation/``,
    ``POST staff/decisions/<id>/dismiss-revocation/``,
    ``POST staff/deliveries/<id>/resend/``, ``POST staff/exams/<slug>/regrade/``,
    ``POST staff/hall-of-fame/<id>/hide/``, ``.../restore/``, ``.../handle/``.
"""

from __future__ import annotations

from config.response import api_response
from config.throttling import ClientIpAnonRateThrottle, ClientIpUserRateThrottle
from django.http import HttpResponse
from rest_framework import permissions
from rest_framework.views import APIView

from apps.core.errors import NotFound, PermissionDenied, ValidationFailed

from . import hall_of_fame, letter, services
from .models import CertificateDelivery, CertificationDecision, CertificationPreferences, HallOfFameEntry


def _is_staff(user) -> bool:
    return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


def _require_staff(request):
    if not _is_staff(request.user):
        raise PermissionDenied("Staff only.", code="certification_staff_only")


def _int(value, default=1):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class HallOfFameView(APIView):
    permission_classes = [permissions.AllowAny]
    authentication_classes = []
    throttle_classes = [ClientIpAnonRateThrottle]

    def get(self, request):
        data = hall_of_fame.public_payload(
            page=_int(request.GET.get("page"), 1),
            page_size=_int(request.GET.get("page_size"), hall_of_fame.PAGE_SIZE),
            group=str(request.GET.get("batch") or "")[:80],
        )
        response = api_response(data=data)
        response["Cache-Control"] = "public, max-age=60"
        return response


def preferences_dict(prefs: CertificationPreferences, user) -> dict:
    from . import whatsapp

    return {
        "delivery_channel": prefs.delivery_channel,
        "whatsapp_opt_out": prefs.whatsapp_opt_out,
        "hall_of_fame_listed": prefs.hall_of_fame_listed,
        "has_phone": bool(whatsapp.normalize_phone(getattr(user, "phone_number", ""))),
        "whatsapp_available": whatsapp.is_configured(),
        "channels": [value for value, _label in CertificationPreferences.CHANNEL_CHOICES],
    }


class MyPreferencesView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle]

    def get(self, request):
        return api_response(data=preferences_dict(services.preferences_for(request.user), request.user))

    def patch(self, request):
        payload = request.data if isinstance(request.data, dict) else {}
        prefs, _created = CertificationPreferences.objects.get_or_create(user=request.user)
        errors = {}
        if "delivery_channel" in payload:
            value = str(payload.get("delivery_channel") or "")
            if value not in dict(CertificationPreferences.CHANNEL_CHOICES):
                errors["delivery_channel"] = ["Choose email, whatsapp or both."]
            else:
                prefs.delivery_channel = value
        for field in ("whatsapp_opt_out", "hall_of_fame_listed"):
            if field in payload:
                value = payload.get(field)
                if not isinstance(value, bool):
                    errors[field] = ["Must be true or false."]
                else:
                    setattr(prefs, field, value)
        if errors:
            raise ValidationFailed(details=errors)
        prefs.save()
        return api_response(message="Preferences saved.", data=preferences_dict(prefs, request.user))

    put = patch


class MyCertificationsView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle]

    def get(self, request):
        rows = (
            CertificationDecision.objects.filter(user=request.user)
            .select_related("exam", "certificate")
            .prefetch_related("deliveries")
            .order_by("-decided_at")[:50]
        )
        return api_response(data={"results": [services.decision_dict(row) for row in rows]})


class MyLetterView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle]

    def get(self, request, ref):
        decision = (
            CertificationDecision.objects.select_related("certificate", "exam", "user")
            .filter(certificate__reference=str(ref or "")[:40])
            .first()
        )
        if decision is None or (decision.user_id != request.user.pk and not _is_staff(request.user)):
            raise NotFound("Letter not found.", code="certification_letter_not_found")
        if not decision.certificate.is_valid:
            raise NotFound("This certificate was revoked.", code="certification_letter_not_found")
        delivery = CertificateDelivery(decision=decision, certificate=decision.certificate, user=decision.user)
        from .delivery import letter_facts

        data = letter.letter_pdf(letter_facts(delivery))
        response = HttpResponse(data, content_type="application/pdf")
        response["Content-Disposition"] = f'attachment; filename="{letter.letter_filename(decision.certificate.reference)}"'
        response["Cache-Control"] = "private, no-store"
        return response


# --- staff -----------------------------------------------------------------------------------------------
class _StaffView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpUserRateThrottle]

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        _require_staff(request)

    @staticmethod
    def reason(request) -> str:
        return str((request.data or {}).get("reason") or "") if isinstance(request.data, dict) else ""


def _decision_or_404(pk) -> CertificationDecision:
    decision = CertificationDecision.objects.select_related("exam", "certificate").filter(pk=_int(pk, 0)).first()
    if decision is None:
        raise NotFound("Decision not found.", code="certification_decision_not_found")
    return decision


class StaffDecisionView(_StaffView):
    def get(self, request, pk):
        return api_response(data=services.decision_dict(_decision_or_404(pk), staff=True))


class StaffConfirmRevocationView(_StaffView):
    def post(self, request, pk):
        decision = services.confirm_revocation(_decision_or_404(pk), actor=request.user, reason=self.reason(request),
                                               request=request)
        return api_response(message="Revocation confirmed.", data=services.decision_dict(decision, staff=True))


class StaffDismissRevocationView(_StaffView):
    def post(self, request, pk):
        decision = services.dismiss_revocation(_decision_or_404(pk), actor=request.user, reason=self.reason(request))
        return api_response(message="Revocation dismissed.", data=services.decision_dict(decision, staff=True))


class StaffResendView(_StaffView):
    def post(self, request, pk):
        delivery = CertificateDelivery.objects.filter(pk=_int(pk, 0)).first()
        if delivery is None:
            raise NotFound("Delivery not found.", code="certification_delivery_not_found")
        row = services.resend(delivery, actor=request.user, reason=self.reason(request) or "Resent by staff")
        return api_response(message="Queued again.", data={"id": row.pk, "status": row.status, "round": row.round})


class StaffRegradeView(_StaffView):
    def post(self, request, slug):
        from apps.ctf.models import CtfExam

        from .grading import AnswerKeyMismatch

        exam = CtfExam.objects.filter(slug=str(slug or "")[:80]).first()
        if exam is None:
            raise NotFound("Exam not found.", code="ctf_exam_not_found")
        try:
            stats = services.regrade_exam(exam, actor=request.user, reason=self.reason(request) or "Answer key corrected")
        except AnswerKeyMismatch as exc:
            raise ValidationFailed(str(exc), code="certification_answer_key_mismatch") from None
        return api_response(message="Re-graded.", data=stats)


def _entry_or_404(pk) -> HallOfFameEntry:
    entry = HallOfFameEntry.objects.filter(pk=_int(pk, 0)).first()
    if entry is None:
        raise NotFound("Entry not found.", code="hall_of_fame_entry_not_found")
    return entry


class StaffHallOfFameHideView(_StaffView):
    hidden = True

    def post(self, request, pk):
        entry = hall_of_fame.set_hidden(_entry_or_404(pk), hidden=self.hidden, actor=request.user, reason=self.reason(request))
        return api_response(message="Saved.", data={"id": entry.pk, "is_hidden": entry.is_hidden})


class StaffHallOfFameRestoreView(StaffHallOfFameHideView):
    hidden = False


class StaffHallOfFameHandleView(_StaffView):
    def post(self, request, pk):
        handle = (request.data or {}).get("display_handle") if isinstance(request.data, dict) else ""
        entry = hall_of_fame.set_display_handle(_entry_or_404(pk), handle=handle, actor=request.user, reason=self.reason(request))
        return api_response(message="Saved.", data={"id": entry.pk, "display_handle": entry.display_handle})
