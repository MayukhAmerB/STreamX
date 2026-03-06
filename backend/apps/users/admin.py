from django.contrib import admin
from django.contrib.admin.sites import NotRegistered
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.models import Group
from django.db.models import Count, Q
from rest_framework.authtoken.models import Token

from apps.courses.models import Enrollment, LiveClassEnrollment

from .models import AuthConfiguration, User

admin.site.enable_nav_sidebar = False

for model in (Group, Token):
    try:
        admin.site.unregister(model)
    except NotRegistered:
        pass


class CourseEnrollmentInline(admin.TabularInline):
    model = Enrollment
    fk_name = "user"
    extra = 0
    fields = ("course", "payment_status", "enrolled_at")
    readonly_fields = ("enrolled_at",)
    ordering = ("-enrolled_at",)
    show_change_link = True
    verbose_name = "Course Buy Request"
    verbose_name_plural = "Course Acceptance (Buy Requests)"


class LiveClassEnrollmentInline(admin.TabularInline):
    model = LiveClassEnrollment
    fk_name = "user"
    extra = 0
    fields = ("live_class", "status", "created_at")
    readonly_fields = ("created_at",)
    ordering = ("-created_at",)
    show_change_link = True
    verbose_name = "Live Class Enroll Request"
    verbose_name_plural = "Live Class Acceptance (Enroll Requests)"


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    model = User
    list_display = (
        "email",
        "full_name",
        "role",
        "pending_course_requests",
        "pending_live_class_requests",
        "is_staff",
        "is_active",
    )
    list_filter = ("role", "two_factor_enabled", "is_staff", "is_active")
    ordering = ("-created_at",)
    search_fields = ("email", "full_name")
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
        ("Personal info", {"fields": ("full_name", "profile_image", "role")}),
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
                "fields": ("email", "full_name", "role", "password1", "password2"),
            },
        ),
    )

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
