from config.response import api_response
from drf_spectacular.utils import extend_schema
from rest_framework import permissions
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from .models import (
    FirFilingGuide,
    LawsSection,
    LawTopic,
    NationalDeskSettings,
    TrackerOverview,
    TrackerUpdate,
)
from .serializers import (
    FirFilingGuideSerializer,
    LawsSectionSerializer,
    NationalDeskResponseSerializer,
    TrackerOverviewSerializer,
)


class NationalDeskThrottle(AnonRateThrottle):
    scope = "national_desk"
    rate = "120/min"


class NationalDeskView(APIView):
    permission_classes = (permissions.AllowAny,)
    throttle_classes = (NationalDeskThrottle,)

    @extend_schema(
        operation_id="national_desk_content",
        tags=("National Desk",),
        responses={200: NationalDeskResponseSerializer},
    )
    def get(self, request):
        settings_row = NationalDeskSettings.load()

        fir = FirFilingGuide.load()

        laws = LawsSection.load()
        laws.public_topics = LawTopic.objects.filter(is_active=True)

        tracker = TrackerOverview.load()
        tracker.public_updates = TrackerUpdate.objects.filter(is_active=True)

        context = {"request": request}
        data = {
            "is_published": settings_row.is_published,
            "instagram": {
                "enabled": settings_row.instagram_enabled,
                "url": settings_row.instagram_url,
            },
            "file_fir": FirFilingGuideSerializer(fir, context=context).data,
            "laws": LawsSectionSerializer(laws, context=context).data,
            "tracker": TrackerOverviewSerializer(tracker, context=context).data,
        }

        response = api_response(message="National Desk content fetched.", data=data)
        response["Cache-Control"] = "public, max-age=60, stale-while-revalidate=120"
        return response
