import io
import random
import socket
import threading
import time
import urllib.error
from email.message import Message

from apps.core.circuit import (
    STATE_CLOSED,
    STATE_HALF_OPEN,
    STATE_OPEN,
    BreakerConfig,
    CircuitBreaker,
    CircuitOpenError,
)
from apps.core.http import (
    HttpClient,
    UpstreamConnectionError,
    UpstreamHTTPError,
    UpstreamTimeout,
    backoff_delay,
)
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "core-http-tests"}}


class FakeClock:
    def __init__(self, start=1_000_000.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class FakeResponse:
    def __init__(self, status=200, body=b"{}", headers=None):
        self.status = status
        self._body = io.BytesIO(body)
        message = Message()
        for key, value in (headers or {}).items():
            message[key] = value
        self.headers = message

    def read(self):
        return self._body.read()

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(url, code, headers=None, body=b"err"):
    message = Message()
    for key, value in (headers or {}).items():
        message[key] = value
    return urllib.error.HTTPError(url, code, "error", message, io.BytesIO(body))


class ScriptedOpener:
    """Returns/raises the scripted outcomes in order; records calls."""

    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def __call__(self, request, timeout):
        self.calls.append({"method": request.get_method(), "url": request.full_url, "timeout": timeout})
        outcome = self.outcomes.pop(0) if len(self.outcomes) > 1 else self.outcomes[0]
        if isinstance(outcome, BaseException):
            raise outcome
        if callable(outcome):
            return outcome(request)
        return outcome


@override_settings(CACHES=LOCMEM)
class CircuitBreakerTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        self.clock = FakeClock()
        self.breaker = CircuitBreaker(
            "test-upstream",
            BreakerConfig(failure_threshold=3, failure_window_seconds=60, open_seconds=30, probe_timeout_seconds=10),
            clock=self.clock,
        )

    def _fail(self, times):
        for _ in range(times):
            self.breaker.allow().failure()

    def test_opens_after_consecutive_failures(self):
        self._fail(2)
        self.assertEqual(self.breaker.state(), STATE_CLOSED)
        self._fail(1)
        self.assertEqual(self.breaker.state(), STATE_OPEN)
        with self.assertRaises(CircuitOpenError) as ctx:
            self.breaker.allow()
        self.assertEqual(ctx.exception.status, 503)
        self.assertEqual(ctx.exception.code, "circuit_open")
        self.assertEqual(ctx.exception.headers["Retry-After"], "30")

    def test_success_resets_consecutive_failures(self):
        self._fail(2)
        self.breaker.allow().success()
        self._fail(2)
        self.assertEqual(self.breaker.state(), STATE_CLOSED)

    def test_half_open_allows_exactly_one_probe_then_closes_on_success(self):
        self._fail(3)
        self.clock.advance(31)
        self.assertEqual(self.breaker.state(), STATE_HALF_OPEN)
        probe = self.breaker.allow()
        self.assertTrue(probe.is_probe)
        with self.assertRaises(CircuitOpenError):
            self.breaker.allow()  # single flight: a concurrent caller is refused
        probe.success()
        self.assertEqual(self.breaker.state(), STATE_CLOSED)
        self.assertFalse(self.breaker.allow().is_probe)

    def test_failed_probe_reopens_for_a_full_window(self):
        self._fail(3)
        self.clock.advance(31)
        self.breaker.allow().failure()
        self.assertEqual(self.breaker.state(), STATE_OPEN)
        self.clock.advance(29)
        with self.assertRaises(CircuitOpenError):
            self.breaker.allow()
        self.clock.advance(2)
        self.assertTrue(self.breaker.allow().is_probe)

    def test_released_probe_lets_the_next_caller_probe(self):
        self._fail(3)
        self.clock.advance(31)
        self.breaker.allow().release()
        self.assertTrue(self.breaker.allow().is_probe)

    def test_state_is_shared_between_instances(self):
        self._fail(3)
        other_worker = CircuitBreaker("test-upstream", self.breaker.config, clock=self.clock)
        self.assertEqual(other_worker.state(), STATE_OPEN)

    def test_cache_outage_fails_open(self):
        class BrokenCache:
            def __getattr__(self, name):
                def boom(*args, **kwargs):
                    raise ConnectionError("redis down")

                return boom

        class BrokenCacheBreaker(CircuitBreaker):
            @property
            def cache(self):
                return BrokenCache()

        breaker = BrokenCacheBreaker("broken", BreakerConfig(failure_threshold=1), clock=self.clock)
        permit = breaker.allow()
        permit.failure()
        self.assertEqual(breaker.state(), STATE_CLOSED)
        self.assertFalse(breaker.allow().is_probe)

    def test_call_helper(self):
        with self.assertRaises(ValueError):
            self.breaker.call(lambda: (_ for _ in ()).throw(ValueError("x")))
        self.assertEqual(self.breaker.call(lambda: 42), 42)


class BackoffTests(SimpleTestCase):
    def test_full_jitter_bounds(self):
        rng = random.Random(7).uniform
        for attempt in range(10):
            ceiling = min(2.0, 0.2 * 2**attempt)
            for _ in range(200):
                delay = backoff_delay(attempt, base=0.2, cap=2.0, rng=rng)
                self.assertGreaterEqual(delay, 0.0)
                self.assertLessEqual(delay, ceiling)

    def test_ceiling_grows_exponentially_until_cap(self):
        upper = lambda low, high: high  # noqa: E731
        self.assertAlmostEqual(backoff_delay(0, base=0.2, cap=2.0, rng=upper), 0.2)
        self.assertAlmostEqual(backoff_delay(2, base=0.2, cap=2.0, rng=upper), 0.8)
        self.assertAlmostEqual(backoff_delay(9, base=0.2, cap=2.0, rng=upper), 2.0)


@override_settings(CACHES=LOCMEM)
class HttpClientTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        self.sleeps = []

    def client_with(self, opener, **kwargs):
        name = kwargs.pop("name", "svc")
        defaults = {
            "base_url": "http://upstream.test",
            "timeout": 2,
            "max_retries": 2,
            "opener": opener,
            "sleep": self.sleeps.append,
        }
        defaults.update(kwargs)
        return HttpClient(name, **defaults)

    def test_timeout_is_mandatory_and_bounded(self):
        for bad in (0, -1, "abc", 10_000):
            with self.assertRaises(ValueError):
                HttpClient("svc", timeout=bad)
        opener = ScriptedOpener(FakeResponse())
        client = self.client_with(opener, timeout=1.5)
        client.get("/x")
        self.assertEqual(opener.calls[0]["timeout"], 1.5)
        with self.assertRaises(ValueError):
            client.get("/x", timeout=0)

    def test_get_success_and_json(self):
        opener = ScriptedOpener(FakeResponse(body=b'{"online": true}'))
        response = self.client_with(opener).get("/api/status", params={"a": 1})
        self.assertEqual(response.json(), {"online": True})
        self.assertEqual(opener.calls[0]["url"], "http://upstream.test/api/status?a=1")

    def test_post_is_never_retried(self):
        opener = ScriptedOpener(urllib.error.URLError(ConnectionRefusedError()))
        with self.assertRaises(UpstreamConnectionError):
            self.client_with(opener).post("/orders", json={"amount": 1})
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual(self.sleeps, [])

    def test_post_retried_only_when_marked_idempotent(self):
        opener = ScriptedOpener(urllib.error.URLError(ConnectionRefusedError()), FakeResponse(body=b"{}"))
        response = self.client_with(opener).post("/orders", json={}, idempotent=True, headers={"X-Idempotency-Key": "k"})
        self.assertEqual(response.attempts, 2)
        self.assertEqual(len(opener.calls), 2)

    def test_get_retries_connection_errors_with_jittered_backoff(self):
        opener = ScriptedOpener(
            urllib.error.URLError(ConnectionRefusedError()),
            urllib.error.URLError(ConnectionRefusedError()),
            FakeResponse(),
        )
        response = self.client_with(opener, rng=lambda low, high: high).get("/x")
        self.assertEqual(response.attempts, 3)
        self.assertEqual(self.sleeps, [0.2, 0.4])

    def test_retryable_5xx_then_gives_up_with_upstream_error(self):
        opener = ScriptedOpener(http_error("http://upstream.test/x", 503))
        with self.assertRaises(UpstreamHTTPError) as ctx:
            self.client_with(opener).get("/x")
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(ctx.exception.status, 503)
        self.assertEqual(len(opener.calls), 3)

    def test_4xx_is_not_retried_and_does_not_trip_breaker(self):
        opener = ScriptedOpener(http_error("http://upstream.test/x", 404))
        client = self.client_with(opener, name="four-oh-four")
        for _ in range(10):
            with self.assertRaises(UpstreamHTTPError) as ctx:
                client.get("/x")
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(ctx.exception.status, 502)
        self.assertEqual(len(opener.calls), 10)
        self.assertEqual(client.breaker.state(), STATE_CLOSED)

    def test_raise_for_status_false_returns_response(self):
        opener = ScriptedOpener(http_error("http://upstream.test/x", 404, body=b"nope"))
        response = self.client_with(opener).get("/x", raise_for_status=False)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.text, "nope")

    @override_settings(CIRCUIT_BREAKERS={"flaky": {"failure_threshold": 2, "open_seconds": 60}})
    def test_breaker_opens_and_short_circuits_calls(self):
        from apps.core import circuit

        circuit._registry.pop("flaky", None)
        opener = ScriptedOpener(urllib.error.URLError(ConnectionRefusedError()))
        client = self.client_with(opener, name="flaky", max_retries=0)
        for _ in range(2):
            with self.assertRaises(UpstreamConnectionError):
                client.get("/x")
        with self.assertRaises(CircuitOpenError):
            client.get("/x")
        self.assertEqual(len(opener.calls), 2)  # the open circuit never touched the network
        circuit._registry.pop("flaky", None)

    def test_only_http_urls(self):
        with self.assertRaises(ValueError):
            HttpClient("svc", timeout=1).get("file:///etc/passwd")

    def test_real_socket_timeout_is_enforced(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        accepted = []

        def accept_and_hang():
            try:
                conn, _ = server.accept()
                accepted.append(conn)  # never answers
            except OSError:
                pass

        thread = threading.Thread(target=accept_and_hang, daemon=True)
        thread.start()
        client = HttpClient("hang", base_url=f"http://127.0.0.1:{port}", timeout=0.3, max_retries=0, use_breaker=False)
        started = time.monotonic()
        try:
            with self.assertRaises(UpstreamTimeout):
                client.get("/slow")
        finally:
            elapsed = time.monotonic() - started
            for conn in accepted:
                conn.close()
            server.close()
        self.assertLess(elapsed, 2.0)
