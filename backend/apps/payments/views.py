import json
import re
from decimal import Decimal
from urllib.parse import urlencode

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect
from rest_framework import permissions, status
from rest_framework.parsers import JSONParser
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.courses.models import Course, Enrollment
from apps.courses.access import user_has_course_access
from apps.realtime.domain import invalidate_course_join_access_cache
from config.audit import log_security_event
from config.response import api_response

from .models import Payment
from .pricing import get_plan_amount, get_plan_amount_paise
from .provisioning import provision_paid_payment
from .serializers import CreateOrderSerializer, VerifyPaymentSerializer
from .services import (
    RazorpayServiceError,
    create_razorpay_order,
    fetch_razorpay_payment,
    verify_razorpay_signature,
    verify_razorpay_webhook_signature,
)


def _grant_paid_course_access(payment):
    return provision_paid_payment(payment)


def _payment_support_whatsapp_url(payment):
    configured_number = str(
        getattr(settings, "PAYMENT_SUPPORT_WHATSAPP_NUMBER", "") or ""
    )
    whatsapp_number = re.sub(r"\D", "", configured_number)
    if len(whatsapp_number) < 8:
        return ""
    message = (
        "Hello, I completed my course payment. "
        f"Course: {payment.course_title_snapshot or getattr(payment.course, 'title', '')}. "
        f"Invoice: {payment.invoice_number or 'pending'}. "
        f"Generated login: {payment.user_email_snapshot or 'pending'}. "
        "Please guide me through document verification and credential activation."
    )
    return f"https://wa.me/{whatsapp_number}?{urlencode({'text': message})}"


def _payment_success_data(payment):
    return {
        "course_id": payment.course_id or payment.course_id_snapshot,
        "enrolled": True,
        "invoice_number": payment.invoice_number,
        "generated_login": payment.user_email_snapshot,
        "credentials_pending": payment.provisioning_status
        == Payment.PROVISION_AWAITING_ADMIN,
        "access_expires_at": payment.access_expires_at,
        "support_whatsapp_url": _payment_support_whatsapp_url(payment),
    }


def _safe_gateway_entity(entity):
    """Keep useful audit fields without retaining card, VPA, or bank payloads."""
    if not isinstance(entity, dict):
        return {}
    allowed_fields = (
        "id",
        "entity",
        "order_id",
        "amount",
        "amount_paid",
        "amount_due",
        "amount_refunded",
        "currency",
        "receipt",
        "status",
        "attempts",
        "international",
        "method",
        "captured",
        "refund_status",
        "fee",
        "tax",
        "created_at",
        "error_code",
        "error_description",
        "error_source",
        "error_step",
        "error_reason",
    )
    return {
        key: value
        for key in allowed_fields
        if (value := entity.get(key)) is not None
        and isinstance(value, (str, int, float, bool))
    }


def _set_gateway_audit(payment, entity, *, detail_key="payment", event="", failure_reason=""):
    safe_entity = _safe_gateway_entity(entity)
    details = dict(payment.gateway_details or {})
    if safe_entity:
        details[detail_key] = safe_entity
        payment.gateway_details = details
    gateway_status = str(safe_entity.get("status") or "").strip().lower()
    if gateway_status:
        payment.gateway_status = gateway_status
    payment_method = str(safe_entity.get("method") or "").strip().lower()
    if payment_method:
        payment.payment_method = payment_method
    if event:
        payment.last_webhook_event = str(event)[:120]
    if failure_reason:
        payment.failure_reason = str(failure_reason)[:2000]


