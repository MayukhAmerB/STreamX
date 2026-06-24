from django.urls import path

from .views import (
    CampaignAdminCampaignDetailView,
    CampaignAdminCampaignListCreateView,
    CampaignAdminLoginView,
    CampaignAdminLogoutView,
    CampaignAdminSessionView,
    CampaignAdminVolunteerDetailView,
    CampaignAdminVolunteerListView,
    CampaignListView,
    CampaignVolunteerCreateView,
)

urlpatterns = [
    path("", CampaignListView.as_view(), name="campaign-list"),
    path("volunteers/", CampaignVolunteerCreateView.as_view(), name="campaign-volunteer-create"),
    path("admin/login/", CampaignAdminLoginView.as_view(), name="campaign-admin-login"),
    path("admin/logout/", CampaignAdminLogoutView.as_view(), name="campaign-admin-logout"),
    path("admin/session/", CampaignAdminSessionView.as_view(), name="campaign-admin-session"),
    path("admin/campaigns/", CampaignAdminCampaignListCreateView.as_view(), name="campaign-admin-campaign-list"),
    path("admin/campaigns/<int:pk>/", CampaignAdminCampaignDetailView.as_view(), name="campaign-admin-campaign-detail"),
    path("admin/volunteers/", CampaignAdminVolunteerListView.as_view(), name="campaign-admin-volunteer-list"),
    path("admin/volunteers/<int:pk>/", CampaignAdminVolunteerDetailView.as_view(), name="campaign-admin-volunteer-detail"),
]

