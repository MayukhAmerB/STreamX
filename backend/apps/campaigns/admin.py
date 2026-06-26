from django.contrib import admin

from .models import Campaign, CampaignSiteVisit, CampaignVolunteer


@admin.register(Campaign)
class CampaignAdmin(admin.ModelAdmin):
    list_display = ("name", "campaign_number", "is_featured", "is_active", "sort_order", "created_at")
    list_filter = ("is_featured", "is_active", "created_at")
    search_fields = ("name", "campaign_number", "description")
    ordering = ("sort_order", "-created_at")


@admin.register(CampaignVolunteer)
class CampaignVolunteerAdmin(admin.ModelAdmin):
    list_display = ("full_name", "age", "campaign", "whatsapp_number", "city", "state", "gender", "status", "created_at")
    list_filter = ("status", "gender", "state", "campaign", "created_at")
    search_fields = ("full_name", "whatsapp_number", "alternate_number", "city", "state", "campaign__name")
    readonly_fields = ("source_ip", "user_agent", "created_at", "updated_at")
    ordering = ("-created_at",)


@admin.register(CampaignSiteVisit)
class CampaignSiteVisitAdmin(admin.ModelAdmin):
    list_display = ("visitor_hash", "visit_count", "source_ip", "first_seen_at", "last_seen_at")
    search_fields = ("visitor_hash", "source_ip", "user_agent")
    readonly_fields = ("visitor_hash", "visit_count", "source_ip", "user_agent", "first_seen_at", "last_seen_at")
    ordering = ("-last_seen_at",)
