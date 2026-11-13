"""Website YouTube section: URL/id parsing, feed + live parsing, caching,
fail-soft behaviour, the public endpoint and the admin singleton."""

import io
import json
import re
import urllib.error
import urllib.parse
from email.message import Message
from unittest.mock import patch

from apps.site_media import youtube
from apps.site_media.admin import YouTubeChannelAdmin
from apps.site_media.models import YouTubeChannel
from apps.site_media.views import SiteYouTubeThrottle
from django.contrib import admin
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIClient

from tests.factories import make_admin

LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "site-media-tests"}}
CHANNEL = "UCcv6HKwcrR8oDSUcPjeFBfg"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
ENDPOINT = "/api/site/youtube/"


def feed_xml(entries, title="Al Syed "):
    body = "".join(
        f"""<entry><id>yt:video:{vid}</id><yt:videoId>{vid}</yt:videoId>
        <yt:channelId>{CHANNEL}</yt:channelId><title>{name}</title>
        <published>{published}</published></entry>"""
        for vid, name, published in entries
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" '
        'xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">'
        f"<title>{title}</title>{body}</feed>"
    ).encode()


FEED = feed_xml(
    [
        ("dBL5_4EQ47M", "FREE LIVE Advanced OSINT Class | Al Syed", "2026-09-01T10:00:00+00:00"),
        ("hWFA4oNF7gk", "Destroying the Propaganda Machine", "2026-10-11T19:36:58+00:00"),
        ("vZy0LqWsXcQ", "Al Syed Live Stream", "2026-08-01T10:00:00+00:00"),
    ]
)
PADDING = b"<script>var x='" + b"a" * 20000 + b"';</script>"
NOT_LIVE_PAGE = PADDING + f'<link rel="canonical" href="https://www.youtube.com/channel/{CHANNEL}">'.encode() + PADDING
LIVE_PAGE = (
    PADDING
    + b'<link rel="canonical" href="https://www.youtube.com/watch?v=LiVe1234567">'
    + b'<meta name="title" content="Sunday OSINT &amp; recon live">'
    + PADDING
    + b'"liveBroadcastDetails":{"isLiveNow":true,"startTimestamp":"2026-11-12T10:00:00+00:00"}'
    + PADDING
)
LIVE_PAGE_VIDEO_DETAILS = (
    b'<link rel="canonical" href="https://www.youtube.com/watch?v=LiVe1234567">'
    + PADDING
    + b'"videoDetails":{"videoId":"LiVe1234567","title":"radio","lengthSeconds":"0","isLive":true,"keywords":[]}'
    + PADDING
)
UPCOMING_PAGE = (
    b'<link rel="canonical" href="https://www.youtube.com/watch?v=UpCo1234567">'
    + PADDING
    + b'"videoDetails":{"videoId":"UpCo1234567","title":"soon","isLive":true,"isUpcoming":true}'
    + PADDING
)


class FakeRaw:
    def __init__(self, body, status=200):
        self._body = io.BytesIO(body)
        self.status = status
        self.headers = Message()
        self.bytes_read = 0

    def read(self, size=-1):
        chunk = self._body.read(size)
        self.bytes_read += len(chunk)
        return chunk

    def getcode(self):
        return self.status

    def close(self):
        pass


class FakeYouTube:
    """Routes urlopen() by path; records calls."""

    def __init__(self, feed=FEED, live=NOT_LIVE_PAGE, oembed=None, fail=None):
        self.feed = feed
        self.live = live
        self.oembed = oembed or {"title": "Pinned &amp; talk"}
        self.fail = fail  # None | "feed" | "live" | "all"
        self.calls = []
        self.raws = []

    def __call__(self, request, timeout=None):
        url = urllib.parse.urlsplit(request.full_url)
        self.calls.append(url.path)
        kind = "feed" if url.path.startswith("/feeds/") else "live" if url.path.endswith("/live") else "oembed"
        if self.fail in ("all", kind):
            raise urllib.error.URLError("connection refused")
        if kind == "feed":
            body = self.feed
        elif kind == "live":
            body = self.live
        else:
            body = json.dumps(self.oembed).encode()
        raw = FakeRaw(body)
        self.raws.append(raw)
        return raw


