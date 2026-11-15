import logging

from config.response import api_response
from config.throttling import ClientIpIdentMixin
from drf_spectacular.utils import extend_schema
from rest_framework import permissions
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from .models import YouTubeChannel
from .serializers import YouTubeChannelResponseSerializer
from .youtube import build_public_payload, channel_payload, clean_title

logger = logging.getLogger("apps.site_media")


class SiteYouTubeThrottle(ClientIpIdentMixin, SimpleRateThrottle):
    """Per client IP for everyone (signed in or not): the page polls once a minute."""

    scope = "site_youtube"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class YouTubeChannelView(APIView):
    """Public YouTube section data: channel, live status, featured and latest videos.

    Anonymous (no cookies read), throttled per IP, briefly cacheable. Upstream
    trouble never surfaces as an error: the payload falls back to cached data
    or ``available: false`` and the website hides the section.
    """

    authentication_classes = ()
    permission_classes = (permissions.AllowAny,)
    throttle_classes = (SiteYouTubeThrottle,)

    @extend_schema(
        operation_id="site_youtube_retrieve",
        tags=("Website",),
        auth=[],
        responses={200: YouTubeChannelResponseSerializer},
    )
    def get(self, request):
        config = YouTubeChannel.load()
        try:
            payload = build_public_payload(config)
        except Exception:  # noqa: BLE001 - the website section must fail soft
            logger.exception("youtube section payload failed")
            payload = {
                "enabled": bool(config.section_enabled),
                "available": False,
                "section": {"title": clean_title(config.section_title), "subtitle": clean_title(config.section_subtitle)},
                "channel": channel_payload(config, None),
                "live": {"is_live": False, "video_id": None, "title": ""},
                "featured": None,
                "latest": [],
                "fetched_at": None,
            }
        response = api_response(message="YouTube channel fetched.", data=payload)
        response["Cache-Control"] = "public, max-age=30, stale-while-revalidate=60"
        return response
