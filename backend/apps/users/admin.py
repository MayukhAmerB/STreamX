from django import forms
from django.contrib import admin
from django.contrib.admin.sites import NotRegistered
from django.contrib.admin.utils import unquote
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import Group
from django.core.exceptions import PermissionDenied
from django.db.models import Count, Q
from django.http import Http404
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils.html import format_html
from rest_framework.authtoken.models import Token

from apps.courses.models import Enrollment, LiveClassEnrollment
from config.audit import log_security_event

from .models import AsyncJob, AuthConfiguration, User

admin.site.enable_nav_sidebar = False

for model in (Group, Token):
    try:
        admin.site.unregister(model)
    except NotRegistered:
        pass


def highlighted_identity(value, color="#e8f1df", border="#3b4a3d", background="#111912"):
    text = str(value or "Not provided").strip() or "Not provided"
    return format_html(
        '<span style="display:inline-block;padding:4px 8px;border-radius:999px;border:1px solid {};background:{};color:{};font-weight:600;">{}</span>',
        border,
        background,
        color,
        text,
    )


class AdminPasswordVerificationForm(forms.Form):
    password = forms.CharField(
        label="Candidate password",
        widget=forms.PasswordInput(
            attrs={
                "autocomplete": "new-password",
                "style": "width:100%;max-width:420px;",
            },
        ),
        help_text="Checks the entered password against the stored hash. The password is never saved.",
    )


class EnrollmentRequesterInlineMixin:
    @admin.display(description="Username")
    def requester_username(self, obj):
        return highlighted_identity(getattr(obj.user, "full_name", None) or getattr(obj.user, "email", None))

    @admin.display(description="Email")
    def requester_email(self, obj):
        return highlighted_identity(getattr(obj.user, "email", None))

    @admin.display(description="Phone")
    def requester_phone(self, obj):
        return highlighted_identity(getattr(obj.user, "phone_number", None), color="#f0f6e8")


class CourseEnrollmentInline(EnrollmentRequesterInlineMixin, admin.TabularInline):
    model = Enrollment
    fk_name = "user"
    extra = 0
    fields = ("requester_username", "requester_email", "requester_phone", "course", "payment_status", "enrolled_at")
    readonly_fields = ("requester_username", "requester_email", "requester_phone", "enrolled_at")
    ordering = ("-enrolled_at",)
    show_change_link = True
    verbose_name = "Course Buy Request"
    verbose_name_plural = "Course Acceptance (Buy Requests)"


