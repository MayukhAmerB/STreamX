"""ffmpeg argv builders, the HLS playlist filter and its proxy (no ffmpeg needed)."""

import os
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urljoin

from django.test import SimpleTestCase, override_settings

from apps.realtime.recording import ffmpeg, hls_proxy
from apps.realtime.recording.hls_proxy import (
    HlsFilterProxy,
    filter_media_playlist,
    parse_media_playlist,
    select_best_variant,
)
from apps.realtime.recording.verification import SimulatedOwncast, is_faststart, mp4_top_level_boxes


def arg(cmd, flag):
    return cmd[cmd.index(flag) + 1]


@override_settings(STREAM_RECORDER_NICE=0, FFMPEG_BINARY="ffmpeg", FFPROBE_BINARY="ffprobe")
class ArgvBuilderTests(SimpleTestCase):
    def test_capture_direct_keeps_ffmpeg_defaults(self):
        cmd = ffmpeg.build_capture_command("http://owncast:8080/hls/stream.m3u8", "/w/part-0001.ts")
        self.assertEqual(cmd[0], "ffmpeg")
        self.assertEqual(arg(cmd, "-rw_timeout"), "15000000")
        self.assertEqual(arg(cmd, "-m3u8_hold_counters"), "15")
        self.assertNotIn("-live_start_index", cmd)
        self.assertNotIn("-http_multiple", cmd)
        # input options come before -i, output options after it
        self.assertLess(cmd.index("-rw_timeout"), cmd.index("-i"))
        self.assertLess(cmd.index("-m3u8_hold_counters"), cmd.index("-i"))
        self.assertEqual(arg(cmd, "-i"), "http://owncast:8080/hls/stream.m3u8")
        self.assertEqual(arg(cmd, "-c"), "copy")
        self.assertEqual(arg(cmd, "-f"), "mpegts")
        self.assertGreater(cmd.index("-f"), cmd.index("-i"))
        self.assertEqual(cmd[-1], "/w/part-0001.ts")
        self.assertIn("-nostdin", cmd)
        # http reconnect options do not reach HLS segment requests: not used
        self.assertFalse([item for item in cmd if item.startswith("-reconnect")])

    def test_capture_via_filter_starts_at_first_new_segment_without_prefetch(self):
        cmd = ffmpeg.build_capture_command("http://127.0.0.1:9/c/t/hls/stream.m3u8", "/w/p.ts", via_filter=True)
        self.assertEqual(arg(cmd, "-live_start_index"), "0")
        self.assertEqual(arg(cmd, "-http_multiple"), "0")
        self.assertLess(cmd.index("-live_start_index"), cmd.index("-i"))
        self.assertLess(cmd.index("-http_multiple"), cmd.index("-i"))

    @override_settings(STREAM_RECORDER_NICE=10)
    def test_nice_wraps_the_command_when_available(self):
        with patch("apps.realtime.recording.ffmpeg.shutil.which", return_value="/usr/bin/nice"):
            cmd = ffmpeg.build_capture_command("http://x/s.m3u8", "/w/p.ts")
        self.assertEqual(cmd[:3], ["/usr/bin/nice", "-n", "10"])
        self.assertEqual(cmd[3], "ffmpeg")

    def test_concat_is_a_safe_stream_copy_into_faststart_mp4(self):
        cmd = ffmpeg.build_concat_command("/w/concat.txt", "/m/out.mp4")
        self.assertEqual(arg(cmd, "-f"), "concat")
        self.assertEqual(arg(cmd, "-safe"), "0")
        self.assertLess(cmd.index("-safe"), cmd.index("-i"))
        self.assertEqual(arg(cmd, "-i"), "/w/concat.txt")
        maps = [cmd[i + 1] for i, item in enumerate(cmd) if item == "-map"]
        self.assertEqual(maps, ["0:V?", "0:a?"], "real video streams (no cover art) and every audio stream")
        self.assertEqual(arg(cmd, "-c"), "copy")
        self.assertEqual(arg(cmd, "-movflags"), "+faststart")
        self.assertEqual(cmd[cmd.index("-movflags") + 2: cmd.index("-movflags") + 4], ["-f", "mp4"])
        self.assertNotIn("-bsf:a", cmd, "the mp4 muxer adds aac_adtstoasc itself; forcing it breaks non-AAC audio")
        self.assertEqual(arg(cmd, "-max_muxing_queue_size"), ffmpeg.MUXING_QUEUE_PACKETS)
        self.assertEqual(cmd[-1], "/m/out.mp4")

    def test_remux_is_a_stream_copy_into_faststart_mp4(self):
        cmd = ffmpeg.build_remux_command("/m/in.mkv", "/m/out.mp4")
        self.assertEqual(arg(cmd, "-i"), "/m/in.mkv")
        maps = [cmd[i + 1] for i, item in enumerate(cmd) if item == "-map"]
        self.assertEqual(maps, ["0:V?", "0:a?"])
        self.assertEqual(arg(cmd, "-c"), "copy")
        self.assertEqual(arg(cmd, "-movflags"), "+faststart")
        self.assertIn("mp4", cmd)
        self.assertNotIn("-bsf:a", cmd)
        self.assertEqual(cmd[-1], "/m/out.mp4")

    def test_concat_list_escapes_quotes_and_keeps_absolute_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "class it's" / "part-0001.ts"
            second = Path(tmp) / "class it's" / "part 0002.ts"
            list_path = ffmpeg.write_concat_list([first, second], Path(tmp) / "concat.txt")
            lines = list_path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        for line, path in zip(lines, (first, second)):
            self.assertTrue(line.startswith("file '") and line.endswith("'"))
            self.assertIn("it'\\''s", line)
            # Undo ffmpeg's quoting: '...'\''...' -> the original path
            unquoted = line[len("file '"):-1].replace("'\\''", "'")
            expected = str(path.resolve())
            if os.sep == "\\":
                expected = expected.replace("\\", "/")
            self.assertEqual(unquoted, expected)

    @patch("apps.realtime.recording.ffmpeg.os.sep", "/")
    def test_concat_list_keeps_backslashes_on_linux(self):
        with patch("apps.realtime.recording.ffmpeg.Path.resolve", lambda self: self):
            line = ffmpeg.concat_list_entry(Path("/rec/odd\\name.ts"))
        self.assertIn("odd\\name.ts", line)

    def test_concat_list_refuses_line_breaks(self):
        with self.assertRaises(ffmpeg.FFmpegError):
            ffmpeg.concat_list_entry("/rec/bad\nname.ts")

    def test_concat_without_inputs_fails_cleanly(self):
        with self.assertRaises(ffmpeg.FFmpegError):
            ffmpeg.concat_to_mp4([], "/m/out.mp4", list_path="/m/list.txt")


