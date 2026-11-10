from datetime import timedelta
from io import StringIO
from unittest import mock

from apps.core import outbox
from apps.core.models import OutboxEvent
from django.core.management import call_command
from django.db import transaction
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from tests import factories

EFFECTS = []
SENT_MARKERS = set()


def _register(event_type, func, **kwargs):
    outbox.unregister_handler(event_type)
    outbox.outbox_handler(event_type, **kwargs)(func)


class OutboxTests(TestCase):
    def setUp(self):
        EFFECTS.clear()
        SENT_MARKERS.clear()
        _register("tests.ok", lambda event: EFFECTS.append(event.payload))

        def flaky(event):
            raise ConnectionError("smtp down")

        _register("tests.flaky", flaky, max_attempts=3)

        def permanent(event):
            raise outbox.PermanentFailure("recipient does not exist")

        _register("tests.permanent", permanent)

        def idempotent_receipt(event):
            # Exactly-once *effect*: the marker is checked before the side effect.
            order_id = event.payload["order_id"]
            if order_id in SENT_MARKERS:
                return
            EFFECTS.append(("receipt", order_id))
            SENT_MARKERS.add(order_id)

        _register("tests.receipt", idempotent_receipt)

    def tearDown(self):
        for name in ("tests.ok", "tests.flaky", "tests.permanent", "tests.receipt"):
            outbox.unregister_handler(name)

    def test_rolled_back_transaction_publishes_nothing(self):
        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                factories.make_user()
                outbox.publish("tests.ok", {"n": 1})
                raise RuntimeError("business change failed")
        self.assertFalse(OutboxEvent.objects.exists())

    def test_committed_event_is_delivered_once(self):
        with transaction.atomic():
            outbox.publish("tests.ok", {"n": 1})
        stats = outbox.drain_outbox()
        self.assertEqual(stats["delivered"], 1)
        self.assertEqual(EFFECTS, [{"n": 1}])
        event = OutboxEvent.objects.get()
        self.assertEqual(event.status, OutboxEvent.STATUS_DELIVERED)
        self.assertEqual(event.attempts, 1)
        self.assertIsNotNone(event.delivered_at)
        self.assertEqual(outbox.drain_outbox()["claimed"], 0)

    def test_failures_back_off_then_dead_letter(self):
        outbox.publish("tests.flaky", {})
        self.assertEqual(outbox.drain_outbox()["retried"], 1)
        event = OutboxEvent.objects.get()
        self.assertEqual(event.status, OutboxEvent.STATUS_PENDING)
        self.assertEqual(event.attempts, 1)
        self.assertEqual(event.max_attempts, 3)
        self.assertIn("smtp down", event.last_error)
        self.assertGreater(event.available_at, timezone.now() + timedelta(seconds=5))
        self.assertEqual(outbox.drain_outbox()["claimed"], 0)  # not due yet

        for expected in ("retried", "dead"):
            OutboxEvent.objects.update(available_at=timezone.now())
            self.assertEqual(outbox.drain_outbox()[expected], 1)
        event.refresh_from_db()
        self.assertEqual(event.status, OutboxEvent.STATUS_DEAD)
        self.assertEqual(event.attempts, 3)

    def test_backoff_is_exponential_with_bounded_jitter(self):
        with override_settings(OUTBOX_BACKOFF_BASE_SECONDS=10, OUTBOX_MAX_BACKOFF_SECONDS=60):
            for attempts, ceiling in ((1, 10), (2, 20), (3, 40), (4, 60), (9, 60)):
                low = outbox.backoff_seconds(attempts, rng=lambda a, b: a)
                high = outbox.backoff_seconds(attempts, rng=lambda a, b: b)
                self.assertEqual((low, high), (ceiling / 2, ceiling))

    def test_permanent_failure_and_missing_handler_dead_letter_immediately(self):
        outbox.publish("tests.permanent", {})
        with self.assertLogs("apps.core.outbox", level="WARNING"):
            outbox.publish("tests.unknown", {})
        stats = outbox.drain_outbox()
        self.assertEqual(stats["dead"], 2)
        self.assertEqual(set(OutboxEvent.objects.values_list("status", flat=True)), {OutboxEvent.STATUS_DEAD})

    def test_retry_dead_letter_from_admin_helper(self):
        outbox.publish("tests.permanent", {})
        outbox.drain_outbox()
        _register("tests.permanent", lambda event: EFFECTS.append("fixed"))
        self.assertEqual(outbox.retry_events(OutboxEvent.objects.all()), 1)
        self.assertEqual(outbox.drain_outbox()["delivered"], 1)
        self.assertEqual(EFFECTS, ["fixed"])

    def test_dedupe_key_makes_publish_idempotent(self):
        first = outbox.publish("tests.ok", {"n": 1}, dedupe_key="welcome:1")
        with transaction.atomic():
            second = outbox.publish("tests.ok", {"n": 1}, dedupe_key="welcome:1")
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(OutboxEvent.objects.count(), 1)

    def test_crash_between_commit_and_send_is_redelivered_with_one_effect(self):
        # 1. Business change + intent commit together.
        with transaction.atomic():
            factories.make_user()
            outbox.publish("tests.receipt", {"order_id": 42})

        # 2. Worker A claims the event, performs the side effect, then the
        #    process dies before it can mark the event delivered.
        [claimed] = outbox.claim_batch(10, worker_id="worker-a")
        outbox.registered_handlers()["tests.receipt"].func(claimed)  # effect happened...
        # ...crash: no _mark_delivered.

        # 3. While A's lock is fresh nobody else touches the event.
        self.assertEqual(outbox.drain_outbox(worker_id="worker-b")["claimed"], 0)

        # 4. After the lock timeout the event is reclaimed and redelivered;
        #    the idempotent handler does not repeat the effect.
        OutboxEvent.objects.update(locked_at=timezone.now() - timedelta(hours=1))
        stats = outbox.drain_outbox(worker_id="worker-b")
        self.assertEqual((stats["reclaimed"], stats["delivered"]), (1, 1))
        self.assertEqual(EFFECTS, [("receipt", 42)])
        event = OutboxEvent.objects.get()
        self.assertEqual(event.status, OutboxEvent.STATUS_DELIVERED)
        self.assertEqual(event.attempts, 2)

        # 5. Worker A waking up late cannot overwrite the newer delivery state.
        outbox._mark_failed(claimed, "late failure from A", permanent=True)
        event.refresh_from_db()
        self.assertEqual(event.status, OutboxEvent.STATUS_DELIVERED)

    def test_worker_crash_while_processing_cannot_loop_forever(self):
        outbox.publish("tests.flaky", {})
        for _ in range(3):
            outbox.claim_batch(10)  # attempts are burnt at claim time
            OutboxEvent.objects.update(locked_at=timezone.now() - timedelta(hours=1))
            outbox.reclaim_stale()
        event = OutboxEvent.objects.get()
        self.assertEqual(event.attempts, 3)
        self.assertEqual(event.status, OutboxEvent.STATUS_DEAD)
        self.assertIn("worker lost the lock", event.last_error)

    def test_process_async_jobs_drains_the_outbox(self):
        outbox.publish("tests.ok", {"via": "worker"})
        out = StringIO()
        call_command("process_async_jobs", "--once", stdout=out)
        self.assertIn("outbox", out.getvalue())
        self.assertEqual(EFFECTS, [{"via": "worker"}])

    def test_drain_outbox_command(self):
        outbox.publish("tests.ok", {"via": "command"})
        call_command("drain_outbox", "--once", stdout=StringIO())
        self.assertEqual(EFFECTS, [{"via": "command"}])

    def test_admin_retry_action(self):
        outbox.publish("tests.permanent", {})
        outbox.drain_outbox()
        admin = factories.make_admin()
        self.client.force_login(admin)
        event = OutboxEvent.objects.get()
        changelist = reverse("admin:core_outboxevent_changelist")
        self.assertEqual(self.client.get(changelist).status_code, 200)
        response = self.client.post(
            changelist,
            {"action": "retry_selected", "_selected_action": [event.pk]},
            follow=True,
        )
        self.assertEqual(response.status_code, 200)
        event.refresh_from_db()
        self.assertEqual(event.status, OutboxEvent.STATUS_PENDING)
        self.assertEqual(event.attempts, 0)


