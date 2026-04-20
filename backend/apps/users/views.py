from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.conf import settings
from django.core.mail import EmailMessage
from django.db import transaction
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
import pyotp
from rest_framework import permissions, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.exceptions import TokenError

from config.audit import log_security_event
from config.client_ip import resolve_client_ip
from config.cookies import REFRESH_COOKIE, clear_auth_cookies, set_auth_cookies
from config.response import api_response
from config.throttling import LoginRateThrottle
from config.turnstile import enforce_turnstile, turnstile_public_config

from .async_jobs import async_jobs_enabled, enqueue_email_job
from .serializers import (
    GoogleLoginSerializer,
    LoginSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    RegisterSerializer,
    ContactMessageSerializer,
    ChangePasswordSerializer,
    ProfileUpdateSerializer,
    TermsAcceptSerializer,
    TwoFactorCodeSerializer,
    TwoFactorDisableSerializer,
    UserSerializer,
)
from .models import AuthConfiguration, TermsAcceptance
from .security import clear_failed_login, get_lockout_state, register_failed_login
from .session_policy import (
    SESSION_VERSION_CLAIM,
    get_active_session_version,
    should_enforce_single_session,
    token_matches_active_session,
)
from .services import GoogleAuthError, verify_google_credential
from .terms import TERMS_BODY, TERMS_LAST_UPDATED, TERMS_TITLE, TERMS_VERSION

User = get_user_model()


def _registration_enabled():
    return bool(AuthConfiguration.get_solo().registration_enabled)


def _self_service_credentials_enabled():
    return bool(getattr(settings, "ACCOUNT_SELF_SERVICE_CREDENTIALS_ENABLED", False))


def _rotate_single_session_version(user):
    if not should_enforce_single_session(user):
        return get_active_session_version(user)

    with transaction.atomic():
        locked_user = User.objects.select_for_update().get(pk=user.pk)
        locked_user.active_session_version = get_active_session_version(locked_user) + 1
        locked_user.save(update_fields=["active_session_version"])
        _revoke_all_refresh_tokens_for_user(locked_user)
        user.active_session_version = locked_user.active_session_version

    return get_active_session_version(user)


def _issue_tokens_for_user(user, *, rotate_session=False):
    if rotate_session:
        _rotate_single_session_version(user)
    refresh = RefreshToken.for_user(user)
    if should_enforce_single_session(user):
        refresh[SESSION_VERSION_CLAIM] = get_active_session_version(user)
    return str(refresh.access_token), str(refresh)


def _blacklist_refresh_token_string(refresh_token):
    token_value = str(refresh_token or "").strip()
    if not token_value:
        return
    try:
        token = RefreshToken(token_value)
        token.blacklist()
    except Exception:
        # Blacklist app may be unavailable or token already invalid/blacklisted.
        return


def _revoke_all_refresh_tokens_for_user(user):
    if not user:
        return
    try:
        from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
    except Exception:
        return

    outstanding_tokens = OutstandingToken.objects.filter(user=user).only("id")
    for outstanding in outstanding_tokens:
        BlacklistedToken.objects.get_or_create(token=outstanding)


def _serialize_user(user, request=None):
    return UserSerializer(user, context={"request": request} if request else {}).data


def _serialize_terms():
    return {
        "title": TERMS_TITLE,
        "version": TERMS_VERSION,
        "last_updated": TERMS_LAST_UPDATED,
        "body": TERMS_BODY,
    }


def _attach_csrf_token(response, request):
    if request is None:
        return response
    token = get_token(request)
    if isinstance(getattr(response, "data", None), dict):
        response.data["csrf_token"] = token
    response["X-CSRFToken"] = token
    return response


def _refresh_token_error_response(request, *, message, detail):
    response = api_response(
        success=False,
        message=message,
        errors={"detail": detail},
        status_code=status.HTTP_401_UNAUTHORIZED,
    )
    clear_auth_cookies(response)
    return _attach_csrf_token(response, request)


