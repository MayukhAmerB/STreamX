"""Local HLS filter between Owncast and the capture ffmpeg.

ffmpeg's HLS demuxer records whatever the playlist lists. Owncast, when OBS
disconnects, appends an "offline" clip to the live playlist::

    #EXT-X-DISCONTINUITY
    #EXTINF:8.0,
    offline-v2.ts
    #EXT-X-ENDLIST

so a plain ``ffmpeg -i http://owncast:8080/hls/stream.m3u8`` would copy that
clip into the class recording (and, after a reconnect, into the middle of
it). There is no ffmpeg option to skip it, so the recorder points ffmpeg at
this small proxy (stdlib only, bound to 127.0.0.1 on an ephemeral port, one
per recorder process) instead. Per request it:

* master playlist: keeps only the best variant (largest resolution, then
  bandwidth -- the one ffmpeg would pick anyway), so video and audio come
  from the same rendition and no other variant is ever downloaded;
* media playlist: cuts the offline tail (the first ``offline*`` segment, its
  DISCONTINUITY and everything after it) and closes the playlist with
  ``#EXT-X-ENDLIST`` so ffmpeg finishes the live segments and exits at once;
* drops the leading segments this recording has already captured in the
  current OBS connection (with the media sequence moved on accordingly), so a
  capture restarted inside one connection continues where the previous part
  stopped -- no duplicated and no lost seconds -- and ffmpeg can start at
  index 0. A new connection (Owncast's ``lastConnectTime``) starts afresh, so
  a segment name Owncast might reuse is never mistaken for one already
  captured;
* serves an already-ended playlist that this recording never saw live as an
  empty, ended playlist: right after a reconnect Owncast may still serve the
  previous connection's (or class's) offline playlist, which must not be
  recorded again;
* relays segments from Owncast (so it knows which ones were captured) and,
  when a playlist reload fails, repeats the last good one for a short grace
  period (ffmpeg then just waits for new segments).

Only the configured Owncast origin is ever fetched; unknown paths are 404.
"""

import http.server
import logging
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

logger = logging.getLogger("ops.realtime")

# Tags that describe the playlist as a whole; every other tag belongs to the
# segment URI that follows it.
PLAYLIST_TAGS = frozenset(
    {
        "#EXTM3U",
        "#EXT-X-VERSION",
        "#EXT-X-TARGETDURATION",
        "#EXT-X-MEDIA-SEQUENCE",
        "#EXT-X-DISCONTINUITY-SEQUENCE",
        "#EXT-X-PLAYLIST-TYPE",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        "#EXT-X-ALLOW-CACHE",
        "#EXT-X-START",
        "#EXT-X-SERVER-CONTROL",
        "#EXT-X-PART-INF",
    }
)
ENDLIST = "#EXT-X-ENDLIST"
DISCONTINUITY = "#EXT-X-DISCONTINUITY"
STICKY_SEGMENT_TAGS = ("#EXT-X-KEY", "#EXT-X-MAP")
OFFLINE_PREFIX = "offline"
PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl"
TOKEN_PATTERN = re.compile(r"^/c/([A-Za-z0-9_-]{8,64})(/.*)$")
ATTRIBUTE_PATTERN = re.compile(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)')
URI_ATTRIBUTE_PATTERN = re.compile(r'URI="([^"]*)"')


def _tag_name(line):
    return line.split(":", 1)[0]


@dataclass
class Segment:
    tags: list
    uri: str


@dataclass
class MediaPlaylist:
    header: list
    segments: list
    ended: bool


def is_master_playlist(text):
    return "#EXT-X-STREAM-INF" in text


def is_offline_uri(uri):
    name = urlsplit(uri).path.rsplit("/", 1)[-1].lower()
    return name.startswith(OFFLINE_PREFIX)


def parse_media_playlist(text):
    header, segments, pending, ended = [], [], [], False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            name = _tag_name(line)
            if name == ENDLIST:
                ended = True
            elif name in PLAYLIST_TAGS:
                header.append(line)
            else:
                pending.append(line)
            continue
        segments.append(Segment(pending, line))
        pending = []
    # Tags left after the last URI (a DISCONTINUITY announced before its
    # segment exists) are dropped; the next reload repeats them.
    return MediaPlaylist(header, segments, ended)