@override_settings(
    WEB_PUSH_ENABLED=True,
    WEB_PUSH_VAPID_PUBLIC_KEY="public",
    WEB_PUSH_VAPID_PRIVATE_KEY="private",
    ASYNC_JOBS_ENABLED=True,
)
class NotificationWebPushOutboxAdoptionTests(TestCase):
    """Reference adoption: notification web push goes through the outbox."""

    def test_push_is_published_with_the_notification_and_delivered_idempotently(self):
        from apps.notifications.models import Notification, NotificationRecipient
        from apps.notifications.outbox_handlers import WEB_PUSH_EVENT
        from apps.notifications.services import create_notification

        students = [factories.make_user(), factories.make_user()]
        with mock.patch("apps.notifications.services.send_push_for_notification") as send_now:
            notification = create_notification(
                kind=Notification.KIND_ANNOUNCEMENT,
                title="Hello",
                body="Body",
                recipients=[user.pk for user in students],
                event_key="outbox-adoption-1",
            )
        send_now.assert_not_called()  # nothing is sent inside the request
        event = OutboxEvent.objects.get(event_type=WEB_PUSH_EVENT)
        self.assertEqual(event.payload["notification_id"], notification.pk)

        NotificationRecipient.objects.filter(user=students[0]).update(pushed_at=timezone.now())
        with mock.patch("apps.notifications.services.send_push_for_notification") as send_push:
            outbox.drain_outbox()
        send_push.assert_called_once()
        self.assertEqual(send_push.call_args.args[1], [students[1].pk])  # already-pushed user skipped
        event.refresh_from_db()
        self.assertEqual(event.status, OutboxEvent.STATUS_DELIVERED)

    def test_rolled_back_notification_publishes_no_push(self):
        from apps.notifications.models import Notification
        from apps.notifications.services import create_notification

        student = factories.make_user()
        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                create_notification(
                    kind=Notification.KIND_ANNOUNCEMENT,
                    title="Hello",
                    body="Body",
                    recipients=[student.pk],
                    event_key="outbox-adoption-2",
                )
                raise RuntimeError("caller failed after creating the notification")
        self.assertFalse(OutboxEvent.objects.exists())

    @override_settings(ASYNC_JOBS_ENABLED=False)
    def test_without_async_worker_push_stays_synchronous(self):
        from apps.notifications.models import Notification
        from apps.notifications.services import create_notification

        student = factories.make_user()
        with mock.patch("apps.notifications.services.send_push_for_notification") as send_now:
            create_notification(
                kind=Notification.KIND_ANNOUNCEMENT,
                title="Hello",
                body="Body",
                recipients=[student.pk],
                event_key="outbox-adoption-3",
            )
        send_now.assert_called_once()
        self.assertFalse(OutboxEvent.objects.exists())