class Mp4BoxTests(SimpleTestCase):
    def _box(self, kind, payload=b""):
        return (8 + len(payload)).to_bytes(4, "big") + kind.encode() + payload

    def test_faststart_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            fast = Path(tmp) / "fast.mp4"
            fast.write_bytes(self._box("ftyp", b"isom") + self._box("moov", b"x" * 16) + self._box("mdat", b"y" * 32))
            slow = Path(tmp) / "slow.mp4"
            slow.write_bytes(self._box("ftyp", b"isom") + self._box("mdat", b"y" * 32) + self._box("moov", b"x" * 16))
            self.assertEqual(mp4_top_level_boxes(fast), ["ftyp", "moov", "mdat"])
            self.assertTrue(is_faststart(fast))
            self.assertFalse(is_faststart(slow))


OWNCAST_LIVE = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:40
#EXTINF:2.000000,
stream-abc-40.ts
#EXTINF:2.000000,
stream-abc-41.ts
#EXTINF:2.000000,
stream-abc-42.ts
"""

OWNCAST_OFFLINE = OWNCAST_LIVE + """#EXT-X-DISCONTINUITY
#EXTINF:8.000000,
offline-v2.ts
#EXT-X-ENDLIST
"""


class PlaylistFilterTests(SimpleTestCase):
    def test_live_playlist_passes_through(self):
        text, info = filter_media_playlist(OWNCAST_LIVE)
        playlist = parse_media_playlist(text)
        self.assertEqual([s.uri for s in playlist.segments], ["stream-abc-40.ts", "stream-abc-41.ts", "stream-abc-42.ts"])
        self.assertFalse(playlist.ended)
        self.assertFalse(info["ended"])
        self.assertIn("#EXT-X-MEDIA-SEQUENCE:40", text)

    def test_offline_tail_is_cut_and_the_playlist_ended(self):
        text, info = filter_media_playlist(OWNCAST_OFFLINE)
        self.assertNotIn("offline", text)
        self.assertNotIn("#EXT-X-DISCONTINUITY", text)
        self.assertTrue(text.rstrip().endswith("#EXT-X-ENDLIST"))
        self.assertEqual(info["offline_dropped"], 1)
        self.assertEqual(len(parse_media_playlist(text).segments), 3)

    def test_offline_segment_without_discontinuity_and_anything_after_it_is_cut(self):
        text, _info = filter_media_playlist(
            OWNCAST_LIVE + "#EXTINF:8.0,\n/hls/0/offline.ts?x=1\n#EXTINF:2.0,\nstream-abc-43.ts\n"
        )
        self.assertNotIn("offline", text)
        self.assertNotIn("stream-abc-43", text)
        self.assertTrue(text.rstrip().endswith("#EXT-X-ENDLIST"))

    def test_stale_ended_playlist_never_seen_live_is_served_empty(self):
        text, info = filter_media_playlist(OWNCAST_OFFLINE, seen_live=False)
        self.assertTrue(info["stale"])
        self.assertEqual(parse_media_playlist(text).segments, [])
        self.assertTrue(text.rstrip().endswith("#EXT-X-ENDLIST"))

    def test_delivered_prefix_is_trimmed_and_sequence_moves_on(self):
        text, info = filter_media_playlist(
            OWNCAST_LIVE.replace("#EXTINF:2.000000,\nstream-abc-41.ts", "#EXT-X-DISCONTINUITY\n#EXTINF:2.000000,\nstream-abc-41.ts"),
            delivered={"stream-abc-40.ts", "stream-abc-41.ts"},
        )
        playlist = parse_media_playlist(text)
        self.assertEqual([s.uri for s in playlist.segments], ["stream-abc-42.ts"])
        self.assertIn("#EXT-X-MEDIA-SEQUENCE:42", text)
        self.assertIn("#EXT-X-DISCONTINUITY-SEQUENCE:1", text)
        self.assertEqual(info["trimmed"], 2)

    def test_only_a_leading_run_is_trimmed(self):
        text, info = filter_media_playlist(OWNCAST_LIVE, delivered={"stream-abc-41.ts"})
        self.assertEqual(info["trimmed"], 0)
        self.assertEqual(len(parse_media_playlist(text).segments), 3)

    def test_sticky_key_tag_is_carried_to_the_first_kept_segment(self):
        source = OWNCAST_LIVE.replace("#EXTINF:2.000000,\nstream-abc-40.ts", '#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:2.000000,\nstream-abc-40.ts')
        text, _info = filter_media_playlist(source, delivered={"stream-abc-40.ts"})
        lines = text.splitlines()
        self.assertLess(lines.index('#EXT-X-KEY:METHOD=AES-128,URI="k.key"'), lines.index("stream-abc-41.ts"))

    def test_best_variant_is_kept(self):
        master = (
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360\n1/stream.m3u8\n"
            '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\n0/stream.m3u8\n'
            "#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720\n2/stream.m3u8\n"
        )
        text, info = select_best_variant(master)
        self.assertEqual(info["variants"], 3)
        self.assertIn("0/stream.m3u8", text)
        self.assertNotIn("1/stream.m3u8", text)
        self.assertNotIn("2/stream.m3u8", text)
        self.assertEqual(text.count("#EXT-X-STREAM-INF"), 1)


class HlsReader:
    """What ffmpeg's HLS demuxer does with ``-live_start_index 0 -http_multiple 0``."""

    def __init__(self, url, *, hold_counters=15, poll=0.05):
        self.url = url
        self.hold_counters = hold_counters
        self.poll = poll
        self.segments = []
        self.stop = threading.Event()
        self.outcome = None

    def _get(self, url):
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.read()

    def run(self):
        try:
            text = self._get(self.url).decode()
        except urllib.error.HTTPError as exc:
            self.outcome = f"http {exc.code}"
            return self.outcome
        playlist_url = self.url
        if "#EXT-X-STREAM-INF" in text:
            uri = [line for line in text.splitlines() if line and not line.startswith("#")][0]
            playlist_url = urljoin(self.url, uri)
            text = self._get(playlist_url).decode()
        playlist = parse_media_playlist(text)
        start = int(next(l.split(":")[1] for l in playlist.header if l.startswith("#EXT-X-MEDIA-SEQUENCE")))
        if not playlist.segments:
            self.outcome = "empty playlist"
            return self.outcome
        current, holds, last = start, 0, start
        while not self.stop.is_set():
            index = current - start
            if 0 <= index < len(playlist.segments):
                uri = playlist.segments[index].uri
                self._get(urljoin(playlist_url, uri))
                self.segments.append(uri.rsplit("/", 1)[-1])
                current += 1
                continue
            if playlist.ended:
                self.outcome = "endlist"
                return self.outcome
            time.sleep(self.poll)
            playlist = parse_media_playlist(self._get(playlist_url).decode())
            start = int(next(l.split(":")[1] for l in playlist.header if l.startswith("#EXT-X-MEDIA-SEQUENCE")))
            current = max(current, start)
            if current > last:
                last, holds = current, 0
            else:
                holds += 1
                if holds >= self.hold_counters:
                    self.outcome = "hold"
                    return self.outcome
        self.outcome = "stopped"
        return self.outcome


