"""Control API for the end-to-end stack: ``/api/__e2e__/...``.

Mounted only by ``config.e2e_urls`` (``config.settings.e2e``), and every view
also checks ``e2e_allowed()`` and the ``X-E2E-Token`` header. The journeys use
it to reset and seed the database, move the server clock, and run the
background work (worker jobs, outbox, periodic hooks, stream recorder) at the
exact moment a test needs it instead of waiting for a poll interval.
"""

from __future__ import annotations

import hmac
import json
import logging
import threading

from django.conf import settings
from django.core.cache import cache
from django.core.management import call_command
from django.http import Http404, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from . import clock
from .apps import e2e_allowed

logger = logging.getLogger("apps.e2e_support")

_state_lock = threading.RLock()
_manifest: dict = {}
_recorder = None


def _guard(request):
    if not e2e_allowed():
        raise Http404()
    expected = str(getattr(settings, "E2E_CONTROL_TOKEN", "") or "")
    supplied = str(request.headers.get("X-E2E-Token", "") or "")
    if not expected or not hmac.compare_digest(expected, supplied):
        raise Http404()


def _body(request) -> dict:
    try:
        return json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, ValueError):
        return {}


def _apply_clock(spec) -> dict:
    if not spec:
        return clock.describe()
    if spec.get("reset"):
        clock.reset()
    if spec.get("freeze"):
        clock.freeze(spec["freeze"])
    if spec.get("travel"):
        clock.travel(spec["travel"])
    if spec.get("advance"):
        clock.advance(float(spec["advance"]))
    return clock.describe()


def _reset_recorder():
    global _recorder
    if _recorder is not None:
        try:
            _recorder.shutdown()
        except Exception:  # noqa: BLE001
            logger.exception("e2e recorder shutdown failed")
    _recorder = None


def _get_recorder():
    global _recorder
    if _recorder is None:
        from apps.realtime.recording.recorder import StreamRecorder

        from .fakes import FakeCapture

        _recorder = StreamRecorder(popen=FakeCapture, background_finalize=False)
    return _recorder


@csrf_exempt
@require_http_methods(["POST"])
def reset_view(request):
    """Flush the database, clear caches and the clock, seed, return the manifest."""
    _guard(request)
    global _manifest
    from .seeding import seed

    body = _body(request)
    with _state_lock:
        _reset_recorder()
        clock.reset()
        call_command("flush", interactive=False, verbosity=0)
        cache.clear()
        _forget_feature_stub_state()
        _apply_clock(body.get("clock"))
        _manifest = seed()
    return JsonResponse({"manifest": _manifest, "clock": clock.describe()})


@require_http_methods(["GET"])
def manifest_view(request):
    _guard(request)
    return JsonResponse({"manifest": _manifest, "clock": clock.describe()})


@csrf_exempt
@require_http_methods(["POST", "GET"])
def clock_view(request):
    _guard(request)
    if request.method == "GET":
        return JsonResponse(clock.describe())
    try:
        return JsonResponse(_apply_clock(_body(request)))
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)


def _drain(max_rounds=25) -> dict:
    from apps.core.outbox import drain_outbox
    from apps.users.async_jobs import run_pending_jobs

    totals = {"jobs": 0, "events": 0}
    for _round in range(max_rounds):
        jobs = run_pending_jobs(batch_size=50)
        events = drain_outbox(batch_size=50)
        claimed_jobs = int(jobs.get("claimed", 0) or 0)
        claimed_events = int(events.get("claimed", 0) or 0) + int(events.get("reclaimed", 0) or 0)
        totals["jobs"] += claimed_jobs
        totals["events"] += claimed_events
        if not claimed_jobs and not claimed_events:
            break
    return totals


def _run_hook(name):
    from apps.core.worker import _periodic_hooks, _periodic_lock

    with _periodic_lock:
        entry = _periodic_hooks.get(name)
    if entry is None:
        raise KeyError(name)
    return entry[1]()


def _forget_upstream_caches():
    """Status caches would hide a stub flip for a few seconds; ticks look fresh."""
    from apps.realtime import reconciler, services

    cache.delete_many(
        [
            services.OWNCAST_STATUS_CACHE_KEY,
            services.OWNCAST_STATUS_STALE_CACHE_KEY,
            services.OWNCAST_STATUS_FAILURE_CACHE_KEY,
            services.OWNCAST_STATUS_LOCK_KEY,
            reconciler.LIVEKIT_DOWN_CACHE_KEY,
        ]
    )


def _recorder_tick():
    from .fakes import patched_recording_ffmpeg

    recorder = _get_recorder()
    recorder._next_auto_start = 0.0  # noqa: SLF001 - the E2E tick decides when the loop runs
    recorder._next_start.clear()  # noqa: SLF001
    with patched_recording_ffmpeg():
        recorder.tick()
    return {"captures": sorted(recorder.captures)}


