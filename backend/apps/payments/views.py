import json
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from rest_framework import permissions, status
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.courses.models import Course, Enrollment
from config.audit import log_security_event
from config.response import api_response

from .models import Payment
from .serializers import CreateOrderSerializer, VerifyPaymentSerializer
from .services import (
    RazorpayServiceError,
    create_razorpay_order,
    verify_razorpay_signature,
    verify_razorpay_webhook_signature,
)


def process_payment_webhook_payload(*, payload, signature="", request=None, source="api"):
    event = str(payload.get("event") or "").strip().lower()
    payload_data = payload.get("payload") or {}
    payment_entity = ((payload_data.get("payment") or {}).get("entity") or {})
    order_entity = ((payload_data.get("order") or {}).get("entity") or {})
    order_id = str(payment_entity.get("order_id") or order_entity.get("id") or "").strip()
    payment_id = str(payment_entity.get("id") or "").strip()
    payment_status = str(payment_entity.get("status") or "").strip().lower()
    amount_paise = payment_entity.get("amount")

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

    processed = False
    with transaction.atomic():
        if event == "payment.captured" or payment_status == "captured":
            update_fields = []
            if payment.status != Payment.STATUS_PAID:
                payment.status = Payment.STATUS_PAID
                update_fields.append("status")
            if payment_id and payment.razorpay_payment_id != payment_id:
                payment.razorpay_payment_id = payment_id
                update_fields.append("razorpay_payment_id")
            if signature and payment.razorpay_signature != signature:
                payment.razorpay_signature = signature
                update_fields.append("razorpay_signature")
            if update_fields:
                payment.save(update_fields=[*update_fields, "updated_at"])

            enrollment, created = Enrollment.objects.get_or_create(
                user=payment.user,
                course=payment.course,
                defaults={"payment_status": Enrollment.STATUS_PAID},
            )
            if not created and enrollment.payment_status != Enrollment.STATUS_PAID:
                enrollment.payment_status = Enrollment.STATUS_PAID
                enrollment.save(update_fields=["payment_status"])
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


class CreateOrderView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "payment_create"

    def post(self, request):
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
        if not course or not course.is_published:
            log_security_event("payment.create_order_course_unavailable", request=request)
            return api_response(
                success=False,
                message="Course unavailable.",
                errors={"detail": "Course not found or not published."},
                status_code=status.HTTP_404_NOT_FOUND,
            )

        if request.user.id == course.instructor_id:
            log_security_event("payment.create_order_instructor_self_purchase_blocked", request=request, course_id=course.id)
            return api_response(
                success=False,
                message="Invalid purchase request.",
                errors={"detail": "Instructors cannot purchase their own courses."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        existing_enrollment = Enrollment.objects.filter(
            user=request.user, course=course, payment_status=Enrollment.STATUS_PAID
        ).exists()
        if existing_enrollment:
            log_security_event("payment.create_order_already_enrolled", request=request, course_id=course.id)
            return api_response(
                success=True,
                message="Already enrolled.",
                data={"already_enrolled": True, "course_id": course.id},
            )

        amount_paise = int(Decimal(course.price) * 100)
        try:
            order = create_razorpay_order(
                amount_paise=amount_paise,
                currency="INR",
                receipt=f"course-{course.id}-user-{request.user.id}",
            )
        except RazorpayServiceError as exc:
            log_security_event("payment.create_order_gateway_error", request=request, course_id=course.id)
            return api_response(
                success=False,
                message="Order creation failed.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        payment = Payment.objects.create(
            user=request.user,
            course=course,
            razorpay_order_id=order["id"],
            amount=course.price,
            currency=order.get("currency", "INR"),
            status=Payment.STATUS_CREATED,
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
                "razorpay_order_id": order["id"],
                "amount": order["amount"],
                "currency": order.get("currency", "INR"),
                "key_id": None,
            },
            status_code=status.HTTP_201_CREATED,
        )


class VerifyPaymentView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "payment_verify"

    def post(self, request):
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
        payment = (
            Payment.objects.select_related("course", "user")
            .filter(
                user=request.user,
                course_id=data["course_id"],
                razorpay_order_id=data["razorpay_order_id"],
            )
            .first()
        )
        if not payment:
            log_security_event("payment.verify_payment_not_found", request=request, course_id=data.get("course_id"))
            return api_response(
                success=False,
                message="Payment record not found.",
                errors={"detail": "Payment order not found for this user/course."},
                status_code=status.HTTP_404_NOT_FOUND,
            )

        if payment.status == Payment.STATUS_PAID and payment.razorpay_payment_id == data["razorpay_payment_id"]:
            enrollment, _ = Enrollment.objects.get_or_create(
                user=request.user,
                course=payment.course,
                defaults={"payment_status": Enrollment.STATUS_PAID},
            )
            if enrollment.payment_status != Enrollment.STATUS_PAID:
                enrollment.payment_status = Enrollment.STATUS_PAID
                enrollment.save(update_fields=["payment_status"])
            log_security_event("payment.verify_already_paid", request=request, course_id=payment.course_id, payment_id=payment.id)
            return api_response(
                success=True,
                message="Payment already verified.",
                data={"course_id": payment.course_id, "enrolled": True},
            )

        try:
            verify_razorpay_signature(
                razorpay_order_id=data["razorpay_order_id"],
                razorpay_payment_id=data["razorpay_payment_id"],
                razorpay_signature=data["razorpay_signature"],
            )
        except RazorpayServiceError as exc:
            payment.status = Payment.STATUS_FAILED
            payment.razorpay_payment_id = data["razorpay_payment_id"]
            payment.razorpay_signature = data["razorpay_signature"]
            payment.save(
                update_fields=["status", "razorpay_payment_id", "razorpay_signature", "updated_at"]
            )
            log_security_event("payment.verify_signature_failed", request=request, course_id=payment.course_id, payment_id=payment.id)
            return api_response(
                success=False,
                message="Payment verification failed.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            payment.status = Payment.STATUS_PAID
            payment.razorpay_payment_id = data["razorpay_payment_id"]
            payment.razorpay_signature = data["razorpay_signature"]
            payment.save(
                update_fields=["status", "razorpay_payment_id", "razorpay_signature", "updated_at"]
            )
            enrollment, created = Enrollment.objects.get_or_create(
                user=request.user,
                course=payment.course,
                defaults={"payment_status": Enrollment.STATUS_PAID},
            )
            if not created and enrollment.payment_status != Enrollment.STATUS_PAID:
                enrollment.payment_status = Enrollment.STATUS_PAID
                enrollment.save(update_fields=["payment_status"])
        log_security_event("payment.verify_success", request=request, course_id=payment.course_id, payment_id=payment.id)

        return api_response(
            success=True,
            message="Payment verified and enrollment created.",
            data={"course_id": payment.course_id, "enrolled": True},
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