class ProxyEndToEndTests(SimpleTestCase):
    """The filter proxy between a simulated Owncast and an ffmpeg-like reader."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, True))
        phases = {}
        for phase, count in (("a", 6), ("b", 4)):
            phases[phase] = []
            for index in range(count):
                name = f"seg-{phase}-{index:03d}.ts"
                (self.tmp / name).write_bytes(f"{phase}{index}".encode() * 50)
                phases[phase].append((name, 0.2))
        (self.tmp / "offline-v2.ts").write_bytes(b"OFFLINE" * 50)
        self.feed = SimulatedOwncast(self.tmp, phases, "offline-v2.ts", window=4, segment_seconds=0.2,
                                     offline_seconds=0.8)
        self.source = self.feed.start()
        self.addCleanup(self.feed.stop)
        self.proxy = HlsFilterProxy(fetch_timeout=3, stale_grace=2)
        self.addCleanup(self.proxy.stop)

    def reader(self, key=1, epoch=""):
        _token, url = self.proxy.register(self.source, key=key, epoch=epoch)
        return HlsReader(url)

    def run_reader(self, reader):
        thread = threading.Thread(target=reader.run, daemon=True)
        thread.start()
        return thread

    def wait(self, condition, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return True
            time.sleep(0.02)
        return condition()

    def test_live_then_offline_tail_then_reconnect(self):
        self.feed.go_live("a")
        first = self.reader()
        thread = self.run_reader(first)
        self.assertTrue(self.wait(lambda: "seg-a-005.ts" in first.segments))
        self.feed.go_offline()
        thread.join(5)
        self.assertEqual(first.outcome, "endlist", "the filter ends the playlist at the offline tail")
        self.assertEqual(first.segments, [f"seg-a-{i:03d}.ts" for i in range(6)], "every live segment, once, in order")
        self.assertFalse(self.feed.was_requested("offline"), "the offline clip is never downloaded")
        self.assertFalse(self.feed.was_requested("/hls/1/"), "only the best variant is read")

        # Reconnect race: Owncast still serves the old ended playlist -> nothing new to record.
        stale = self.reader()
        self.assertEqual(stale.run(), "empty playlist")

        self.feed.go_live("b")
        second = self.reader()
        thread = self.run_reader(second)
        self.assertTrue(self.wait(lambda: "seg-b-003.ts" in second.segments))
        second.stop.set()
        thread.join(5)
        self.assertEqual(second.segments, [f"seg-b-{i:03d}.ts" for i in range(4)])

    def test_a_restarted_capture_continues_where_the_last_one_stopped(self):
        self.feed.go_live("a")
        first = self.reader()
        thread = self.run_reader(first)
        self.assertTrue(self.wait(lambda: len(first.segments) >= 2))
        first.stop.set()
        thread.join(5)
        time.sleep(0.2)  # the proxy marks a segment delivered right after its last byte
        captured = list(first.segments)
        second = self.reader()  # same recording key: a new part after ffmpeg died
        thread = self.run_reader(second)
        self.assertTrue(self.wait(lambda: "seg-a-005.ts" in second.segments))
        second.stop.set()
        thread.join(5)
        combined = captured + second.segments
        self.assertEqual(combined, [f"seg-a-{i:03d}.ts" for i in range(6)], "no duplicate and no gap across parts")

    def test_a_new_obs_connection_starts_afresh(self):
        self.feed.go_live("a")
        first = self.reader(epoch="10:00")
        thread = self.run_reader(first)
        self.assertTrue(self.wait(lambda: len(first.segments) >= 3))
        first.stop.set()
        thread.join(5)
        time.sleep(0.2)
        # Same recording, new connection marker: what was captured before is not
        # used to skip segments (Owncast could reuse a name in a new connection).
        second = self.reader(epoch="10:05")
        thread = self.run_reader(second)
        self.assertTrue(self.wait(lambda: len(second.segments) >= 1))
        second.stop.set()
        thread.join(5)
        self.assertIn(second.segments[0], first.segments)

    def test_a_new_recording_does_not_pick_up_the_previous_class_offline_playlist(self):
        self.feed.go_live("a")
        time.sleep(1.4)
        self.feed.go_offline()
        reader = self.reader(key="another-class")
        self.assertEqual(reader.run(), "empty playlist")
        self.assertFalse(self.feed.was_requested("seg-a-"))

    def test_playlist_outage_repeats_the_last_good_playlist_briefly(self):
        self.feed.go_live("a")
        _token, url = self.proxy.register(self.source, key=7)
        master = urllib.request.urlopen(url, timeout=5).read().decode()
        variant_url = urljoin(url, [l for l in master.splitlines() if l and not l.startswith("#")][0])
        good = urllib.request.urlopen(variant_url, timeout=5).read().decode()
        self.feed.stop()
        again = urllib.request.urlopen(variant_url, timeout=5).read().decode()
        self.assertEqual(again, good)
        time.sleep(2.2)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(variant_url, timeout=5)
        self.assertEqual(caught.exception.code, 502)

    def test_unknown_tokens_and_released_routes_are_not_served(self):
        base = self.proxy.start()
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(f"{base}/c/unknown-token-123/hls/stream.m3u8", timeout=5)
        self.assertEqual(caught.exception.code, 404)
        token, url = self.proxy.register(self.source, key=1)
        self.proxy.release(token)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(url, timeout=5)
        self.assertEqual(caught.exception.code, 404)

    def test_only_http_sources_and_localhost_binding(self):
        with self.assertRaises(ValueError):
            self.proxy.register("file:///etc/passwd", key=1)
        self.assertTrue(self.proxy.start().startswith("http://127.0.0.1:"))
        self.assertEqual(hls_proxy.TOKEN_PATTERN.match("/c/../x"), None)