@csrf_exempt
@require_http_methods(["POST"])
def tick_view(request):
    """Run background steps in order. Steps: ``jobs`` (async jobs + outbox until
    idle), ``recorder`` (one stream-recorder loop) or any registered periodic
    hook name (``live.reconcile``, ``ctf.scheduler``, ``reports.scheduler``,
    ``recording.reconcile``...). ``rounds`` repeats the whole list."""
    _guard(request)
    body = _body(request)
    steps = body.get("steps") or ["jobs"]
    rounds = max(1, min(10, int(body.get("rounds") or 1)))
    results = []
    with _state_lock:
        _apply_clock(body.get("clock"))
        for _round in range(rounds):
            for step in steps:
                _forget_upstream_caches()
                try:
                    if step == "jobs":
                        outcome = _drain()
                    elif step == "recorder":
                        outcome = _recorder_tick()
                    else:
                        outcome = _run_hook(step)
                        outcome = outcome if isinstance(outcome, (dict, list, str, int, float, type(None))) else repr(outcome)
                    if step != "jobs" and body.get("drain", True):
                        # Hooks usually publish an outbox event that does the work.
                        outcome = {"hook": _jsonable(outcome), "drained": _drain()}
                except KeyError:
                    return JsonResponse({"error": f"unknown step {step!r}"}, status=400)
                results.append({"step": step, "result": _jsonable(outcome)})
    return JsonResponse({"results": results, "clock": clock.describe()})


def _jsonable(value):
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


def _fixture_no_courses(_body):
    from apps.courses.cache_utils import bump_course_list_cache_version
    from apps.courses.models import Course

    count = 0
    for course in Course.objects.filter(is_published=True):
        course.is_published = False
        course.save()  # like an admin edit: signals and cache invalidation run
        count += 1
    bump_course_list_cache_version()
    cache.clear()
    return {"unpublished": count}


def _fixture_lead_count(_body):
    from apps.courses.models import PublicEnrollmentLead

    leads = list(PublicEnrollmentLead.objects.order_by("pk").values("email", "message", "source_path"))
    return {"count": len(leads), "leads": leads}


def _fixture_exam_attempts(body):
    from apps.ctf.models import CtfAttempt

    rows = CtfAttempt.objects.filter(exam__slug=body.get("slug", "")).order_by("pk")
    return {
        "attempts": [
            {"user_id": row.user_id, "question": row.question.key, "answer": row.submitted_answer, "is_correct": row.is_correct}
            for row in rows.select_related("question")
        ]
    }


# >>> UI overhaul (WS-0 stubs; WS-I owns them afterwards) >>>
def _forget_feature_stub_state():
    """The WS-0 feature stub keeps overrides in memory; a reset forgets them
    (WS-F stores them in the database, which ``flush`` already empties)."""
    from apps.core import features

    forget = getattr(features, "_reset_stub_state_for_tests", None)
    if callable(forget):
        forget()


def _fixture_features(body):
    """Read or set the feature switches (``{"set": {"teaching": true}}``); see ui_fixtures."""
    from .ui_fixtures import features_fixture

    return features_fixture(body)


def _fixture_attention(body):
    """The admin attention payload (``apps.console_api.attention``) for the seeded admin."""
    from .ui_fixtures import attention_fixture

    return attention_fixture(body)


def _fixture_admin_queues(body):
    """Fill the admin "needs attention" queues (WS-I visual/a11y pages); see ui_fixtures."""
    from .ui_fixtures import admin_queues_fixture

    return admin_queues_fixture(body)


# <<< UI overhaul <<<


FIXTURES = {
    "no-courses": _fixture_no_courses,
    "leads": _fixture_lead_count,
    "exam-attempts": _fixture_exam_attempts,
    "features": _fixture_features,
    "attention": _fixture_attention,
    "admin-queues": _fixture_admin_queues,
}


@csrf_exempt
@require_http_methods(["POST"])
def fixture_view(request, name):
    """Named data tweaks/reads a journey needs (e.g. an empty catalogue)."""
    _guard(request)
    handler = FIXTURES.get(name)
    if handler is None:
        raise Http404()
    with _state_lock:
        return JsonResponse(_jsonable(handler(_body(request))), safe=False)


@csrf_exempt
@require_http_methods(["POST"])
def expire_host_heartbeat_view(request, session_id):
    """What Redis does 30 s after the Host Studio tab stops heartbeating."""
    _guard(request)
    from apps.realtime import lifecycle

    cache.delete(lifecycle._heartbeat_key(session_id))  # noqa: SLF001
    return JsonResponse({"session_id": session_id, "heartbeat": lifecycle.read_host_heartbeat(session_id)})


@require_http_methods(["GET"])
def session_state_view(request, session_id):
    _guard(request)
    from apps.realtime.models import RealtimeSession
    from apps.realtime.recording.models import ClassRecording

    session = RealtimeSession.objects.filter(pk=session_id).first()
    if session is None:
        raise Http404()
    recordings = [
        {
            "id": item.pk,
            "state": item.state,
            "source": item.source,
            "lecture_id": item.lecture_id,
            "module_id": item.module_id,
            "needs_review": getattr(item, "needs_review", False),
            "error": getattr(item, "error", ""),
        }
        for item in ClassRecording.objects.filter(session=session).order_by("pk")
    ]
    lectures = []
    for item in recordings:
        if item["lecture_id"]:
            from apps.courses.models import Lecture

            lecture = Lecture.objects.select_related("section").get(pk=item["lecture_id"])
            lectures.append(
                {
                    "id": lecture.pk,
                    "title": lecture.title,
                    "is_published": lecture.is_published,
                    "module": lecture.section.title,
                    "module_id": lecture.section_id,
                }
            )
    return JsonResponse(
        {
            "id": session.pk,
            "status": session.status,
            "stream_status": session.stream_status,
            "end_reason": getattr(session, "end_reason", ""),
            "recordings": recordings,
            "lectures": lectures,
        }
    )
