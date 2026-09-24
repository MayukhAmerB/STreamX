from django.contrib import admin

from .models import SocialAccount, SocialAccountCategory


class SocialAccountInline(admin.TabularInline):
    model = SocialAccount
    extra = 1
    fields = (
        "account_name",
        "handle",
        "url",
        "managed_by",
        "status_label",
        "sort_order",
        "is_active",
    )
    ordering = ("sort_order", "account_name")


@admin.register(SocialAccountCategory)
class SocialAccountCategoryAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "icon_key", "account_count", "sort_order", "is_active", "updated_at")
    list_editable = ("sort_order", "is_active")
    list_filter = ("is_active", "icon_key")
    search_fields = ("name", "slug", "description")
    prepopulated_fields = {"slug": ("name",)}
    readonly_fields = ("created_at", "updated_at")
    ordering = ("sort_order", "name")
    inlines = (SocialAccountInline,)

    @admin.display(description="Accounts")
    def account_count(self, obj):
        return obj.accounts.count()


@admin.register(SocialAccount)
class SocialAccountAdmin(admin.ModelAdmin):
    list_display = (
        "account_name",
        "handle",
        "category",
        "managed_by",
        "status_label",
        "sort_order",
        "is_active",
        "updated_at",
    )
    list_editable = ("sort_order", "is_active")
    list_filter = ("category", "is_active", "status_label")
    search_fields = ("account_name", "handle", "url", "managed_by", "description")
    autocomplete_fields = ("category",)
    readonly_fields = ("created_at", "updated_at")
    ordering = ("category__sort_order", "sort_order", "account_name")