def _auth_success_response(user, message, request=None, *, rotate_session=True):
    access, refresh = _issue_tokens_for_user(user, rotate_session=rotate_session)
    response = api_response(
        success=True,
        message=message,
        data=_serialize_user(user, request=request),
        status_code=status.HTTP_200_OK,
    )
    set_auth_cookies(response, access, refresh)
    return _attach_csrf_token(response, request)


class RegisterView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]

    def post(self, request):
        if not _registration_enabled():
            return api_response(
                success=False,
                message="Registration is currently disabled.",
                errors={"detail": "Only admin-created accounts can log in right now."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        turnstile_response = enforce_turnstile(request, action="register")
        if turnstile_response is not None:
            return turnstile_response
        serializer = RegisterSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Registration failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        user = serializer.save()
        return _auth_success_response(user, "Registration successful.", request=request)


class LoginView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]
    throttle_classes = [LoginRateThrottle, ScopedRateThrottle]
    throttle_scope = "login"

    def post(self, request):
        if request.query_params:
            log_security_event(
                "auth.login_query_params_blocked",
                request=request,
                query_keys=sorted([str(key) for key in request.query_params.keys()])[:20],
            )
            return api_response(
                success=False,
                message="Login failed.",
                errors={"detail": "Credentials must not be sent in URL query parameters."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        email = User.objects.normalize_auth_email(request.data.get("email", ""))
        is_locked, attempts, max_failures = get_lockout_state(email, request)
        if is_locked:
            log_security_event(
                "auth.login_locked",
                request=request,
                email=email or None,
                attempts=attempts,
                max_failures=max_failures,
            )
            return api_response(
                success=False,
                message="Login temporarily blocked due to repeated failed attempts.",
                errors={
                    "detail": "Too many failed login attempts. Please wait and try again.",
                    "code": "login_temporarily_locked",
                },
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            )

        turnstile_response = enforce_turnstile(request, action="auth")
        if turnstile_response is not None:
            return turnstile_response

        serializer = LoginSerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            attempts = register_failed_login(email, request)
            log_security_event(
                "auth.login_failed",
                request=request,
                email=email or None,
                attempts=attempts,
                errors=serializer.errors,
            )
            return api_response(
                success=False,
                message="Login failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        user = serializer.validated_data["user"]
        clear_failed_login(email, request)
        log_security_event("auth.login_success", request=request, target_user_id=user.id, target_email=user.email)
        return _auth_success_response(user, "Login successful.", request=request)


class LogoutView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        _blacklist_refresh_token_string(request.COOKIES.get(REFRESH_COOKIE))
        response = api_response(success=True, message="Logged out successfully.", data=None)
        clear_auth_cookies(response)
        return response


class RefreshTokenView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        refresh_token = request.COOKIES.get(REFRESH_COOKIE)
        if not refresh_token:
            return _refresh_token_error_response(
                request,
                message="Refresh token missing.",
                detail="Refresh token missing.",
            )
        try:
            refresh = RefreshToken(refresh_token)
            user = User.objects.get(id=refresh["user_id"])
        except (TokenError, User.DoesNotExist, KeyError) as exc:
            return _refresh_token_error_response(
                request,
                message="Invalid refresh token.",
                detail=str(exc),
            )
        if not token_matches_active_session(refresh, user):
            _blacklist_refresh_token_string(refresh_token)
            return _refresh_token_error_response(
                request,
                message="Session expired.",
                detail="This account is active on another device. Please log in again.",
            )
        issued_refresh = refresh
        if bool(getattr(settings, "SIMPLE_JWT", {}).get("ROTATE_REFRESH_TOKENS", False)):
            if bool(getattr(settings, "SIMPLE_JWT", {}).get("BLACKLIST_AFTER_ROTATION", False)):
                _blacklist_refresh_token_string(refresh_token)
            issued_refresh = RefreshToken.for_user(user)
            if should_enforce_single_session(user):
                issued_refresh[SESSION_VERSION_CLAIM] = get_active_session_version(user)
        response = api_response(success=True, message="Token refreshed.", data=None)
        set_auth_cookies(response, str(issued_refresh.access_token), str(issued_refresh))
        return _attach_csrf_token(response, request)


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CurrentUserView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        if not request.user or not request.user.is_authenticated:
            response = api_response(
                success=False,
                message="Not authenticated.",
                data=None,
                errors={"detail": "Authentication credentials were not provided."},
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
            return _attach_csrf_token(response, request)
        response = api_response(
            success=True,
            message="Current user fetched.",
            data=_serialize_user(request.user, request=request),
        )
        return _attach_csrf_token(response, request)


class GoogleLoginView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]

    def post(self, request):
        serializer = GoogleLoginSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Google login failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        try:
            info = verify_google_credential(serializer.validated_data["credential"])
        except GoogleAuthError as exc:
            return api_response(
                success=False,
                message="Google login failed.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        email = User.objects.normalize_auth_email(info.get("email"))
        if not email:
            return api_response(
                success=False,
                message="Google login failed.",
                errors={"detail": "Google account email is unavailable."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        existing_user = User.objects.filter(email__iexact=email).first()
        if existing_user is None and not _registration_enabled():
            return api_response(
                success=False,
                message="Registration is currently disabled.",
                errors={"detail": "Only admin-created accounts can log in right now."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        if existing_user is None:
            user = User.objects.create_user(
                email=email,
                password=None,
                full_name=info.get("name", email.split("@")[0]),
                role=User.ROLE_STUDENT,
                oauth_provider="google",
                oauth_provider_uid=info.get("sub", ""),
            )
            created = True
        else:
            user = existing_user
            created = False
            updated = False
            oauth_provider_needs_update = not user.oauth_provider
            oauth_uid_needs_update = bool(info.get("sub") and user.oauth_provider_uid != info.get("sub"))
            if oauth_provider_needs_update:
                user.oauth_provider = "google"
                updated = True
            if oauth_uid_needs_update:
                user.oauth_provider_uid = info["sub"]
                updated = True
            if updated:
                update_fields = ["updated_at"]
                if oauth_provider_needs_update:
                    update_fields.append("oauth_provider")
                if oauth_uid_needs_update:
                    update_fields.append("oauth_provider_uid")
                user.save(update_fields=list(dict.fromkeys(update_fields)))
        return _auth_success_response(user, "Google login successful.", request=request)


class AuthConfigView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return api_response(
            success=True,
            message="Auth configuration fetched.",
            data={
                "registration_enabled": _registration_enabled(),
                "google_login_enabled": bool(getattr(settings, "GOOGLE_CLIENT_ID", "").strip()),
                "terms_version": TERMS_VERSION,
                "terms_last_updated": TERMS_LAST_UPDATED,
                "web_push_enabled": bool(
                    getattr(settings, "WEB_PUSH_ENABLED", False)
                    and str(getattr(settings, "WEB_PUSH_VAPID_PUBLIC_KEY", "") or "").strip()
                ),
                "web_push_public_key": str(getattr(settings, "WEB_PUSH_VAPID_PUBLIC_KEY", "") or "").strip(),
                **turnstile_public_config(),
            },
        )


class TermsView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]

    def get(self, request):
        return api_response(
            success=True,
            message="Terms and Conditions fetched.",
            data=_serialize_terms(),
        )


class TermsAcceptView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        serializer = TermsAcceptSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Terms acceptance failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        accepted_at = timezone.now()
        ip_address = str(resolve_client_ip(request) or "")[:64]
        user_agent = str(request.META.get("HTTP_USER_AGENT", "") or "")[:255]

        with transaction.atomic():
            user = User.objects.select_for_update().get(pk=request.user.pk)
            acceptance, _created = TermsAcceptance.objects.get_or_create(
                user=user,
                terms_version=TERMS_VERSION,
                defaults={
                    "accepted_at": accepted_at,
                    "ip_address": ip_address,
                    "user_agent": user_agent,
                },
            )
            user.terms_accepted_version = TERMS_VERSION
            user.terms_accepted_at = acceptance.accepted_at
            user.terms_accepted_ip = acceptance.ip_address
            user.terms_accepted_user_agent = acceptance.user_agent
            user.notifications_consent_version = TERMS_VERSION
            user.notifications_consented_at = accepted_at
            user.save(
                update_fields=[
                    "terms_accepted_version",
                    "terms_accepted_at",
                    "terms_accepted_ip",
                    "terms_accepted_user_agent",
                    "notifications_consent_version",
                    "notifications_consented_at",
                    "updated_at",
                ]
            )

        log_security_event(
            "auth.terms_accepted",
            request=request,
            target_user_id=user.id,
            target_email=user.email,
            terms_version=TERMS_VERSION,
        )
        return api_response(
            success=True,
            message="Terms accepted.",
            data=_serialize_user(user, request=request),
        )


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CsrfTokenView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        response = api_response(
            success=True,
            message="CSRF cookie set.",
            data=None,
        )
        return _attach_csrf_token(response, request)


class PasswordResetRequestView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "password_reset_request"

    def post(self, request):
        turnstile_response = enforce_turnstile(request, action="auth")
        if turnstile_response is not None:
            return turnstile_response

        serializer = PasswordResetRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Password reset request failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        email = User.objects.normalize_auth_email(serializer.validated_data["email"])
        user = User.objects.filter(email__iexact=email, is_active=True).first()
        if user:
            uid = urlsafe_base64_encode(force_bytes(user.pk))
            token = default_token_generator.make_token(user)
            reset_url = f"{getattr(settings, 'FRONTEND_URL', '').rstrip('/')}/reset-password?uid={uid}&token={token}"
            from_email = (
                getattr(settings, "DEFAULT_FROM_EMAIL", "")
                or getattr(settings, "EMAIL_HOST_USER", "")
                or "no-reply@localhost"
            )
            email_message = EmailMessage(
                subject="Reset your Al syed Initiative password",
                body=(
                    "We received a password reset request for your account.\n\n"
                    f"Reset link: {reset_url}\n\n"
                    "If you did not request this, you can ignore this email."
                ),
                from_email=from_email,
                to=[user.email],
            )
            if async_jobs_enabled():
                try:
                    enqueue_email_job(
                        subject=email_message.subject,
                        body=email_message.body,
                        from_email=email_message.from_email,
                        to=email_message.to,
                        max_attempts=int(getattr(settings, "ASYNC_EMAIL_MAX_ATTEMPTS", 5)),
                    )
                    log_security_event(
                        "auth.password_reset_request_queued",
                        request=request,
                        target_user_id=user.id,
                    )
                except Exception:
                    try:
                        email_message.send(fail_silently=False)
                        log_security_event("auth.password_reset_request_sent", request=request, target_user_id=user.id)
                    except Exception:
                        log_security_event("auth.password_reset_request_email_failed", request=request, target_user_id=user.id)
            else:
                try:
                    email_message.send(fail_silently=False)
                    log_security_event("auth.password_reset_request_sent", request=request, target_user_id=user.id)
                except Exception:
                    log_security_event("auth.password_reset_request_email_failed", request=request, target_user_id=user.id)
        else:
            log_security_event("auth.password_reset_request_unknown_email", request=request, email=email)
        return api_response(
            success=True,
            message="If an account exists for that email, a password reset link has been sent.",
            data={"email": serializer.validated_data["email"]},
        )


class PasswordResetConfirmView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "password_reset_confirm"

    def post(self, request):
        serializer = PasswordResetConfirmSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Password reset confirm failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        data = serializer.validated_data
        try:
            user_id = force_str(urlsafe_base64_decode(data["uid"]))
            user = User.objects.get(pk=user_id, is_active=True)
        except Exception:
            log_security_event("auth.password_reset_confirm_invalid_uid", request=request)
            return api_response(
                success=False,
                message="Password reset confirm failed.",
                errors={"detail": "Invalid or expired reset link."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if not default_token_generator.check_token(user, data["token"]):
            log_security_event("auth.password_reset_confirm_invalid_token", request=request, target_user_id=user.id)
            return api_response(
                success=False,
                message="Password reset confirm failed.",
                errors={"detail": "Invalid or expired reset link."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        user.set_password(data["new_password"])
        user.save(update_fields=["password"])
        _revoke_all_refresh_tokens_for_user(user)
        log_security_event("auth.password_reset_confirm_success", request=request, target_user_id=user.id)
        return api_response(success=True, message="Password has been reset successfully.", data=None)


class ContactMessageView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "contact"

    def post(self, request):
        turnstile_response = enforce_turnstile(request, action="contact")
        if turnstile_response is not None:
            return turnstile_response

        serializer = ContactMessageSerializer(data=request.data)
        if not serializer.is_valid():
            log_security_event("contact.submit_invalid", request=request, errors=serializer.errors)
            return api_response(
                success=False,
                message="Contact message failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        data = serializer.validated_data
        recipient = getattr(settings, "CONTACT_RECEIVER_EMAIL", "") or getattr(
            settings, "DEFAULT_FROM_EMAIL", ""
        )
        if not recipient:
            return api_response(
                success=False,
                message="Contact email is not configured.",
                errors={"detail": "Set CONTACT_RECEIVER_EMAIL or DEFAULT_FROM_EMAIL."},
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        from_email = (
            getattr(settings, "DEFAULT_FROM_EMAIL", "")
            or getattr(settings, "EMAIL_HOST_USER", "")
            or "no-reply@localhost"
        )
        email = EmailMessage(
            subject=f"[Contact] {data['subject']}",
            body=(
                "New contact form message\n\n"
                f"Name: {data['name']}\n"
                f"Email: {data['email']}\n"
                f"Subject: {data['subject']}\n\n"
                "Message:\n"
                f"{data['message']}\n"
            ),
            from_email=from_email,
            to=[recipient],
            reply_to=[data["email"]],
        )

        if async_jobs_enabled():
            try:
                enqueue_email_job(
                    subject=email.subject,
                    body=email.body,
                    from_email=email.from_email,
                    to=email.to,
                    reply_to=email.reply_to,
                    max_attempts=int(getattr(settings, "ASYNC_EMAIL_MAX_ATTEMPTS", 5)),
                )
            except Exception:
                try:
                    email.send(fail_silently=False)
                except Exception:
                    log_security_event("contact.submit_email_failed", request=request, sender_email=data["email"])
                    return api_response(
                        success=False,
                        message="Unable to send contact message right now.",
                        errors={"detail": "Email delivery failed."},
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    )
        else:
            try:
                email.send(fail_silently=False)
            except Exception:
                log_security_event("contact.submit_email_failed", request=request, sender_email=data["email"])
                return api_response(
                    success=False,
                    message="Unable to send contact message right now.",
                    errors={"detail": "Email delivery failed."},
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                )

        log_security_event("contact.submit_success", request=request, sender_email=data["email"])
        return api_response(
            success=True,
            message="Contact message sent successfully.",
            data={"email": data["email"]},
            status_code=status.HTTP_200_OK,
        )


class ProfileView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get(self, request):
        return api_response(
            success=True,
            message="Profile fetched.",
            data=_serialize_user(request.user, request=request),
        )

    def patch(self, request):
        serializer = ProfileUpdateSerializer(request.user, data=request.data, partial=True)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Profile update failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        serializer.save()
        log_security_event("auth.profile_updated", request=request)
        return api_response(
            success=True,
            message="Profile updated.",
            data=_serialize_user(request.user, request=request),
        )


class ChangePasswordView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        if not _self_service_credentials_enabled():
            log_security_event("auth.password_change_disabled", request=request)
            return api_response(
                success=False,
                message="Password change is currently disabled.",
                errors={"detail": "Password management is handled by admin."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        serializer = ChangePasswordSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Password change failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        data = serializer.validated_data
        if not request.user.check_password(data["current_password"]):
            log_security_event("auth.password_change_failed_bad_current_password", request=request)
            return api_response(
                success=False,
                message="Password change failed.",
                errors={"current_password": ["Current password is incorrect."]},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        request.user.set_password(data["new_password"])
        request.user.save(update_fields=["password"])
        _revoke_all_refresh_tokens_for_user(request.user)
        log_security_event("auth.password_change_success", request=request)
        return _auth_success_response(request.user, "Password changed successfully.", request=request)


class TwoFactorSetupView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        if not _self_service_credentials_enabled():
            log_security_event("auth.2fa_setup_disabled", request=request)
            return api_response(
                success=False,
                message="Two-factor setup is currently disabled.",
                errors={"detail": "Two-factor management is handled by admin."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        secret = pyotp.random_base32()
        request.user.two_factor_secret = secret
        request.user.two_factor_enabled = False
        request.user.save(update_fields=["two_factor_secret", "two_factor_enabled", "updated_at"])

        issuer = "Al syed Initiative"
        otp_uri = pyotp.totp.TOTP(secret).provisioning_uri(
            name=request.user.email,
            issuer_name=issuer,
        )
        log_security_event("auth.2fa_setup_generated", request=request)
        return api_response(
            success=True,
            message="2FA setup secret generated.",
            data={
                "secret": secret,
                "otp_uri": otp_uri,
                "issuer": issuer,
                "email": request.user.email,
            },
        )


class TwoFactorEnableView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        if not _self_service_credentials_enabled():
            log_security_event("auth.2fa_enable_disabled", request=request)
            return api_response(
                success=False,
                message="Two-factor enable is currently disabled.",
                errors={"detail": "Two-factor management is handled by admin."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        serializer = TwoFactorCodeSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="2FA enable failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if not request.user.two_factor_secret:
            return api_response(
                success=False,
                message="2FA setup missing.",
                errors={"detail": "Generate a 2FA secret first."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        code = serializer.validated_data["code"]
        if not pyotp.TOTP(request.user.two_factor_secret).verify(code, valid_window=1):
            log_security_event("auth.2fa_enable_failed_invalid_code", request=request)
            return api_response(
                success=False,
                message="2FA enable failed.",
                errors={"code": ["Invalid authenticator code."]},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        request.user.two_factor_enabled = True
        request.user.save(update_fields=["two_factor_enabled", "updated_at"])
        log_security_event("auth.2fa_enable_success", request=request)
        return api_response(
            success=True,
            message="Two-factor authentication enabled.",
            data=_serialize_user(request.user, request=request),
        )


class TwoFactorDisableView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        if not _self_service_credentials_enabled():
            log_security_event("auth.2fa_disable_disabled", request=request)
            return api_response(
                success=False,
                message="Two-factor disable is currently disabled.",
                errors={"detail": "Two-factor management is handled by admin."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        serializer = TwoFactorDisableSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="2FA disable failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if not request.user.check_password(serializer.validated_data["password"]):
            log_security_event("auth.2fa_disable_failed_bad_password", request=request)
            return api_response(
                success=False,
                message="2FA disable failed.",
                errors={"password": ["Password is incorrect."]},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        request.user.two_factor_enabled = False
        request.user.two_factor_secret = ""
        request.user.save(update_fields=["two_factor_enabled", "two_factor_secret", "updated_at"])
        log_security_event("auth.2fa_disable_success", request=request)
        return api_response(
            success=True,
            message="Two-factor authentication disabled.",
            data=_serialize_user(request.user, request=request),
        )

