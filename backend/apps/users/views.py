from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import default_token_generator
from django.conf import settings
from django.core.mail import EmailMessage
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
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
from config.cookies import REFRESH_COOKIE, clear_auth_cookies, set_auth_cookies
from config.response import api_response
from config.throttling import LoginRateThrottle

from .serializers import (
    GoogleLoginSerializer,
    LoginSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    RegisterSerializer,
    ContactMessageSerializer,
    ChangePasswordSerializer,
    ProfileUpdateSerializer,
    TwoFactorCodeSerializer,
    TwoFactorDisableSerializer,
    UserSerializer,
)
from .models import AuthConfiguration
from .security import clear_failed_login, get_lockout_state, register_failed_login
from .services import GoogleAuthError, verify_google_credential

User = get_user_model()


def _registration_enabled():
    return bool(AuthConfiguration.get_solo().registration_enabled)


def _issue_tokens_for_user(user):
    refresh = RefreshToken.for_user(user)
    return str(refresh.access_token), str(refresh)


def _serialize_user(user, request=None):
    return UserSerializer(user, context={"request": request} if request else {}).data


def _auth_success_response(user, message, request=None):
    access, refresh = _issue_tokens_for_user(user)
    if request is not None:
        # Ensure a CSRF cookie is issued alongside auth cookies for subsequent unsafe requests.
        get_token(request)
    response = api_response(
        success=True,
        message=message,
        data=_serialize_user(user, request=request),
        status_code=status.HTTP_200_OK,
    )
    set_auth_cookies(response, access, refresh)
    return response


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
        email = str(request.data.get("email", "")).strip().lower()
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
        response = api_response(success=True, message="Logged out successfully.", data=None)
        clear_auth_cookies(response)
        return response


class RefreshTokenView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        refresh_token = request.COOKIES.get(REFRESH_COOKIE)
        if not refresh_token:
            return api_response(
                success=False,
                message="Refresh token missing.",
                errors={"detail": "Refresh token missing."},
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        try:
            refresh = RefreshToken(refresh_token)
            user = User.objects.get(id=refresh["user_id"])
        except (TokenError, User.DoesNotExist, KeyError) as exc:
            return api_response(
                success=False,
                message="Invalid refresh token.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        response = api_response(success=True, message="Token refreshed.", data=None)
        set_auth_cookies(response, str(refresh.access_token), str(refresh))
        return response


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CurrentUserView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        if not request.user or not request.user.is_authenticated:
            return api_response(
                success=False,
                message="Not authenticated.",
                data=None,
                errors={"detail": "Authentication credentials were not provided."},
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        return api_response(
            success=True,
            message="Current user fetched.",
            data=_serialize_user(request.user, request=request),
        )


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
        email = info.get("email")
        if not email:
            return api_response(
                success=False,
                message="Google login failed.",
                errors={"detail": "Google account email is unavailable."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        existing_user = User.objects.filter(email=email).first()
        if existing_user is None and not _registration_enabled():
            return api_response(
                success=False,
                message="Registration is currently disabled.",
                errors={"detail": "Only admin-created accounts can log in right now."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        user, created = User.objects.get_or_create(
            email=email,
            defaults={
                "full_name": info.get("name", email.split("@")[0]),
                "role": serializer.validated_data.get("role", User.ROLE_STUDENT),
                "oauth_provider": "google",
                "oauth_provider_uid": info.get("sub", ""),
            },
        )
        if not created:
            updated = False
            if not user.oauth_provider:
                user.oauth_provider = "google"
                updated = True
            if info.get("sub") and user.oauth_provider_uid != info.get("sub"):
                user.oauth_provider_uid = info["sub"]
                updated = True
            if updated:
                user.save(update_fields=["oauth_provider", "oauth_provider_uid", "updated_at"])
        return _auth_success_response(user, "Google login successful.", request=request)


class AuthConfigView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return api_response(
            success=True,
            message="Auth configuration fetched.",
            data={"registration_enabled": _registration_enabled()},
        )


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CsrfTokenView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return api_response(
            success=True,
            message="CSRF cookie set.",
            data=None,
        )


class PasswordResetRequestView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "password_reset_request"

    def post(self, request):
        serializer = PasswordResetRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Password reset request failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        email = serializer.validated_data["email"].strip().lower()
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
                subject="Reset your AlsyedAcademy password",
                body=(
                    "We received a password reset request for your account.\n\n"
                    f"Reset link: {reset_url}\n\n"
                    "If you did not request this, you can ignore this email."
                ),
                from_email=from_email,
                to=[user.email],
            )
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
        log_security_event("auth.password_reset_confirm_success", request=request, target_user_id=user.id)
        return api_response(success=True, message="Password has been reset successfully.", data=None)


class ContactMessageView(APIView):
    permission_classes = [permissions.AllowAny]
    parser_classes = [JSONParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "contact"

    def post(self, request):
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
        log_security_event("auth.password_change_success", request=request)
        return _auth_success_response(request.user, "Password changed successfully.", request=request)


class TwoFactorSetupView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        secret = pyotp.random_base32()
        request.user.two_factor_secret = secret
        request.user.two_factor_enabled = False
        request.user.save(update_fields=["two_factor_secret", "two_factor_enabled", "updated_at"])

        issuer = "AlsyedAcademy"
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