def _header_int(header, name):
    for line in header:
        if _tag_name(line) == name:
            try:
                return int(line.split(":", 1)[1].strip())
            except (IndexError, ValueError):
                return None
    return None


def _set_header_int(header, name, value):
    for index, line in enumerate(header):
        if _tag_name(line) == name:
            header[index] = f"{name}:{value}"
            return
    position = next((i + 1 for i, line in enumerate(header) if _tag_name(line) == "#EXT-X-TARGETDURATION"), len(header))
    header.insert(position, f"{name}:{value}")


def filter_media_playlist(text, *, resolve=lambda uri: uri, delivered=frozenset(), seen_live=True, rewrite=None):
    """Apply the offline/dedup/stale rules to one media playlist.

    ``resolve`` maps a segment URI to the key ``delivered`` holds; ``rewrite``
    (optional) maps URIs for the client. Returns ``(text, info)``.
    """
    playlist = parse_media_playlist(text)
    segments = list(playlist.segments)
    ended = playlist.ended
    offline_dropped = 0
    for index, segment in enumerate(segments):
        if is_offline_uri(segment.uri):
            offline_dropped = len(segments) - index
            segments = segments[:index]
            ended = True
            break

    stale = ended and not seen_live
    if stale:
        trimmed = len(segments)
    else:
        trimmed = 0
        while trimmed < len(segments) and resolve(segments[trimmed].uri) in delivered:
            trimmed += 1
    dropped, segments = segments[:trimmed], segments[trimmed:]

    header = list(playlist.header)
    if not header or header[0] != "#EXTM3U":
        header = ["#EXTM3U"] + [line for line in header if line != "#EXTM3U"]
    if trimmed:
        _set_header_int(header, "#EXT-X-MEDIA-SEQUENCE", (_header_int(header, "#EXT-X-MEDIA-SEQUENCE") or 0) + trimmed)
        discontinuities = sum(1 for segment in dropped for tag in segment.tags if tag == DISCONTINUITY)
        if discontinuities:
            current = _header_int(header, "#EXT-X-DISCONTINUITY-SEQUENCE") or 0
            _set_header_int(header, "#EXT-X-DISCONTINUITY-SEQUENCE", current + discontinuities)
        if segments:
            carried = {}
            for segment in dropped:
                for tag in segment.tags:
                    if _tag_name(tag) in STICKY_SEGMENT_TAGS:
                        carried[_tag_name(tag)] = tag
            own = {_tag_name(tag) for tag in segments[0].tags}
            prefix = [tag for name, tag in carried.items() if name not in own]
            if prefix:
                segments[0] = Segment(prefix + segments[0].tags, segments[0].uri)

    lines = list(header)
    for segment in segments:
        tags = segment.tags
        if rewrite is not None:
            tags = [_rewrite_uri_attributes(tag, rewrite) for tag in tags]
        lines.extend(tags)
        lines.append(rewrite(segment.uri) if rewrite is not None else segment.uri)
    if ended:
        lines.append(ENDLIST)
    info = {
        "ended": ended,
        "offline_dropped": offline_dropped,
        "trimmed": trimmed,
        "stale": stale,
        "segments": len(segments),
    }
    return "\n".join(lines) + "\n", info


def _parse_attributes(line):
    value = line.split(":", 1)[1] if ":" in line else ""
    return {key: raw.strip('"') for key, raw in ATTRIBUTE_PATTERN.findall(value)}


def _variant_rank(attributes):
    area = 0
    resolution = attributes.get("RESOLUTION", "")
    if "x" in resolution:
        try:
            width, height = resolution.lower().split("x", 1)
            area = int(width) * int(height)
        except ValueError:
            area = 0
    try:
        bandwidth = int(attributes.get("BANDWIDTH") or 0)
    except ValueError:
        bandwidth = 0
    return (area, bandwidth)