def walk_video_ids(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "video_id" and item is not None:
                yield item
            else:
                yield from walk_video_ids(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_video_ids(item)


class VideoIdParsingTests(SimpleTestCase):
    def test_accepts_every_common_form(self):
        cases = {
            "dBL5_4EQ47M": "dBL5_4EQ47M",
            "https://www.youtube.com/watch?v=dBL5_4EQ47M": "dBL5_4EQ47M",
            "https://www.youtube.com/watch?v=dBL5_4EQ47M&t=42s&list=PL1": "dBL5_4EQ47M",
            "http://youtube.com/watch?feature=share&v=dBL5_4EQ47M": "dBL5_4EQ47M",
            "https://m.youtube.com/watch?v=dBL5_4EQ47M": "dBL5_4EQ47M",
            "https://music.youtube.com/watch?v=dBL5_4EQ47M": "dBL5_4EQ47M",
            "youtube.com/watch?v=dBL5_4EQ47M": "dBL5_4EQ47M",
            "https://youtu.be/dBL5_4EQ47M": "dBL5_4EQ47M",
            "https://youtu.be/dBL5_4EQ47M?si=abc&t=3": "dBL5_4EQ47M",
            "https://www.youtube.com/live/dBL5_4EQ47M?feature=shared": "dBL5_4EQ47M",
            "https://www.youtube.com/shorts/dBL5_4EQ47M": "dBL5_4EQ47M",
            "https://www.youtube.com/embed/dBL5_4EQ47M?start=10": "dBL5_4EQ47M",
            "https://www.youtube-nocookie.com/embed/dBL5_4EQ47M": "dBL5_4EQ47M",
            "https://www.youtube.com/v/dBL5_4EQ47M": "dBL5_4EQ47M",
            "  https://WWW.YOUTUBE.COM/watch?v=dBL5_4EQ47M  ": "dBL5_4EQ47M",
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(youtube.parse_video_id(value), expected)

    def test_rejects_unsafe_or_unknown_forms(self):
        for value in (
            "",
            None,
            "dBL5_4EQ47",  # 10 chars
            "dBL5_4EQ47MX",  # 12 chars
            "dBL5_4EQ4<M",
            "https://evil.example/watch?v=dBL5_4EQ47M",
            "https://youtube.com.evil.example/watch?v=dBL5_4EQ47M",
            "https://user@www.youtube.com/watch?v=dBL5_4EQ47M",
            "https://www.youtube.com:8443/watch?v=dBL5_4EQ47M",
            "javascript:alert(1)//youtu.be/dBL5_4EQ47M",
            "ftp://youtu.be/dBL5_4EQ47M",
            "https://www.youtube.com/watch?v=dBL5_4EQ47M&v=hWFA4oNF7gk",
            "https://www.youtube.com/watch?v=%22%3E%3Cscript%3E",
            "https://www.youtube.com/@thesy3d",
            f"https://www.youtube.com/channel/{CHANNEL}",
            "https://www.youtube.com/playlist?list=PLxyz",
            "https://www.youtube-nocookie.com/live/dBL5_4EQ47M",
            "https://youtu.be/",
            "https://www.youtube.com/watch?v=" + "a" * 3000,
        ):
            with self.subTest(value=value):
                self.assertIsNone(youtube.parse_video_id(value))

    def test_title_cleaning_is_plain_single_line_and_capped(self):
        self.assertEqual(youtube.clean_title("  A &amp; B\n\tC‮ "), "A & B C")
        self.assertEqual(len(youtube.clean_title("x" * 500)), youtube.MAX_TITLE_LENGTH)

    def test_thumbnail_is_ytimg_hqdefault(self):
        self.assertEqual(youtube.thumbnail_url("dBL5_4EQ47M"), "https://i.ytimg.com/vi/dBL5_4EQ47M/hqdefault.jpg")


class FeedParsingTests(SimpleTestCase):
    def test_parses_sorts_newest_first_and_cleans(self):
        feed = youtube.parse_feed(FEED)
        self.assertEqual(feed["title"], "Al Syed")
        self.assertEqual([v["video_id"] for v in feed["videos"]], ["hWFA4oNF7gk", "dBL5_4EQ47M", "vZy0LqWsXcQ"])
        self.assertEqual(feed["videos"][0]["published_at"], "2026-10-11T19:36:58Z")
        self.assertEqual(feed["videos"][0]["thumbnail"], "https://i.ytimg.com/vi/hWFA4oNF7gk/hqdefault.jpg")

    def test_invalid_and_duplicate_ids_are_dropped(self):
        feed = youtube.parse_feed(
            feed_xml(
                [
                    ("&quot;&gt;&lt;img src=x&gt;", "bad", "2026-01-01T00:00:00+00:00"),
                    ("tooShort", "bad", "2026-01-01T00:00:00+00:00"),
                    ("hWFA4oNF7gk", "&lt;b&gt;bold&lt;/b&gt;", "not a date"),
                    ("hWFA4oNF7gk", "dup", "2026-01-01T00:00:00+00:00"),
                ]
            )
        )
        self.assertEqual([v["video_id"] for v in feed["videos"]], ["hWFA4oNF7gk"])
        # Titles stay plain text; React renders them as text, never as HTML.
        self.assertEqual(feed["videos"][0]["title"], "<b>bold</b>")
        self.assertIsNone(feed["videos"][0]["published_at"])

    def test_malformed_xml_is_rejected(self):
        with self.assertRaises(youtube.FeedError):
            youtube.parse_feed(b"<feed><entry>")
        with self.assertRaises(youtube.FeedError):
            youtube.parse_feed(b"<rss></rss>")

    def test_dtd_and_entities_are_refused_before_parsing(self):
        bomb = (
            b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>'
            b'<feed xmlns="http://www.w3.org/2005/Atom"><title>&lol2;</title></feed>'
        )
        external = b'<?xml version="1.0"?><!DOCTYPE x SYSTEM "http://evil.example/x.dtd"><feed/>'
        for body in (bomb, external):
            with self.assertRaises(youtube.FeedError):
                youtube.parse_feed(body)

    def test_oversized_feed_is_rejected(self):
        with self.assertRaises(youtube.FeedError):
            youtube.parse_feed(b" " * (youtube.FEED_MAX_BYTES + 1))


class LivePageParsingTests(SimpleTestCase):
    def test_not_live_when_canonical_is_the_channel(self):
        self.assertFalse(youtube.parse_live_page(NOT_LIVE_PAGE, CHANNEL).is_live)

    def test_live_via_is_live_now(self):
        status = youtube.parse_live_page(LIVE_PAGE, CHANNEL)
        self.assertEqual(status.as_dict(), {"is_live": True, "video_id": "LiVe1234567", "title": "Sunday OSINT & recon live"})

    def test_live_via_video_details(self):
        self.assertTrue(youtube.parse_live_page(LIVE_PAGE_VIDEO_DETAILS, CHANNEL).is_live)

    def test_upcoming_premiere_is_not_live(self):
        self.assertFalse(youtube.parse_live_page(UPCOMING_PAGE, CHANNEL).is_live)

    def test_explicit_is_live_now_false_wins(self):
        page = LIVE_PAGE.replace(b'"isLiveNow":true', b'"isLiveNow":false')
        self.assertFalse(youtube.parse_live_page(page, CHANNEL).is_live)

    def test_invalid_id_in_canonical_is_never_live(self):
        for canonical in (b"watch?v=bad", b"watch?v=%22%3E%3Cx%3E1234", b"watch?v=AAAAAAAAAAAA"):
            page = LIVE_PAGE.replace(b"watch?v=LiVe1234567", canonical)
            with self.subTest(canonical=canonical):
                self.assertEqual(youtube.parse_live_page(page, CHANNEL).as_dict()["video_id"], None)

    def test_no_canonical_is_not_live(self):
        self.assertFalse(youtube.parse_live_page(b'"isLiveNow":true', CHANNEL).is_live)

    def test_reader_stops_early_once_decided(self):
        raw = FakeRaw(NOT_LIVE_PAGE + b"x" * 500_000)
        body = youtube._LimitedBody(raw, youtube.LIVE_PAGE_MAX_BYTES, youtube.live_page_is_decided).read()
        self.assertLess(raw.bytes_read, 200_000)
        self.assertFalse(youtube.parse_live_page(body, CHANNEL).is_live)

    def test_reader_never_reads_past_the_cap(self):
        raw = FakeRaw(b"x" * 1_000_000)
        body = youtube._LimitedBody(raw, 100_000).read()
        self.assertEqual(len(body), 100_001)
        self.assertLessEqual(raw.bytes_read, 100_001)


@override_settings(CACHES=LOCMEM)
class YouTubeEndpointTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        sleep_patch = patch("apps.site_media.youtube.time.sleep")
        sleep_patch.start()
        self.addCleanup(sleep_patch.stop)

    def get(self, fake):
        with patch("apps.site_media.youtube.urllib.request.urlopen", fake):
            response = self.client.get(ENDPOINT)
        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        for video_id in walk_video_ids(data):
            self.assertRegex(video_id, ID_RE)
        return response, data

    def test_not_live_features_latest_upload(self):
        fake = FakeYouTube()
        response, data = self.get(fake)
        self.assertEqual(response["Cache-Control"], "public, max-age=30, stale-while-revalidate=60")
        self.assertTrue(data["enabled"])
        self.assertTrue(data["available"])
        self.assertEqual(data["live"], {"is_live": False, "video_id": None, "title": ""})
        self.assertEqual(data["featured"]["video_id"], "hWFA4oNF7gk")
        self.assertEqual(len(data["latest"]), 3)
        self.assertEqual(
            data["channel"],
            {
                "title": "Al Syed",
                "handle": "@thesy3d",
                "url": "https://www.youtube.com/@thesy3d",
                "subscribe_url": "https://www.youtube.com/@thesy3d?sub_confirmation=1",
            },
        )
        self.assertEqual(data["section"]["title"], "Watch Al Syed")
        self.assertTrue(data["fetched_at"].endswith("Z"))

    def test_live_status_is_reported(self):
        _, data = self.get(FakeYouTube(live=LIVE_PAGE))
        self.assertEqual(data["live"], {"is_live": True, "video_id": "LiVe1234567", "title": "Sunday OSINT & recon live"})

    def test_prefer_live_off_skips_the_live_check(self):
        YouTubeChannel.objects.create(prefer_live=False)
        fake = FakeYouTube(live=LIVE_PAGE)
        _, data = self.get(fake)
        self.assertFalse(data["live"]["is_live"])
        self.assertFalse(any(path.endswith("/live") for path in fake.calls))

    def test_results_are_cached(self):
        fake = FakeYouTube()
        self.get(fake)
        self.get(fake)
        self.assertEqual(len(fake.calls), 2)  # one feed + one live check

    def test_pinned_video_in_feed_uses_feed_metadata(self):
        YouTubeChannel.objects.create(featured_video_url="https://youtu.be/vZy0LqWsXcQ?si=x")
        _, data = self.get(FakeYouTube())
        self.assertEqual(data["featured"]["video_id"], "vZy0LqWsXcQ")
        self.assertEqual(data["featured"]["title"], "Al Syed Live Stream")

    def test_pinned_video_outside_feed_uses_oembed_title(self):
        YouTubeChannel.objects.create(featured_video_url="https://www.youtube.com/live/AbCdEfGhIjK")
        _, data = self.get(FakeYouTube())
        self.assertEqual(data["featured"]["video_id"], "AbCdEfGhIjK")
        self.assertEqual(data["featured"]["title"], "Pinned & talk")
        self.assertEqual(data["featured"]["thumbnail"], "https://i.ytimg.com/vi/AbCdEfGhIjK/hqdefault.jpg")

    def test_invalid_stored_pin_falls_back_to_latest(self):
        YouTubeChannel.objects.create()
        YouTubeChannel.objects.filter(pk=1).update(featured_video_url='"><script>alert(1)</script>')
        _, data = self.get(FakeYouTube())
        self.assertEqual(data["featured"]["video_id"], "hWFA4oNF7gk")

    def test_latest_count_is_respected(self):
        YouTubeChannel.objects.create(latest_count=2)
        _, data = self.get(FakeYouTube())
        self.assertEqual(len(data["latest"]), 2)

    def test_disabled_section_makes_no_upstream_calls(self):
        YouTubeChannel.objects.create(section_enabled=False)
        fake = FakeYouTube()
        _, data = self.get(fake)
        self.assertFalse(data["enabled"])
        self.assertFalse(data["available"])
        self.assertEqual(fake.calls, [])

    def test_malformed_feed_is_unavailable_not_an_error(self):
        _, data = self.get(FakeYouTube(feed=b"<feed><entry"))
        self.assertTrue(data["enabled"])
        self.assertFalse(data["available"])
        self.assertIsNone(data["featured"])
        self.assertEqual(data["latest"], [])

    def test_oversized_feed_is_cut_off_and_unavailable(self):
        fake = FakeYouTube(feed=FEED + b" " * (2 * youtube.FEED_MAX_BYTES))
        _, data = self.get(fake)
        self.assertFalse(data["available"])
        feed_raw = fake.raws[0]
        self.assertLessEqual(feed_raw.bytes_read, youtube.FEED_MAX_BYTES + 1)

    def test_oversized_live_page_is_not_live(self):
        page = b"x" * (youtube.LIVE_PAGE_MAX_BYTES + 10) + LIVE_PAGE
        _, data = self.get(FakeYouTube(live=page))
        self.assertFalse(data["live"]["is_live"])
        self.assertTrue(data["available"])

    def test_live_with_unvalidated_id_never_leaves_the_server(self):
        page = LIVE_PAGE.replace(b"watch?v=LiVe1234567", b"watch?v=LiVe12345&quot;")
        _, data = self.get(FakeYouTube(live=page))
        self.assertFalse(data["live"]["is_live"])
        self.assertIsNone(data["live"]["video_id"])

    def test_upstream_down_with_no_history_is_unavailable(self):
        _, data = self.get(FakeYouTube(fail="all"))
        self.assertTrue(data["enabled"])
        self.assertFalse(data["available"])
        self.assertFalse(data["live"]["is_live"])

    def test_upstream_down_serves_last_good_data_and_breaker_stops_calls(self):
        good = FakeYouTube()
        self.get(good)
        # Fresh and stale windows are gone (only the long-lived last-good copy remains).
        cache.delete(f"core:sf:site_media:yt:feed:{CHANNEL}")
        cache.delete(f"core:sf:site_media:yt:live:{CHANNEL}")
        down = FakeYouTube(fail="all")
        _, data = self.get(down)
        self.assertTrue(data["available"])
        self.assertEqual(data["featured"]["video_id"], "hWFA4oNF7gk")
        self.assertEqual(len(data["latest"]), 3)
        # Keep failing until the shared "youtube" breaker opens: then no more calls go out.
        for _ in range(4):
            cache.delete(f"core:sf:site_media:yt:feed:{CHANNEL}")
            cache.delete(f"site_media:yt:feed-down:{CHANNEL}")
            cache.delete(f"core:sf:site_media:yt:live:{CHANNEL}")
            self.get(down)
        calls_when_open = len(down.calls)
        cache.delete(f"core:sf:site_media:yt:feed:{CHANNEL}")
        cache.delete(f"site_media:yt:feed-down:{CHANNEL}")
        cache.delete(f"core:sf:site_media:yt:live:{CHANNEL}")
        _, data = self.get(down)
        self.assertEqual(len(down.calls), calls_when_open)
        self.assertEqual(data["featured"]["video_id"], "hWFA4oNF7gk")

    def test_stale_feed_is_served_while_upstream_fails(self):
        self.get(FakeYouTube())
        entry = cache.get(f"core:sf:site_media:yt:feed:{CHANNEL}")
        entry["fresh_until"] = 0  # past its 15 minutes: stale, not expired
        cache.set(f"core:sf:site_media:yt:feed:{CHANNEL}", entry, timeout=600)
        cache.delete(f"site_media:yt:feed-last-good:{CHANNEL}")
        _, data = self.get(FakeYouTube(fail="feed"))
        self.assertEqual(data["featured"]["video_id"], "hWFA4oNF7gk")

    def test_unexpected_error_still_answers_200(self):
        with patch("apps.site_media.views.build_public_payload", side_effect=RuntimeError("boom")):
            response = self.client.get(ENDPOINT)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["data"]["available"])

    def test_anonymous_endpoint_ignores_bad_auth_cookies(self):
        self.client.cookies["access_token"] = "garbage"
        self.client.cookies["streamx_access"] = "garbage"
        _, data = self.get(FakeYouTube())
        self.assertTrue(data["available"])

    def test_throttled_per_client(self):
        fake = FakeYouTube()
        with patch.object(SiteYouTubeThrottle, "rate", "2/min", create=True), patch(
            "apps.site_media.youtube.urllib.request.urlopen", fake
        ):
            codes = [self.client.get(ENDPOINT).status_code for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])

    def test_only_get_is_allowed(self):
        self.assertEqual(self.client.post(ENDPOINT, {}).status_code, 405)


class YouTubeChannelModelTests(TestCase):
    def test_load_returns_defaults_without_writing(self):
        config = YouTubeChannel.load()
        self.assertEqual(config.channel_id, CHANNEL)
        self.assertEqual(config.handle, "@thesy3d")
        self.assertEqual(config.latest_count, 6)
        self.assertTrue(config.prefer_live)
        self.assertFalse(YouTubeChannel.objects.exists())

    def test_singleton_always_saves_as_pk_1(self):
        YouTubeChannel(channel_title="One").save()
        YouTubeChannel(channel_title="Two").save()
        self.assertEqual(list(YouTubeChannel.objects.values_list("pk", "channel_title")), [(1, "Two")])

    def test_cannot_be_deleted(self):
        config = YouTubeChannel.objects.create()
        with self.assertRaises(ValidationError):
            config.delete()

    def test_valid_settings_pass_validation(self):
        config = YouTubeChannel(featured_video_url="https://www.youtube.com/watch?v=dBL5_4EQ47M&t=1")
        config.full_clean()
        self.assertEqual(config.featured_video_id, "dBL5_4EQ47M")

    def test_invalid_settings_are_rejected(self):
        cases = {
            "featured_video_url": "https://vimeo.com/123456",
            "channel_id": "UC-short",
            "handle": "thesy3d",
            "channel_url": "https://evil.example/@thesy3d",
            "latest_count": 16,
        }
        for field, value in cases.items():
            with self.subTest(field=field):
                config = YouTubeChannel(**{field: value})
                with self.assertRaises(ValidationError) as caught:
                    config.full_clean()
                self.assertIn(field, caught.exception.message_dict)
        for url in ("http://www.youtube.com/@thesy3d", "https://www.youtube.com/", "javascript:alert(1)"):
            with self.subTest(channel_url=url):
                with self.assertRaises(ValidationError):
                    YouTubeChannel(channel_url=url).full_clean()
        with self.assertRaises(ValidationError):
            YouTubeChannel(latest_count=0).full_clean()


class YouTubeChannelAdminTests(TestCase):
    def setUp(self):
        self.admin_user = make_admin()
        self.client.force_login(self.admin_user)
        self.model_admin = admin.site._registry[YouTubeChannel]

    def test_registered_with_singleton_permissions(self):
        self.assertIsInstance(self.model_admin, YouTubeChannelAdmin)
        request = type("R", (), {"user": self.admin_user})()
        self.assertTrue(self.model_admin.has_add_permission(request))
        YouTubeChannel.objects.create()
        self.assertFalse(self.model_admin.has_add_permission(request))
        self.assertFalse(self.model_admin.has_delete_permission(request))

    def test_changelist_opens_the_single_form(self):
        response = self.client.get("/admin/site_media/youtubechannel/")
        self.assertRedirects(response, "/admin/site_media/youtubechannel/add/", fetch_redirect_response=False)
        YouTubeChannel.objects.create()
        response = self.client.get("/admin/site_media/youtubechannel/")
        self.assertRedirects(response, "/admin/site_media/youtubechannel/1/change/", fetch_redirect_response=False)

    def test_admin_form_rejects_a_non_youtube_featured_url(self):
        YouTubeChannel.objects.create()
        form_data = {
            "channel_title": "Al Syed",
            "channel_id": CHANNEL,
            "handle": "@thesy3d",
            "channel_url": "https://www.youtube.com/@thesy3d",
            "section_enabled": "on",
            "section_title": "Watch Al Syed",
            "section_subtitle": "",
            "latest_count": "6",
            "prefer_live": "on",
        }
        bad = self.client.post(
            "/admin/site_media/youtubechannel/1/change/", {**form_data, "featured_video_url": "https://evil.example/v"}
        )
        self.assertEqual(bad.status_code, 200)
        self.assertContains(bad, "Paste a YouTube video link")
        good = self.client.post(
            "/admin/site_media/youtubechannel/1/change/",
            {**form_data, "featured_video_url": "https://www.youtube.com/shorts/dBL5_4EQ47M"},
        )
        self.assertEqual(good.status_code, 302)
        self.assertEqual(YouTubeChannel.load().featured_video_id, "dBL5_4EQ47M")