def _gateway_payment_validation_error(*, payment, callback_data, gateway_payment):
    gateway_payment = gateway_payment if isinstance(gateway_payment, dict) else {}
    payment_id = str(gateway_payment.get("id") or "").strip()
    order_id = str(gateway_payment.get("order_id") or "").strip()
    payment_status = str(gateway_payment.get("status") or "").strip().lower()
    currency = str(gateway_payment.get("currency") or "").strip().upper()

    if payment_id != callback_data["razorpay_payment_id"]:
        return "Razorpay returned a different payment identifier."
    if order_id != payment.razorpay_order_id:
        return "Razorpay payment does not belong to this order."
    if payment_status != "captured":
        return "Payment has not been captured by Razorpay yet."

    try:
        amount_paise = int(gateway_payment.get("amount"))
    except (TypeError, ValueError):
        return "Razorpay returned an invalid payment amount."
    if amount_paise != int(Decimal(payment.amount) * 100):
        return "Razorpay payment amount does not match the course order."
    if currency != str(payment.currency or "").strip().upper():
        return "Razorpay payment currency does not match the course order."
    return None


def process_payment_webhook_payload(*, payload, signature="", request=None, source="api"):
    event = str(payload.get("event") or "").strip().lower()
    payload_data = payload.get("payload") or {}
    payment_entity = ((payload_data.get("payment") or {}).get("entity") or {})
    order_entity = ((payload_data.get("order") or {}).get("entity") or {})
    order_id = str(payment_entity.get("order_id") or order_entity.get("id") or "").strip()
    payment_id = str(payment_entity.get("id") or "").strip()
    payment_status = str(payment_entity.get("status") or "").strip().lower()
    amount_paise = payment_entity.get("amount")
    currency = str(payment_entity.get("currency") or "").strip().upper()

    if not order_id:
        log_security_event(
            "payment.webhook_ignored_missing_order",
            request=request,
            webhook_event=event or None,
            source=source,
        )
        return {
            "success": True,
            "status_code": status.HTTP_200_OK,
            "message": "Webhook ignored.",
            "data": {"processed": False, "reason": "missing_order_id"},
        }

    payment = (
        Payment.objects.select_related("course", "user")
        .filter(razorpay_order_id=order_id)
        .order_by("-created_at")
        .first()
    )
    if not payment:
        log_security_event(
            "payment.webhook_payment_not_found",
            request=request,
            webhook_event=event or None,
            razorpay_order_id=order_id,
            source=source,
        )
        return {
            "success": True,
            "status_code": status.HTTP_200_OK,
            "message": "Webhook ignored.",
            "data": {"processed": False, "reason": "payment_not_found"},
        }

    if amount_paise is not None:
        try:
            expected_amount_paise = int(Decimal(payment.amount) * 100)
            if int(amount_paise) != expected_amount_paise:
                log_security_event(
                    "payment.webhook_amount_mismatch",
                    request=request,
                    payment_id=payment.id,
                    razorpay_order_id=order_id,
                    source=source,
                )
                return {
                    "success": False,
                    "status_code": status.HTTP_400_BAD_REQUEST,
                    "message": "Webhook verification failed.",
                    "errors": {"detail": "Payment amount mismatch."},
                }
        except (TypeError, ValueError, ArithmeticError):
            log_security_event(
                "payment.webhook_invalid_amount",
                request=request,
                payment_id=payment.id,
                razorpay_order_id=order_id,
                source=source,
            )
            return {
                "success": False,
                "status_code": status.HTTP_400_BAD_REQUEST,
                "message": "Webhook verification failed.",
                "errors": {"detail": "Invalid payment amount in webhook payload."},
            }

    if currency and currency != str(payment.currency or "").strip().upper():
        log_security_event(
            "payment.webhook_currency_mismatch",
            request=request,
            payment_id=payment.id,
            razorpay_order_id=order_id,
            source=source,
        )
        return {
            "success": False,
            "status_code": status.HTTP_400_BAD_REQUEST,
            "message": "Webhook verification failed.",
            "errors": {"detail": "Payment currency mismatch."},
        }

    processed = False
    with transaction.atomic():
        payment = (
            Payment.objects.select_for_update()
            .select_related("course", "user")
            .get(pk=payment.pk)
        )
        if event == "payment.captured" or payment_status == "captured":
            if not payment_id or amount_paise is None or not currency:
                log_security_event(
                    "payment.webhook_incomplete_capture",
                    request=request,
                    payment_id=payment.id,
                    razorpay_order_id=order_id,
                    source=source,
                )
                return {
                    "success": False,
                    "status_code": status.HTTP_400_BAD_REQUEST,
                    "message": "Webhook verification failed.",
                    "errors": {"detail": "Captured payment payload is incomplete."},
                }
            if (
                payment.status == Payment.STATUS_PAID
                and payment.razorpay_payment_id
                and payment_id
                and payment.razorpay_payment_id != payment_id
            ):
                log_security_event(
                    "payment.webhook_conflicting_payment_id",
                    request=request,
                    payment_id=payment.id,
                    razorpay_order_id=order_id,
                    source=source,
                )
                return {
                    "success": False,
                    "status_code": status.HTTP_409_CONFLICT,
                    "message": "Webhook verification failed.",
                    "errors": {"detail": "Order is already bound to another payment."},
                }
            update_fields = []
            _set_gateway_audit(payment, payment_entity, event=event)
            update_fields.extend(
                ["gateway_details", "gateway_status", "payment_method", "last_webhook_event"]
            )
            if payment.status != Payment.STATUS_PAID:
                payment.status = Payment.STATUS_PAID
                update_fields.append("status")
            if payment.paid_at is None:
                payment.paid_at = timezone.now()
                update_fields.append("paid_at")
            if payment.failure_reason:
                payment.failure_reason = ""
                update_fields.append("failure_reason")
            if payment_id and payment.razorpay_payment_id != payment_id:
                payment.razorpay_payment_id = payment_id
                update_fields.append("razorpay_payment_id")
            if signature and payment.razorpay_signature != signature:
                payment.razorpay_signature = signature
                update_fields.append("razorpay_signature")
            if update_fields:
                payment.save(update_fields=[*update_fields, "updated_at"])

            _grant_paid_course_access(payment)
            processed = True
            log_security_event(
                "payment.webhook_payment_captured",
                request=request,
                payment_id=payment.id,
                course_id=payment.course_id,
                webhook_event=event or None,
                source=source,
            )
        elif event == "payment.failed" or payment_status == "failed":
            if payment.status != Payment.STATUS_PAID:
                update_fields = []
                failure_reason = (
                    payment_entity.get("error_description")
                    or payment_entity.get("error_reason")
                    or "Razorpay reported that the payment failed."
                )
                _set_gateway_audit(
                    payment,
                    payment_entity,
                    event=event,
                    failure_reason=failure_reason,
                )
                update_fields.extend(
                    [
                        "gateway_details",
                        "gateway_status",
                        "payment_method",
                        "last_webhook_event",
                        "failure_reason",
                    ]
                )
                if payment.status != Payment.STATUS_FAILED:
                    payment.status = Payment.STATUS_FAILED
                    update_fields.append("status")
                if payment_id and payment.razorpay_payment_id != payment_id:
                    payment.razorpay_payment_id = payment_id
                    update_fields.append("razorpay_payment_id")
                if signature and payment.razorpay_signature != signature:
                    payment.razorpay_signature = signature
                    update_fields.append("razorpay_signature")
                if update_fields:
                    payment.save(update_fields=[*update_fields, "updated_at"])
                processed = True
                log_security_event(
                    "payment.webhook_payment_failed",
                    request=request,
                    payment_id=payment.id,
                    course_id=payment.course_id,
                    webhook_event=event or None,
                    source=source,
                )
            else:
                log_security_event(
                    "payment.webhook_ignored_failed_after_paid",
                    request=request,
                    payment_id=payment.id,
                    course_id=payment.course_id,
                    webhook_event=event or None,
                    source=source,
                )
        else:
            log_security_event(
                "payment.webhook_ignored_event",
                request=request,
                payment_id=payment.id,
                course_id=payment.course_id,
                webhook_event=event or None,
                source=source,
            )

    return {
        "success": True,
        "status_code": status.HTTP_200_OK,
        "message": "Webhook processed." if processed else "Webhook ignored.",
        "data": {"processed": processed, "payment_id": payment.id, "status": payment.status},
    }


