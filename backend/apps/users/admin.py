from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import AuthConfiguration, User

admin.site.enable_nav_sidebar = False


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    model = User
    list_display = ("email", "full_name", "role", "two_factor_enabled", "is_staff", "is_active")
    list_filter = ("role", "two_factor_enabled", "is_staff", "is_active")
    ordering = ("-created_at",)
    search_fields = ("email", "full_name")
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Personal info", {"fields": ("full_name", "profile_image", "role")}),
        ("Security", {"fields": ("two_factor_enabled", "two_factor_secret")}),
        ("OAuth", {"fields": ("oauth_provider", "oauth_provider_uid")}),
        ("Permissions", {"fields": ("is_active", "is_staff", "is_superuser", "groups", "user_permissions")}),
        ("Important dates", {"fields": ("last_login",)}),
    )
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