class LiveClassEnrollmentInline(EnrollmentRequesterInlineMixin, admin.TabularInline):
    model = LiveClassEnrollment
    fk_name = "user"
    extra = 0
    fields = ("requester_username", "requester_email", "requester_phone", "live_class", "status", "created_at")
    readonly_fields = ("requester_username", "requester_email", "requester_phone", "created_at")
    ordering = ("-created_at",)
    show_change_link = True
    verbose_name = "Live Class Enroll Request"
    verbose_name_plural = "Live Class Acceptance (Enroll Requests)"


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    model = User
    change_form_template = "admin/users/user/change_form.html"
    list_display = (
        "email",
        "full_name",
        "phone_number",
        "role",
        "pending_course_requests",
        "pending_live_class_requests",
        "is_staff",
        "is_active",
    )
    list_filter = ("role", "two_factor_enabled", "is_staff", "is_active")
    ordering = ("-created_at",)
    search_fields = ("email", "full_name", "phone_number")
    inlines = (CourseEnrollmentInline, LiveClassEnrollmentInline)

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(
            _pending_course_requests=Count(
                "enrollments",
                filter=Q(enrollments__payment_status=Enrollment.STATUS_PENDING),
                distinct=True,
            ),
            _pending_live_class_requests=Count(
                "live_class_enrollments",
                filter=Q(live_class_enrollments__status=LiveClassEnrollment.STATUS_PENDING),
                distinct=True,
            ),
        )

    @admin.display(ordering="_pending_course_requests", description="Pending Course Requests")
    def pending_course_requests(self, obj):
        return getattr(obj, "_pending_course_requests", 0)

    @admin.display(ordering="_pending_live_class_requests", description="Pending Live Requests")
    def pending_live_class_requests(self, obj):
        return getattr(obj, "_pending_live_class_requests", 0)

    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Personal info", {"fields": ("full_name", "phone_number", "profile_image", "role")}),
        ("Security", {"fields": ("two_factor_enabled", "two_factor_secret")}),
        ("OAuth", {"fields": ("oauth_provider", "oauth_provider_uid")}),
        ("Permissions", {"fields": ("is_active", "is_staff", "is_superuser")}),
        ("Important dates", {"fields": ("last_login", "created_at", "updated_at")}),
    )
    readonly_fields = ("created_at", "updated_at")
    add_fieldsets = (
        (
            None,
            {
                "classes": ("wide",),
                "fields": ("email", "full_name", "phone_number", "role", "password1", "password2"),
            },
        ),
    )

    def get_urls(self):
        info = self.model._meta.app_label, self.model._meta.model_name
        custom_urls = [
            path(
                "<path:object_id>/verify-password/",
                self.admin_site.admin_view(self.verify_password_view),
                name=f"{info[0]}_{info[1]}_verify_password",
            ),
        ]
        return custom_urls + super().get_urls()

    def _verify_password_url(self, obj):
        info = self.model._meta.app_label, self.model._meta.model_name
        return reverse(f"admin:{info[0]}_{info[1]}_verify_password", args=[obj.pk])

    def _ensure_superuser_verification_access(self, request):
        if not request.user.is_active or not request.user.is_staff:
            raise PermissionDenied
        if not request.user.is_superuser:
            raise PermissionDenied("Only superusers can verify stored passwords.")

    def change_view(self, request, object_id, form_url="", extra_context=None):
        extra_context = extra_context or {}
        if object_id:
            obj = self.get_object(request, unquote(object_id))
            if obj is not None and request.user.is_superuser:
                extra_context["verify_password_url"] = self._verify_password_url(obj)
        return super().change_view(request, object_id, form_url=form_url, extra_context=extra_context)

    def verify_password_view(self, request, object_id):
        self._ensure_superuser_verification_access(request)
        target_user = self.get_object(request, unquote(object_id))
        if target_user is None:
            raise Http404("User does not exist.")

        form = AdminPasswordVerificationForm(request.POST or None)
        verification_result = None
        if request.method == "POST" and form.is_valid():
            candidate_password = form.cleaned_data["password"]
            has_usable_password = target_user.has_usable_password()
            matches = bool(has_usable_password and target_user.check_password(candidate_password))
            verification_result = {
                "has_usable_password": has_usable_password,
                "matches": matches,
            }
            log_security_event(
                "admin.password_verification_attempt",
                request=request,
                target_user_id=target_user.id,
                target_email=target_user.email,
                has_usable_password=has_usable_password,
                matched=matches,
            )
            self.log_change(
                request,
                target_user,
                (
                    "Password verification attempted. "
                    f"has_usable_password={has_usable_password}; matched={matches}"
                ),
            )
            form = AdminPasswordVerificationForm()

        context = {
            **self.admin_site.each_context(request),
            "opts": self.model._meta,
            "original": target_user,
            "target_user": target_user,
            "title": f"Verify password for {target_user.email}",
            "form": form,
            "verification_result": verification_result,
            "verify_password_url": self._verify_password_url(target_user),
        }
        return TemplateResponse(request, "admin/users/user/verify_password.html", context)

    class Media:
        js = ("admin/js/user_password_generator.js",)


@admin.register(AuthConfiguration)
class AuthConfigurationAdmin(admin.ModelAdmin):
    list_display = ("registration_enabled", "updated_at")
    readonly_fields = ("created_at", "updated_at")
    fields = ("registration_enabled", "created_at", "updated_at")

    def has_add_permission(self, request):
        if AuthConfiguration.objects.exists():
            return False
        return super().has_add_permission(request)

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(AsyncJob)
class AsyncJobAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "job_type",
        "status",
        "attempts",
        "max_attempts",
        "run_after",
        "created_at",
        "updated_at",
    )
    list_filter = ("job_type", "status")
    search_fields = ("id", "job_type", "status", "last_error")
    ordering = ("status", "run_after", "-created_at")
    readonly_fields = (
        "job_type",
        "status",
        "attempts",
        "max_attempts",
        "run_after",
        "locked_at",
        "completed_at",
        "payload",
        "result_payload",
        "last_error",
        "created_at",
        "updated_at",
    )
    fields = readonly_fields

    def has_add_permission(self, request):
        return False