@method_decorator(csrf_protect, name="dispatch")
class CreateOrderView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "payment_create"

    def post(self, request):
        if not getattr(settings, "DIRECT_COURSE_PAYMENTS_ENABLED", False):
            log_security_event("payment.create_order_disabled", request=request)
            return api_response(
                success=False,
                message="Direct course payment is disabled.",
                errors={"detail": "Course access is managed through admin-approved requests."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        serializer = CreateOrderSerializer(data=request.data)
        if not serializer.is_valid():
            log_security_event("payment.create_order_invalid", request=request, errors=serializer.errors)
            return api_response(
                success=False,
                message="Order creation failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        course = Course.objects.filter(pk=serializer.validated_data["course_id"]).first()
        if (
            not course
            or not course.is_published
            or course.launch_status != Course.STATUS_LIVE
        ):
            log_security_event("payment.create_order_course_unavailable", request=request)
            return api_response(
                success=False,
                message="Course unavailable.",
                errors={"detail": "Course is not currently available for purchase."},
                status_code=status.HTTP_404_NOT_FOUND,
            )

        if request.user.is_authenticated and request.user.id == course.instructor_id:
            log_security_event("payment.create_order_instructor_self_purchase_blocked", request=request, course_id=course.id)
            return api_response(
                success=False,
                message="Invalid purchase request.",
                errors={"detail": "Instructors cannot purchase their own courses."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        plan = serializer.validated_data["plan"]
        if plan == Payment.PLAN_FULL and not course.full_payment_enabled:
            return api_response(
                success=False,
                message="Payment plan unavailable.",
                errors={"detail": "Full payment is not enabled for this course."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if plan == Payment.PLAN_MONTHLY and not course.installment_payment_enabled:
            return api_response(
                success=False,
                message="Payment plan unavailable.",
                errors={"detail": "Monthly payment is not enabled for this course."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        existing_enrollment = (
            Enrollment.objects.filter(user=request.user, course=course).first()
            if request.user.is_authenticated
            else None
        )
        if (
            existing_enrollment
            and existing_enrollment.has_active_access()
            and (
                plan == Payment.PLAN_FULL
                or existing_enrollment.access_type
                in (Enrollment.ACCESS_LEGACY, Enrollment.ACCESS_LIFETIME)
            )
        ):
            log_security_event("payment.create_order_already_enrolled", request=request, course_id=course.id)
            return api_response(
                success=True,
                message="Already enrolled.",
                data={"already_enrolled": True, "course_id": course.id},
            )

        amount = get_plan_amount(course, plan)
        if Decimal(amount) <= 0:
            return api_response(
                success=False,
                message="Payment plan unavailable.",
                errors={"detail": "The selected plan does not have a valid price."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        amount_paise = get_plan_amount_paise(course, plan)
        payment = Payment.objects.create(
            user=request.user if request.user.is_authenticated else None,
            course=course,
            amount=amount,
            currency="INR",
            status=Payment.STATUS_CREATED,
            plan=plan,
            gateway_status="initializing",
            buyer_name=serializer.validated_data["buyer_name"],
            buyer_email=serializer.validated_data["buyer_email"],
            whatsapp_number=serializer.validated_data["whatsapp_number"],
            alternate_number=serializer.validated_data.get("alternate_number", ""),
            age=serializer.validated_data.get("age"),
            country=serializer.validated_data.get("country", ""),
            state=serializer.validated_data.get("state", ""),
            city=serializer.validated_data.get("city", ""),
            pincode=serializer.validated_data.get("pincode", ""),
        )
        try:
            order = create_razorpay_order(
                amount_paise=amount_paise,
                currency="INR",
                receipt=f"p-{payment.internal_reference.hex[:24]}",
            )
        except RazorpayServiceError as exc:
            payment.status = Payment.STATUS_FAILED
            payment.gateway_status = "order_creation_failed"
            payment.failure_reason = str(exc)[:2000]
            payment.save(
                update_fields=[
                    "status",
                    "gateway_status",
                    "failure_reason",
                    "updated_at",
                ]
            )
            log_security_event(
                "payment.create_order_gateway_error",
                request=request,
                course_id=course.id,
                payment_id=payment.id,
            )
            return api_response(
                success=False,
                message="Order creation failed.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        payment.razorpay_order_id = str(order["id"])
        payment.currency = str(order.get("currency") or "INR")
        _set_gateway_audit(payment, order, detail_key="order")
        payment.save(
            update_fields=[
                "razorpay_order_id",
                "currency",
                "gateway_status",
                "gateway_details",
                "updated_at",
            ]
        )
        log_security_event(
            "payment.create_order_success",
            request=request,
            course_id=course.id,
            payment_id=payment.id,
        )
        return api_response(
            success=True,
            message="Razorpay order created.",
            data={
                "payment_id": payment.id,
                "checkout_reference": str(payment.internal_reference),
                "razorpay_order_id": order["id"],
                "amount": order["amount"],
                "currency": order.get("currency", "INR"),
                "key_id": settings.RAZORPAY_KEY_ID,
                "checkout_profile": {
                    "name": payment.buyer_name,
                    "email": payment.buyer_email,
                    "contact": payment.whatsapp_number,
                },
            },
            status_code=status.HTTP_201_CREATED,
        )


@method_decorator(csrf_protect, name="dispatch")
class VerifyPaymentView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "payment_verify"

    def post(self, request):
        if not getattr(settings, "DIRECT_COURSE_PAYMENTS_ENABLED", False):
            log_security_event("payment.verify_disabled", request=request)
            return api_response(
                success=False,
                message="Direct course payment is disabled.",
                errors={"detail": "Course access is managed through admin-approved requests."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        serializer = VerifyPaymentSerializer(data=request.data)
        if not serializer.is_valid():
            log_security_event("payment.verify_invalid", request=request, errors=serializer.errors)
            return api_response(
                success=False,
                message="Payment verification failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        data = serializer.validated_data
        payment_filters = {
            "course_id": data["course_id"],
            "razorpay_order_id": data["razorpay_order_id"],
        }
        checkout_reference = data.get("checkout_reference")
        if checkout_reference:
            payment_filters["internal_reference"] = checkout_reference
        elif request.user.is_authenticated:
            payment_filters["user"] = request.user
        else:
            return api_response(
                success=False,
                message="Payment verification failed.",
                errors={"detail": "Checkout reference is required."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        payment = (
            Payment.objects.select_related("course", "user")
            .filter(**payment_filters)
            .first()
        )
        if not payment:
            log_security_event("payment.verify_payment_not_found", request=request, course_id=data.get("course_id"))
            return api_response(
                success=False,
                message="Payment record not found.",
                errors={"detail": "Payment order not found for this checkout."},
                status_code=status.HTTP_404_NOT_FOUND,
            )

        if payment.status == Payment.STATUS_PAID and payment.razorpay_payment_id == data["razorpay_payment_id"]:
            _grant_paid_course_access(payment)
            payment.refresh_from_db()
            log_security_event("payment.verify_already_paid", request=request, course_id=payment.course_id, payment_id=payment.id)
            return api_response(
                success=True,
                message="Payment already verified.",
                data=_payment_success_data(payment),
            )

        try:
            verify_razorpay_signature(
                razorpay_order_id=data["razorpay_order_id"],
                razorpay_payment_id=data["razorpay_payment_id"],
                razorpay_signature=data["razorpay_signature"],
            )
            gateway_payment = fetch_razorpay_payment(
                razorpay_payment_id=data["razorpay_payment_id"],
            )
        except RazorpayServiceError as exc:
            log_security_event("payment.verify_signature_failed", request=request, course_id=payment.course_id, payment_id=payment.id)
            return api_response(
                success=False,
                message="Payment verification failed.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        gateway_error = _gateway_payment_validation_error(
            payment=payment,
            callback_data=data,
            gateway_payment=gateway_payment,
        )
        if gateway_error:
            _set_gateway_audit(
                payment,
                gateway_payment,
                failure_reason=gateway_error,
            )
            payment.save(
                update_fields=[
                    "gateway_details",
                    "gateway_status",
                    "payment_method",
                    "failure_reason",
                    "updated_at",
                ]
            )
            log_security_event(
                "payment.verify_gateway_state_failed",
                request=request,
                course_id=payment.course_id,
                payment_id=payment.id,
                detail=gateway_error,
            )
            return api_response(
                success=False,
                message="Payment verification failed.",
                errors={"detail": gateway_error},
                status_code=status.HTTP_409_CONFLICT,
            )

        with transaction.atomic():
            payment = (
                Payment.objects.select_for_update()
                .select_related("course", "user")
                .get(pk=payment.pk)
            )
            if payment.status == Payment.STATUS_PAID:
                if payment.razorpay_payment_id != data["razorpay_payment_id"]:
                    return api_response(
                        success=False,
                        message="Payment verification failed.",
                        errors={"detail": "Order is already bound to another payment."},
                        status_code=status.HTTP_409_CONFLICT,
                    )
                _grant_paid_course_access(payment)
                return api_response(
                    success=True,
                    message="Payment already verified.",
                    data=_payment_success_data(payment),
                )
            payment.status = Payment.STATUS_PAID
            payment.razorpay_payment_id = data["razorpay_payment_id"]
            payment.razorpay_signature = data["razorpay_signature"]
            payment.paid_at = timezone.now()
            payment.failure_reason = ""
            _set_gateway_audit(payment, gateway_payment)
            payment.save(
                update_fields=[
                    "status",
                    "razorpay_payment_id",
                    "razorpay_signature",
                    "paid_at",
                    "failure_reason",
                    "gateway_status",
                    "payment_method",
                    "gateway_details",
                    "updated_at",
                ]
            )
            _grant_paid_course_access(payment)
        log_security_event("payment.verify_success", request=request, course_id=payment.course_id, payment_id=payment.id)

        payment.refresh_from_db()
        return api_response(
            success=True,
            message="Payment verified and enrollment created.",
            data=_payment_success_data(payment),
        )


class PaymentWebhookView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        signature = str(request.headers.get("X-Razorpay-Signature", "")).strip()
        raw_body = bytes(request.body or b"")
        try:
            verify_razorpay_webhook_signature(
                payload_body=raw_body,
                razorpay_signature=signature,
            )
        except RazorpayServiceError as exc:
            log_security_event("payment.webhook_signature_failed", request=request)
            return api_response(
                success=False,
                message="Webhook verification failed.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            log_security_event("payment.webhook_invalid_payload", request=request)
            return api_response(
                success=False,
                message="Webhook verification failed.",
                errors={"detail": "Invalid webhook payload."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        event = str(payload.get("event") or "").strip().lower()
        try:
            result = process_payment_webhook_payload(
                payload=payload,
                signature=signature,
                request=request,
                source="api",
            )
        except Exception as exc:  # noqa: BLE001
            log_security_event(
                "payment.webhook_processing_failed",
                request=request,
                webhook_event=event or None,
                error=str(exc)[:1000],
            )
            if bool(getattr(settings, "ASYNC_JOBS_ENABLED", False)):
                try:
                    from apps.users.async_jobs import enqueue_payment_webhook_retry_job

                    retry_job = enqueue_payment_webhook_retry_job(
                        payload=payload,
                        signature=signature,
                        max_attempts=int(getattr(settings, "ASYNC_WEBHOOK_RETRY_MAX_ATTEMPTS", 6)),
                    )
                except Exception:
                    retry_job = None

                if retry_job is not None:
                    return api_response(
                        success=True,
                        message="Webhook queued for retry.",
                        data={
                            "processed": False,
                            "queued": True,
                            "job_id": retry_job.id,
                        },
                        status_code=status.HTTP_202_ACCEPTED,
                    )

            return api_response(
                success=False,
                message="Webhook processing failed.",
                errors={"detail": "Transient webhook processing failure."},
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        return api_response(
            success=bool(result.get("success", True)),
            message=str(result.get("message") or "Webhook processed."),
            data=result.get("data"),
            errors=result.get("errors"),
            status_code=int(result.get("status_code", status.HTTP_200_OK)),
        )


PaymentWebhookStubView = PaymentWebhookView
