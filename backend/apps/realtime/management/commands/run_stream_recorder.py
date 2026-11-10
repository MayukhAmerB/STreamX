import os
import signal
import socket
import threading
import time

from django.core.cache import cache
from django.core.management.base import BaseCommand

from apps.realtime.recording import config
from apps.realtime.recording.recorder import StreamRecorder

LEADER_KEY = "realtime:stream-recorder:leader"


class LeaderLease:
    """Best-effort single-runner guard (two recorders would double-capture).

    The lease is renewed by its own thread every ``ttl / 3`` seconds while it is
    held, so a slow tick (a capture that takes long to stop, a slow Owncast
    status call) can never let it lapse; finalizes run on the recorder's
    finalize thread and never hold up the loop either.
    """

    def __init__(self, identity, ttl, *, cache_backend=None):
        self.identity = identity
        self.ttl = int(ttl)
        self._cache = cache_backend or cache
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self.held = False

    def try_hold(self):
        with self._lock:
            if self._cache.add(LEADER_KEY, self.identity, timeout=self.ttl):
                self.held = True
            elif self._cache.get(LEADER_KEY) == self.identity:
                self._cache.set(LEADER_KEY, self.identity, timeout=self.ttl)
                self.held = True
            else:
                self.held = False
            return self.held

    def renew(self):
        """Extend a held lease; drops it if another recorder owns the key now."""
        with self._lock:
            if not self.held:
                return False
            if self._cache.get(LEADER_KEY) == self.identity:
                self._cache.set(LEADER_KEY, self.identity, timeout=self.ttl)
                return True
            self.held = False
            return False

    def start_renewing(self, interval=None):
        interval = max(0.05, float(interval if interval is not None else self.ttl / 3))

        def _loop():
            while not self._stop.wait(interval):
                try:
                    self.renew()
                except Exception:  # cache hiccup: the next round or the loop retries
                    pass

        self._thread = threading.Thread(target=_loop, name="stream-recorder-leader", daemon=True)
        self._thread.start()
        return self._thread

    def release(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        with self._lock:
            if self._cache.get(LEADER_KEY) == self.identity:
                self._cache.delete(LEADER_KEY)
            self.held = False


class Command(BaseCommand):
    help = (
        "Record live OBS classes from the Owncast HLS feed (ffmpeg stream copy), finalize them "
        "into module lectures and publish them when their HLS transcode is ready. Run exactly one."
    )

    def add_arguments(self, parser):
        parser.add_argument("--poll-seconds", type=float, default=2.0, help="Loop interval (default 2s).")
        parser.add_argument("--once", action="store_true", help="Run a single tick and exit.")

    def handle(self, *args, **options):
        poll_seconds = max(0.5, float(options.get("poll_seconds") or 2.0))
        if options.get("once"):
            StreamRecorder().tick()  # finalizes inline
            return

        stopping = {"value": False}

        def _request_stop(signum, _frame):
            stopping["value"] = True

        signal.signal(signal.SIGTERM, _request_stop)
        signal.signal(signal.SIGINT, _request_stop)

        identity = f"{socket.gethostname()}:{os.getpid()}"
        lease = LeaderLease(identity, int(max(30, poll_seconds * 10)))
        # Long concats/remuxes run on the finalize thread, so a new class can
        # start capturing while an earlier one is still being finalized.
        recorder = StreamRecorder(background_finalize=True, should_finalize=lambda: lease.held)
        lease.start_renewing()
        if not config.recorder_enabled():
            self.stdout.write("STREAM_RECORDER_ENABLED is off: no new captures will start (finalize/publish still run).")
        self.stdout.write(self.style.SUCCESS(f"Stream recorder started ({identity}), polling every {poll_seconds}s."))
        try:
            while not stopping["value"]:
                if lease.try_hold():
                    try:
                        recorder.tick()
                    except Exception as exc:  # never let one bad tick kill the service
                        self.stderr.write(self.style.ERROR(f"Recorder tick failed: {exc}"))
                time.sleep(poll_seconds)
        finally:
            recorder.shutdown()
            lease.release()
            self.stdout.write("Stream recorder stopped.")
