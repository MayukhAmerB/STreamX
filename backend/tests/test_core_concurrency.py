import threading
import time
from unittest import mock

from apps.core import concurrency
from apps.core.concurrency import (
    DistributedLock,
    LockNotAcquired,
    get_or_compute,
    per_request_memo,
    request_scope,
)
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "core-concurrency-tests"}}


@override_settings(CACHES=LOCMEM)
class DistributedLockTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def test_mutual_exclusion_and_owner_safe_release(self):
        first = DistributedLock("job", ttl=30)
        second = DistributedLock("job", ttl=30)
        self.assertEqual(first.backend, "cache")
        self.assertTrue(first.acquire())
        self.assertFalse(second.acquire())
        self.assertTrue(first.locked())
        self.assertTrue(first.release())
        self.assertTrue(second.acquire())
        # A holder whose TTL lapsed must not delete the new owner's lock.
        first.token = "stale-token"
        self.assertFalse(first.release())
        self.assertTrue(second.locked())
        second.release()

    def test_context_manager_and_timeout(self):
        holder = DistributedLock("ctx", ttl=30)
        holder.acquire()
        started = time.monotonic()
        with self.assertRaises(LockNotAcquired):
            with DistributedLock("ctx", ttl=30, blocking_timeout=0.2):
                pass
        self.assertGreaterEqual(time.monotonic() - started, 0.15)
        holder.release()
        with DistributedLock("ctx", ttl=30) as lock:
            self.assertTrue(lock.locked())
        self.assertFalse(lock.locked())

    def test_blocking_acquire_gets_lock_when_released(self):
        holder = DistributedLock("handoff", ttl=30)
        holder.acquire()
        threading.Timer(0.1, holder.release).start()
        self.assertTrue(DistributedLock("handoff", ttl=30).acquire(timeout=2))

    def test_extend_only_while_owner(self):
        lock = DistributedLock("extend", ttl=30)
        self.assertFalse(lock.extend())
        lock.acquire()
        self.assertTrue(lock.extend(60))
        lock.release()

    def test_uses_redis_py_lock_when_backend_is_redis(self):
        fake_lock = mock.Mock()
        fake_lock.acquire.return_value = True
        fake_client = mock.Mock()
        fake_client.lock.return_value = fake_lock
        with mock.patch.object(concurrency, "_redis_client", return_value=fake_client), mock.patch.object(
            cache, "make_and_validate_key", return_value=":1:core:lock:r", create=True
        ):
            lock = DistributedLock("r", ttl=5)
            self.assertEqual(lock.backend, "redis")
            self.assertTrue(lock.acquire(blocking=False))
            self.assertTrue(lock.release())
        fake_client.lock.assert_called_once()
        self.assertEqual(fake_client.lock.call_args.kwargs["timeout"], 5.0)
        self.assertEqual(fake_lock.acquire.call_args.kwargs["token"], lock_token(fake_lock))
        fake_lock.release.assert_called_once()


def lock_token(fake_lock):
    return fake_lock.acquire.call_args.kwargs["token"]


@override_settings(CACHES=LOCMEM)
class SingleFlightTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def test_fresh_value_is_reused(self):
        compute = mock.Mock(return_value={"online": True})
        self.assertEqual(get_or_compute("status", 10, compute), {"online": True})
        self.assertEqual(get_or_compute("status", 10, compute), {"online": True})
        compute.assert_called_once()

    def test_concurrent_misses_compute_once(self):
        calls = []

        def slow():
            calls.append(1)
            time.sleep(0.2)
            return "value"

        results = []
        threads = [threading.Thread(target=lambda: results.append(get_or_compute("hot", 10, slow))) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results, ["value"] * 8)
        self.assertEqual(len(calls), 1)

    def test_stale_value_served_while_someone_else_revalidates(self):
        with mock.patch("apps.core.concurrency.time.time", return_value=1000.0):
            get_or_compute("swr", 5, lambda: "old", stale_ttl=60)
        revalidating = DistributedLock("sf:swr", ttl=10)
        revalidating.acquire()
        compute = mock.Mock(return_value="new")
        with mock.patch("apps.core.concurrency.time.time", return_value=1010.0):
            self.assertEqual(get_or_compute("swr", 5, compute, stale_ttl=60), "old")
        compute.assert_not_called()
        revalidating.release()
        with mock.patch("apps.core.concurrency.time.time", return_value=1010.0):
            self.assertEqual(get_or_compute("swr", 5, compute, stale_ttl=60), "new")

    def test_compute_error_serves_stale_or_raises(self):
        with mock.patch("apps.core.concurrency.time.time", return_value=1000.0):
            get_or_compute("err", 5, lambda: "cached", stale_ttl=60)
        with mock.patch("apps.core.concurrency.time.time", return_value=1010.0):
            self.assertEqual(get_or_compute("err", 5, mock.Mock(side_effect=ConnectionError()), stale_ttl=60), "cached")
        with self.assertRaises(ConnectionError):
            get_or_compute("err-fresh", 5, mock.Mock(side_effect=ConnectionError()))

    def test_none_is_cached(self):
        compute = mock.Mock(return_value=None)
        get_or_compute("none", 10, compute)
        get_or_compute("none", 10, compute)
        compute.assert_called_once()


class PerRequestMemoTests(SimpleTestCase):
    def test_memoised_inside_scope_only(self):
        calls = []

        @per_request_memo
        def lookup(user_id, *, flag=False):
            calls.append((user_id, flag))
            return len(calls)

        with request_scope():
            self.assertEqual(lookup(1), 1)
            self.assertEqual(lookup(1), 1)
            self.assertEqual(lookup(1, flag=True), 2)
        with request_scope():
            self.assertEqual(lookup(1), 3)  # new request, new memo
        lookup(1)
        lookup(1)
        self.assertEqual(len(calls), 5)  # no scope: no memo

    def test_request_middleware_opens_a_scope(self):
        from config.observability import RequestContextMiddleware

        seen = {}

        def view(request):
            seen["memo"] = concurrency.request_memo()
            from django.http import HttpResponse

            return HttpResponse("ok")

        from django.test import RequestFactory

        RequestContextMiddleware(view)(RequestFactory().get("/"))
        self.assertEqual(seen["memo"], {})
        self.assertIsNone(concurrency.request_memo())