def select_best_variant(text, *, rewrite=None):
    """Keep only the best ``#EXT-X-STREAM-INF`` variant of a master playlist."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    variants = []  # (inf_index, uri_index, attributes)
    for index, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF:"):
            uri_index = next((j for j in range(index + 1, len(lines)) if not lines[j].startswith("#")), None)
            if uri_index is not None:
                variants.append((index, uri_index, _parse_attributes(line)))
    keep = None
    if variants:
        keep = max(variants, key=lambda item: _variant_rank(item[2]))
    drop = set()
    for inf_index, uri_index, _attrs in variants:
        if keep is not None and inf_index == keep[0]:
            continue
        drop.update({inf_index, uri_index})
    output = []
    for index, line in enumerate(lines):
        if index in drop or line.startswith("#EXT-X-I-FRAME-STREAM-INF"):
            continue
        if rewrite is not None:
            line = rewrite(line) if not line.startswith("#") else _rewrite_uri_attributes(line, rewrite)
        output.append(line)
    chosen = keep[2] if keep is not None else {}
    return "\n".join(output) + "\n", {"variants": len(variants), "chosen": chosen}


def _rewrite_uri_attributes(tag, rewrite):
    return URI_ATTRIBUTE_PATTERN.sub(lambda match: f'URI="{rewrite(match.group(1))}"', tag)


@dataclass
class _Route:
    token: str
    key: object
    origin: str  # scheme://host[:port] of the upstream (Owncast)
    cache: dict = field(default_factory=dict)  # upstream path -> (monotonic, filtered text)
    logged: set = field(default_factory=set)


class _RecordingState:
    """What one recording has captured in the current OBS connection."""

    def __init__(self, *, max_entries, ttl):
        self.epoch = None  # Owncast's connect marker the state belongs to
        self.delivered = OrderedDict()  # upstream segment key -> monotonic time
        self.seen_live = set()  # upstream playlist paths seen without ENDLIST
        self._max_entries = max_entries
        self._ttl = ttl

    def mark_delivered(self, key):
        now = time.monotonic()
        self.delivered[key] = now
        self.delivered.move_to_end(key)
        while self.delivered and (
            len(self.delivered) > self._max_entries or now - next(iter(self.delivered.values())) > self._ttl
        ):
            self.delivered.popitem(last=False)

    def delivered_keys(self):
        return frozenset(self.delivered)

    def start_epoch(self, epoch):
        if self.epoch != epoch:
            self.epoch = epoch
            self.delivered.clear()
            self.seen_live.clear()


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, proxy):
        self.proxy = proxy
        super().__init__(address, _Handler)


class _Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ClassRecordingHlsFilter"
    sys_version = ""
    timeout = 120  # idle keep-alive connections are closed

    def do_GET(self):  # noqa: N802 - stdlib naming
        try:
            self.server.proxy._handle(self)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True

    def do_HEAD(self):  # noqa: N802
        self._send_simple(405, b"")

    def _send_simple(self, status, body, content_type="text/plain"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        logger.debug("CLASS_RECORDING_HLS_PROXY " + format, *args)


class HlsFilterProxy:
    """One filtering proxy per recorder process (thread-safe)."""

    def __init__(
        self,
        *,
        bind="127.0.0.1",
        fetch_timeout=10.0,
        stale_grace=30.0,
        max_recordings=32,
        delivered_max=20000,
        delivered_ttl=7 * 3600.0,
        user_agent="alsyed-class-recorder",
    ):
        self._bind = bind
        self.fetch_timeout = float(fetch_timeout)
        self.stale_grace = float(stale_grace)
        self._max_recordings = int(max_recordings)
        self._delivered_max = int(delivered_max)
        self._delivered_ttl = float(delivered_ttl)
        self._user_agent = user_agent
        self._lock = threading.Lock()
        self._routes = {}
        self._recordings = OrderedDict()
        self._server = None
        self._thread = None

    # ------------------------------------------------------------ lifecycle
    @property
    def running(self):
        return self._server is not None

    @property
    def base_url(self):
        if self._server is None:
            return ""
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self):
        with self._lock:
            if self._server is None:
                server = _Server((self._bind, 0), self)
                thread = threading.Thread(
                    target=server.serve_forever, kwargs={"poll_interval": 0.5}, name="class-recording-hls-filter", daemon=True
                )
                thread.start()
                self._server, self._thread = server, thread
        return self.base_url

    def stop(self):
        with self._lock:
            server, thread = self._server, self._thread
            self._server = self._thread = None
            self._routes.clear()
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=5)

    # --------------------------------------------------------------- routes
    def register(self, source_url, *, key, epoch=""):
        """``(token, proxied URL)`` for ``source_url`` (an http(s) HLS playlist).

        ``key`` identifies the recording, ``epoch`` the OBS connection (what
        was captured is only remembered within one epoch).
        """
        parts = urlsplit(str(source_url))
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise ValueError(f"Unsupported HLS source URL: {source_url!r}")
        base = self.start()
        token = secrets.token_urlsafe(16)
        with self._lock:
            self._routes[token] = _Route(token=token, key=key, origin=f"{parts.scheme}://{parts.netloc}")
            self._state_for(key).start_epoch(str(epoch or ""))
        path = parts.path or "/"
        query = f"?{parts.query}" if parts.query else ""
        return token, f"{base}/c/{token}{path}{query}"

    def release(self, token):
        with self._lock:
            self._routes.pop(token, None)

    def forget(self, key):
        with self._lock:
            self._recordings.pop(key, None)
            for token in [token for token, route in self._routes.items() if route.key == key]:
                self._routes.pop(token, None)

    def _state_for(self, key):
        state = self._recordings.get(key)
        if state is None:
            state = _RecordingState(max_entries=self._delivered_max, ttl=self._delivered_ttl)
            self._recordings[key] = state
        self._recordings.move_to_end(key)
        while len(self._recordings) > self._max_recordings:
            self._recordings.popitem(last=False)
        return state

    # ------------------------------------------------------------- requests
    def _handle(self, handler):
        parts = urlsplit(handler.path)
        match = TOKEN_PATTERN.match(parts.path)
        route = None
        if match:
            with self._lock:
                route = self._routes.get(match.group(1))
        if route is None or ".." in parts.path.split("/"):
            handler._send_simple(404, b"not found")
            return
        upstream_path = match.group(2)
        upstream_url = route.origin + upstream_path + (f"?{parts.query}" if parts.query else "")
        if upstream_path.lower().endswith((".m3u8", ".m3u")):
            self._serve_playlist(handler, route, upstream_path, upstream_url)
        else:
            self._serve_segment(handler, route, upstream_path, upstream_url, parts.query)

    def _request(self, url, headers=None):
        request = urllib.request.Request(url, headers={"User-Agent": self._user_agent, **(headers or {})})
        return urllib.request.urlopen(request, timeout=self.fetch_timeout)  # noqa: S310 - fixed http(s) origin

    def _rewriter(self, route, base_url):
        origin = route.origin

        def rewrite(uri):
            if uri.startswith(f"{origin}/"):
                return f"/c/{route.token}{uri[len(origin):]}"
            return uri

        def resolve(uri):
            absolute = urljoin(base_url, uri)
            parts = urlsplit(absolute)
            if f"{parts.scheme}://{parts.netloc}" != origin:
                return absolute
            return parts.path + (f"?{parts.query}" if parts.query else "")

        return rewrite, resolve

    def _serve_playlist(self, handler, route, upstream_path, upstream_url):
        requested_at = time.monotonic()
        try:
            with self._request(upstream_url) as response:
                text = response.read(4 * 1024 * 1024).decode("utf-8", errors="replace")
        except (urllib.error.URLError, OSError, ValueError) as exc:
            cached = route.cache.get(upstream_path)
            if cached is not None and requested_at - cached[0] <= self.stale_grace:
                self._send_playlist(handler, cached[1])
                return
            status = exc.code if isinstance(exc, urllib.error.HTTPError) else 502
            handler._send_simple(status if 400 <= status < 600 else 502, b"upstream playlist unavailable")
            return
        if not text.lstrip("﻿ \r\n\t").startswith("#EXTM3U"):
            handler._send_simple(502, b"upstream did not return an HLS playlist")
            return
        rewrite, resolve = self._rewriter(route, upstream_url)
        if is_master_playlist(text):
            output, info = select_best_variant(text, rewrite=rewrite)
            if info["variants"] > 1 and "variant" not in route.logged:
                route.logged.add("variant")
                logger.info(
                    "CLASS_RECORDING_HLS_VARIANT key=%s chosen=%s of=%s", route.key, info["chosen"], info["variants"]
                )
        else:
            with self._lock:
                state = self._state_for(route.key)
                delivered = state.delivered_keys()
                seen_live = upstream_path in state.seen_live
            output, info = filter_media_playlist(
                text, resolve=resolve, delivered=delivered, seen_live=seen_live, rewrite=rewrite
            )
            if not info["ended"]:
                with self._lock:
                    self._state_for(route.key).seen_live.add(upstream_path)
            if info["offline_dropped"] and "offline" not in route.logged:
                route.logged.add("offline")
                logger.info(
                    "CLASS_RECORDING_OFFLINE_TAIL_SKIPPED key=%s playlist=%s segments=%s",
                    route.key,
                    upstream_path,
                    info["offline_dropped"],
                )
            if info["stale"] and "stale" not in route.logged:
                route.logged.add("stale")
                logger.info("CLASS_RECORDING_STALE_PLAYLIST_SKIPPED key=%s playlist=%s", route.key, upstream_path)
        route.cache[upstream_path] = (time.monotonic(), output)
        self._send_playlist(handler, output)

    @staticmethod
    def _send_playlist(handler, text):
        handler._send_simple(200, text.encode("utf-8"), content_type=PLAYLIST_CONTENT_TYPE)

    def _serve_segment(self, handler, route, upstream_path, upstream_url, query):
        headers = {}
        requested_range = handler.headers.get("Range")
        if requested_range:
            headers["Range"] = requested_range
        response = None
        for attempt in range(2):
            try:
                response = self._request(upstream_url, headers)
                break
            except urllib.error.HTTPError as exc:
                if attempt == 0 and exc.code in {404, 500, 502, 503, 504}:
                    time.sleep(0.5)
                    continue
                handler._send_simple(exc.code if 400 <= exc.code < 600 else 502, b"")
                return
            except (urllib.error.URLError, OSError, ValueError):
                if attempt == 0:
                    time.sleep(0.5)
                    continue
                handler._send_simple(502, b"")
                return
        if response is None:
            handler._send_simple(502, b"")
            return
        key = upstream_path + (f"?{query}" if query else "")
        with response:
            status = getattr(response, "status", 200) or 200
            length = response.headers.get("Content-Length")
            content_range = response.headers.get("Content-Range", "")
            handler.send_response(status)
            handler.send_header("Content-Type", response.headers.get("Content-Type") or "video/mp2t")
            handler.send_header("Cache-Control", "no-cache")
            if content_range:
                handler.send_header("Content-Range", content_range)
            if length is not None:
                handler.send_header("Content-Length", length)
            else:
                handler.send_header("Connection", "close")
                handler.close_connection = True
            handler.end_headers()
            sent = 0
            try:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    handler.wfile.write(chunk)
                    sent += len(chunk)
                handler.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, socket.timeout, OSError):
                handler.close_connection = True
                return
        complete = length is None or sent == int(length)
        if not complete:
            handler.close_connection = True
            return
        if status == 206 and not _range_reaches_end(content_range):
            return
        with self._lock:
            self._state_for(route.key).mark_delivered(key)


def _range_reaches_end(content_range):
    """``bytes 0-99/100`` -> True; partial ranges or an unknown total -> False."""
    match = re.match(r"^\s*bytes\s+(\d+)-(\d+)/(\d+)\s*$", content_range or "")
    if not match:
        return False
    start, end, total = (int(value) for value in match.groups())
    return start == 0 and end == total - 1
