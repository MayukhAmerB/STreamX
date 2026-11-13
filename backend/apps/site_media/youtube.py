"""YouTube channel data for the public website, without an API key.

Sources (all public, no credentials):

* the channel's Atom feed ``/feeds/videos.xml?channel_id=...`` (latest uploads),
* the channel's ``/live`` page: when the channel is broadcasting, its canonical
  link becomes ``watch?v=<id>`` and the player marks that video live
  (``"isLiveNow":true`` or ``videoDetails.isLive``). This is unofficial and may change without notice, so
  it is best-effort: any doubt means "not live",
* oEmbed (``/oembed``) for the title of an admin-pinned video not in the feed.

Everything that leaves this module is validated: video ids must match
``^[A-Za-z0-9_-]{11}$`` and titles are plain, length-capped text. Upstream
reads are size-limited, the XML parser refuses DTDs/entities, and every
failure degrades to cached data or an "unavailable" answer, never an error.
"""

from __future__ import annotations

import html
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass
from datetime import UTC, datetime
from io import BytesIO

from apps.core.concurrency import get_or_compute
from apps.core.errors import UpstreamUnavailable
from apps.core.http import HttpClient
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger("apps.site_media.youtube")

UPSTREAM = "youtube"
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
HANDLE_RE = re.compile(r"^@[A-Za-z0-9._-]{3,100}$")

YOUTUBE_HOSTS = frozenset({"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"})
EMBED_HOSTS = frozenset({"youtube-nocookie.com", "www.youtube-nocookie.com"})
SHORT_HOSTS = frozenset({"youtu.be", "www.youtu.be"})
# Path prefixes whose next segment is the video id: /live/<id>, /shorts/<id>, ...
ID_PATH_PREFIXES = frozenset({"live", "shorts", "embed", "v", "e"})

MAX_URL_LENGTH = 2048
MAX_TITLE_LENGTH = 200
FEED_MAX_BYTES = 512 * 1024
LIVE_PAGE_MAX_BYTES = 3 * 1024 * 1024
OEMBED_MAX_BYTES = 64 * 1024
READ_CHUNK_BYTES = 64 * 1024

ATOM = "{http://www.w3.org/2005/Atom}"
YT = "{http://www.youtube.com/xml/schemas/2015}"

CANONICAL_RE = re.compile(rb'<link\s+rel="canonical"\s+href="([^"]{1,300})"', re.IGNORECASE)
IS_LIVE_NOW_RE = re.compile(rb'"isLiveNow"\s*:\s*(true|false)')
META_TITLE_RE = re.compile(rb'<meta\s+name="title"\s+content="([^"]{0,600})"', re.IGNORECASE)
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]")


# --- small pure helpers --------------------------------------------------------


def is_valid_video_id(value) -> bool:
    return isinstance(value, str) and bool(VIDEO_ID_RE.fullmatch(value))


def thumbnail_url(video_id: str) -> str:
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def clean_title(value, *, fallback: str = "") -> str:
    """Plain, single-line text: entities decoded once, control/bidi chars and
    surrounding whitespace removed, capped in length."""
    text = html.unescape(str(value or ""))
    text = CONTROL_CHARS_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > MAX_TITLE_LENGTH:
        text = text[: MAX_TITLE_LENGTH - 1].rstrip() + "…"
    return text or fallback


def parse_video_id(value) -> str | None:
    """Return the 11-character id from any common YouTube video URL, else None.

    Accepts a bare id and the watch / youtu.be / live / shorts / embed / v / e
    forms on youtube.com, m.youtube.com, music.youtube.com, youtu.be and
    youtube-nocookie.com. Anything else (other hosts, credentials, ports,
    channel or playlist pages, malformed ids) is rejected.
    """
    raw = str(value or "").strip()
    if not raw or len(raw) > MAX_URL_LENGTH:
        return None
    if VIDEO_ID_RE.fullmatch(raw):
        return raw
    if "://" not in raw:
        raw = f"https://{raw}"
    try:
        parts = urllib.parse.urlsplit(raw)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme.lower() not in {"http", "https"} or port is not None or "@" in parts.netloc:
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    segments = [segment for segment in parts.path.split("/") if segment]
    candidate = None
    if host in SHORT_HOSTS:
        candidate = segments[0] if segments else None
    elif host in YOUTUBE_HOSTS or host in EMBED_HOSTS:
        if host in YOUTUBE_HOSTS and segments == ["watch"]:
            values = urllib.parse.parse_qs(parts.query).get("v") or []
            candidate = values[0] if len(values) == 1 else None
        elif len(segments) >= 2 and segments[0].lower() in ID_PATH_PREFIXES:
            if host in EMBED_HOSTS and segments[0].lower() != "embed":
                return None
            candidate = segments[1]
    return candidate if is_valid_video_id(candidate) else None


def parse_published(value) -> str | None:
    """ISO-8601 UTC string, or None when the date is missing or malformed."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")


def video_payload(video_id: str, title: str = "", published_at: str | None = None) -> dict | None:
    if not is_valid_video_id(video_id):
        return None
    return {
        "video_id": video_id,
        "title": clean_title(title),
        "published_at": published_at,
        "thumbnail": thumbnail_url(video_id),
    }


# --- parsing upstream documents ------------------------------------------------


class FeedError(ValueError):
    """The feed could not be used (malformed, oversized, unsafe)."""


def parse_feed(content: bytes) -> dict:
    """Parse the channel Atom feed into ``{"title": str, "videos": [...]}``.

    Refuses oversized documents and any DTD / entity declaration before the
    parser sees them (no entity expansion, no external resources).
    """
    if not isinstance(content, (bytes, bytearray)):
        raise FeedError("Feed body must be bytes.")
    if len(content) > FEED_MAX_BYTES:
        raise FeedError("Feed is too large.")
    head = bytes(content[:4096]).lower()
    if b"<!doctype" in head or b"<!entity" in bytes(content).lower():
        raise FeedError("Feed declares a DTD or entities.")
    try:
        root = ElementTree.fromstring(bytes(content))
    except ElementTree.ParseError as exc:
        raise FeedError("Feed is not well-formed XML.") from exc
    if root.tag != f"{ATOM}feed":
        raise FeedError("Not an Atom feed.")
    videos = []
    seen = set()
    for entry in root.findall(f"{ATOM}entry"):
        video_id = (entry.findtext(f"{YT}videoId") or "").strip()
        if not is_valid_video_id(video_id) or video_id in seen:
            continue
        seen.add(video_id)
        payload = video_payload(
            video_id,
            entry.findtext(f"{ATOM}title") or "",
            parse_published(entry.findtext(f"{ATOM}published")),
        )
        if payload:
            videos.append(payload)
    videos.sort(key=lambda item: item["published_at"] or "", reverse=True)
    return {"title": clean_title(root.findtext(f"{ATOM}title") or ""), "videos": videos}


@dataclass(frozen=True)
class LiveStatus:
    is_live: bool = False
    video_id: str | None = None
    title: str = ""

    def as_dict(self) -> dict:
        if self.is_live and is_valid_video_id(self.video_id):
            return {"is_live": True, "video_id": self.video_id, "title": clean_title(self.title)}
        return {"is_live": False, "video_id": None, "title": ""}


VIDEO_DETAILS_WINDOW = 4096


def _video_details_flags(content: bytes, video_id: str, start: int = 0) -> tuple[bool, bool] | None:
    """``(is_live, is_upcoming)`` from the player's ``videoDetails`` for this id,
    or None when that block has not been seen (yet)."""
    marker = b'"videoDetails":{"videoId":"' + video_id.encode("ascii") + b'"'
    index = content.find(marker, start)
    if index < 0 or len(content) < index + min(VIDEO_DETAILS_WINDOW, 512):
        return None
    window = content[index : index + VIDEO_DETAILS_WINDOW]
    return (b'"isLive":true' in window, b'"isUpcoming":true' in window)


def parse_live_page(content: bytes, channel_id: str) -> LiveStatus:
    """Read the channel ``/live`` page. Live only when the canonical link is a
    watch URL with a valid id AND the player marks that video as live now
    (``"isLiveNow":true``, or ``videoDetails.isLive`` without ``isUpcoming``).
    A scheduled premiere also has a watch canonical, but is not live."""
    content = content or b""
    match = CANONICAL_RE.search(content)
    if not match:
        return LiveStatus()
    canonical = html.unescape(match.group(1).decode("utf-8", errors="replace"))
    video_id = parse_video_id(canonical)
    if not video_id or "/watch" not in canonical:
        return LiveStatus()
    live_now = IS_LIVE_NOW_RE.search(content, match.end())
    if live_now is not None:
        is_live = live_now.group(1) == b"true"
    else:
        flags = _video_details_flags(content, video_id)
        is_live = bool(flags and flags[0] and not flags[1])
    if not is_live:
        return LiveStatus()
    title_match = META_TITLE_RE.search(content)
    title = title_match.group(1).decode("utf-8", errors="replace") if title_match else ""
    return LiveStatus(is_live=True, video_id=video_id, title=title)


def live_page_is_decided(buffer: bytes) -> bool:
    """Stop reading the (1-2 MB) live page as soon as the answer is known."""
    match = CANONICAL_RE.search(buffer)
    if not match:
        return False
    canonical = html.unescape(match.group(1).decode("utf-8", errors="replace"))
    video_id = parse_video_id(canonical)
    if not video_id or "/watch" not in canonical:
        return True  # the canonical is the channel itself: not live
    if IS_LIVE_NOW_RE.search(buffer, match.end()) is not None:
        return True
    marker = b'"videoDetails":{"videoId":"' + video_id.encode("ascii") + b'"'
    index = buffer.find(marker)
    return index >= 0 and len(buffer) >= index + VIDEO_DETAILS_WINDOW


# --- size-limited transport ----------------------------------------------------


class _LimitedBody:
    """Wraps an ``urlopen`` response: ``read()`` returns at most ``max_bytes + 1``
    bytes (so the caller can tell "too large"), stopping early once
    ``stop(buffer)`` is true. The connection is never read to the end."""

    def __init__(self, raw, max_bytes: int, stop=None):
        self._raw = raw
        self._max = int(max_bytes)
        self._stop = stop
        self.status = getattr(raw, "status", None)
        self.headers = getattr(raw, "headers", None)

    def getcode(self):
        return self.status if self.status is not None else self._raw.getcode()

    def read(self, *_args) -> bytes:
        buffer = bytearray()
        while len(buffer) <= self._max:
            chunk = self._raw.read(min(READ_CHUNK_BYTES, self._max + 1 - len(buffer)))
            if not chunk:
                break
            buffer.extend(chunk)
            if self._stop is not None and self._stop(bytes(buffer)):
                break
        return bytes(buffer)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        close = getattr(self._raw, "close", None)
        if callable(close):
            close()
        return False


def limited_opener(max_bytes: int, stop=None, urlopen=None):
    """An ``HttpClient`` opener that bounds how much of a body is read."""

    def _open(request, timeout):
        opener = urlopen or urllib.request.urlopen
        try:
            raw = opener(request, timeout=timeout)  # noqa: S310 - HttpClient validated the scheme
        except urllib.error.HTTPError as exc:
            # Bound the error body too, then hand HttpClient an equivalent error.
            try:
                body = exc.read(min(max_bytes, 64 * 1024)) or b""
            except Exception:  # noqa: BLE001
                body = b""
            raise urllib.error.HTTPError(exc.url, exc.code, exc.msg, exc.headers, BytesIO(body)) from None
        return _LimitedBody(raw, max_bytes, stop)

    return _open


BROWSERISH_HEADERS = {
    "Accept-Language": "en-US,en;q=0.8",
    # Skip the EU consent interstitial; we never sign in or store cookies.
    "Cookie": "SOCS=CAI",
    "User-Agent": "Mozilla/5.0 (compatible; AlSyedSite/1.0; +https://alsyedinitiative.com)",
}


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


def _client(max_bytes: int, *, stop=None, accept: str, timeout_setting: str, default_timeout: float) -> HttpClient:
    return HttpClient(
        UPSTREAM,
        base_url="https://www.youtube.com",
        timeout=float(getattr(settings, timeout_setting, default_timeout)),
        max_retries=1,
        backoff_cap=1.0,
        default_headers={**BROWSERISH_HEADERS, "Accept": accept},
        opener=limited_opener(max_bytes, stop),
        sleep=_sleep,
    )


# --- fetches (raise on failure; callers degrade) ------------------------------


def fetch_feed(channel_id: str) -> dict:
    client = _client(
        FEED_MAX_BYTES,
        accept="application/atom+xml, application/xml;q=0.9, */*;q=0.1",
        timeout_setting="YOUTUBE_FEED_TIMEOUT_SECONDS",
        default_timeout=4,
    )
    response = client.get("/feeds/videos.xml", params={"channel_id": channel_id})
    feed = parse_feed(response.content)
    feed["fetched_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    return feed


def fetch_live_status(channel_id: str) -> LiveStatus:
    client = _client(
        LIVE_PAGE_MAX_BYTES,
        stop=live_page_is_decided,
        accept="text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        timeout_setting="YOUTUBE_LIVE_TIMEOUT_SECONDS",
        default_timeout=5,
    )
    response = client.get(f"/channel/{channel_id}/live")
    if len(response.content) > LIVE_PAGE_MAX_BYTES:
        return LiveStatus()
    return parse_live_page(response.content, channel_id)


def fetch_oembed_title(video_id: str) -> str:
    client = _client(
        OEMBED_MAX_BYTES,
        accept="application/json",
        timeout_setting="YOUTUBE_FEED_TIMEOUT_SECONDS",
        default_timeout=4,
    )
    response = client.get("/oembed", params={"url": watch_url(video_id), "format": "json"})
    if len(response.content) > OEMBED_MAX_BYTES:
        return ""
    try:
        payload = json.loads(response.content.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return ""
    return clean_title(payload.get("title") if isinstance(payload, dict) else "")


# --- cached, fail-soft accessors -----------------------------------------------

FEED_FRESH_SECONDS = 15 * 60
FEED_STALE_SECONDS = 60 * 60
LAST_GOOD_SECONDS = 30 * 24 * 60 * 60
FEED_DOWN_SECONDS = 60
LIVE_FRESH_SECONDS = 60
LIVE_STALE_SECONDS = 4 * 60
LIVE_LAST_GOOD_SECONDS = 3 * 60
OEMBED_SECONDS = 6 * 60 * 60

# Errors a degraded upstream may raise through our fetchers.
SOFT_ERRORS = (UpstreamUnavailable, FeedError, OSError, ValueError)


def _key(*parts: str) -> str:
    return "site_media:yt:" + ":".join(parts)


def get_feed(channel_id: str) -> dict | None:
    """Latest uploads: fresh 15 min, then stale-while-revalidate for an hour,
    then the last good copy (30 days). ``None`` only if we never had one."""
    if cache.get(_key("feed-down", channel_id)):
        return cache.get(_key("feed-last-good", channel_id))

    def compute():
        feed = fetch_feed(channel_id)
        cache.set(_key("feed-last-good", channel_id), feed, timeout=LAST_GOOD_SECONDS)
        return feed

    try:
        return get_or_compute(
            _key("feed", channel_id),
            float(getattr(settings, "YOUTUBE_FEED_CACHE_SECONDS", FEED_FRESH_SECONDS)),
            compute,
            stale_ttl=FEED_STALE_SECONDS,
            lock_ttl=15,
            wait_timeout=6,
        )
    except SOFT_ERRORS as exc:
        logger.warning("youtube feed unavailable for %s (%s); serving the last good copy", channel_id, type(exc).__name__)
        cache.set(_key("feed-down", channel_id), True, timeout=FEED_DOWN_SECONDS)
        return cache.get(_key("feed-last-good", channel_id))


def _live_or_last_known(channel_id: str) -> dict:
    """Never raises. A failed probe keeps a recent "live" answer briefly, else "not live"."""
    try:
        status = fetch_live_status(channel_id).as_dict()
    except SOFT_ERRORS as exc:
        logger.info("youtube live check failed for %s (%s)", channel_id, type(exc).__name__)
        last = cache.get(_key("live-last", channel_id))
        if isinstance(last, dict) and time.time() - float(last.get("at", 0)) < LIVE_LAST_GOOD_SECONDS:
            return last["status"]
        return LiveStatus().as_dict()
    cache.set(_key("live-last", channel_id), {"status": status, "at": time.time()}, timeout=LIVE_LAST_GOOD_SECONDS)
    return status


def get_live(channel_id: str) -> dict:
    """Live status: fresh 60 s, stale-while-revalidate after that; never raises."""
    if not getattr(settings, "YOUTUBE_LIVE_CHECK_ENABLED", True):
        return LiveStatus().as_dict()
    try:
        status = get_or_compute(
            _key("live", channel_id),
            float(getattr(settings, "YOUTUBE_LIVE_CACHE_SECONDS", LIVE_FRESH_SECONDS)),
            lambda: _live_or_last_known(channel_id),
            stale_ttl=LIVE_STALE_SECONDS,
            lock_ttl=15,
            wait_timeout=6,
        )
    except Exception:  # noqa: BLE001 - cache layer trouble must not break the page
        logger.warning("youtube live status cache failed for %s", channel_id, exc_info=True)
        return LiveStatus().as_dict()
    if not isinstance(status, dict) or not status.get("is_live") or not is_valid_video_id(status.get("video_id")):
        return LiveStatus().as_dict()
    return {"is_live": True, "video_id": status["video_id"], "title": clean_title(status.get("title"))}


def get_video_title(video_id: str) -> str:
    """oEmbed title for a pinned video (cached 6 h, "" on failure)."""
    if not is_valid_video_id(video_id):
        return ""

    def compute():
        try:
            return fetch_oembed_title(video_id)
        except SOFT_ERRORS as exc:
            logger.info("youtube oembed failed for %s (%s)", video_id, type(exc).__name__)
            return ""

    try:
        return clean_title(get_or_compute(_key("oembed", video_id), OEMBED_SECONDS, compute, lock_ttl=10, wait_timeout=5))
    except Exception:  # noqa: BLE001
        return ""


# --- public payload ------------------------------------------------------------


def channel_payload(config, feed: dict | None) -> dict:
    handle = config.handle or ""
    url = config.channel_url or (
        f"https://www.youtube.com/{handle}" if handle else f"https://www.youtube.com/channel/{config.channel_id}"
    )
    title = clean_title(config.channel_title) or clean_title((feed or {}).get("title")) or "YouTube"
    return {
        "title": title,
        "handle": handle,
        "url": url,
        "subscribe_url": f"{url}{'&' if '?' in url else '?'}sub_confirmation=1",
    }


def build_public_payload(config) -> dict:
    """Everything the website needs, validated. Never raises for upstream trouble."""
    base = {
        "enabled": bool(config.section_enabled),
        "available": False,
        "section": {"title": clean_title(config.section_title), "subtitle": clean_title(config.section_subtitle)},
        "channel": channel_payload(config, None),
        "live": LiveStatus().as_dict(),
        "featured": None,
        "latest": [],
        "fetched_at": None,
    }
    if not config.section_enabled or not CHANNEL_ID_RE.fullmatch(config.channel_id or ""):
        base["enabled"] = False
        return base

    feed = get_feed(config.channel_id)
    videos = [video for video in (feed or {}).get("videos", []) if is_valid_video_id(video.get("video_id"))]
    by_id = {video["video_id"]: video for video in videos}
    live = get_live(config.channel_id) if config.prefer_live else LiveStatus().as_dict()
    if live["is_live"] and not live["title"]:
        live["title"] = by_id.get(live["video_id"], {}).get("title", "")

    featured = None
    pinned_id = parse_video_id(config.featured_video_url)
    if pinned_id:
        featured = by_id.get(pinned_id) or video_payload(pinned_id, get_video_title(pinned_id))
    elif videos:
        featured = videos[0]

    count = max(1, min(int(config.latest_count or 6), 15))
    base.update(
        channel=channel_payload(config, feed),
        live=live,
        featured=dict(featured) if featured else None,
        latest=[dict(video) for video in videos[:count]],
        fetched_at=(feed or {}).get("fetched_at"),
    )
    base["available"] = bool(base["featured"] or base["live"]["is_live"])
    return _assert_safe(base)


def _assert_safe(payload: dict) -> dict:
    """Last line of defence: drop anything whose id is not a valid video id."""
    if payload.get("featured") and not is_valid_video_id(payload["featured"].get("video_id")):
        payload["featured"] = None
    payload["latest"] = [video for video in payload.get("latest", []) if is_valid_video_id(video.get("video_id"))]
    live = payload.get("live") or {}
    if live.get("is_live") and not is_valid_video_id(live.get("video_id")):
        payload["live"] = LiveStatus().as_dict()
    payload["available"] = bool(payload.get("featured") or payload["live"]["is_live"])
    return payload
