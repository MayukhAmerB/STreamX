"""One recordings list over ClassRecording + RealtimeSessionRecording +
RecordingUpload (plan §4.3). OWNER: WS-G.

``GET  /api/admin/recordings/?filter=&page=``  one list, newest first
``GET  /api/admin/recordings/<id>/``           one item + player URL (review panel)
``POST /api/admin/recordings/<id>/actions/``   ``{"action": publish|unpublish|mark_reviewed|retry}``

Item ids carry their source: ``cr_<pk>`` (class recording, the lecture
pipeline), ``sr_<pk>`` (a raw LiveKit egress recording that never became a
class recording) and ``up_<uuid>`` (a Console/desktop OBS upload). Raw egress
recordings already turned into a class recording are not listed twice.

Filters: ``needs_review`` · ``failed`` · ``processing`` · ``published``
(empty = everything except cancelled/expired uploads). Actions go through
``apps.realtime.recording.services`` (the same code as the Django admin).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from django.core.exceptions import ValidationError
from django.db.models import Count, Q
from django.urls import NoReverseMatch, reverse

from apps.core.errors import NotFound, ValidationFailed

FILTERS = ("needs_review", "failed", "processing", "published")
FILTER_LABELS = {
    "needs_review": "Needs review",
    "failed": "Failed",
    "processing": "Processing",
    "published": "Published",
}
ACTIONS = ("publish", "unpublish", "mark_reviewed", "retry")
DEFAULT_PAGE_SIZE = 30
MAX_PAGE_SIZE = 100
SOURCE_LABELS = {
    "class_recording": "Class recording",
    "session_recording": "Meeting recording",
    "upload": "Upload",
}


def _models():
    from apps.realtime.models import RealtimeSessionRecording
    from apps.realtime.recording.models import ClassRecording
    from apps.recording_uploads.models import RecordingUpload

    return ClassRecording, RealtimeSessionRecording, RecordingUpload


def _admin_url(name: str, *args) -> str:
    try:
        return reverse(f"admin:{name}", args=args)
    except NoReverseMatch:
        return ""


# --------------------------------------------------------------- filters


def _class_q(filter_key: str):
    CR, _SR, _UP = _models()
    failed = Q(state=CR.STATE_FAILED)
    return {
        "needs_review": Q(needs_review=True) & ~failed,
        "failed": failed,
        "processing": Q(state__in=(CR.STATE_RECORDING, CR.STATE_FINALIZING, CR.STATE_PROCESSING, CR.STATE_IMPORTED)),
        "published": Q(state=CR.STATE_PUBLISHED),
        "": Q(),
    }[filter_key]


def _session_q(filter_key: str):
    _CR, SR, _UP = _models()
    base = Q(class_recording__isnull=True)
    return {
        "needs_review": None,
        "failed": base & Q(status=SR.STATUS_FAILED),
        "processing": base & Q(status__in=tuple(SR.ACTIVE_STATUSES)),
        "published": None,
        "": base,
    }[filter_key]


def _upload_q(filter_key: str):
    _CR, _SR, UP = _models()
    return {
        "needs_review": None,
        "failed": Q(status=UP.STATUS_FAILED),
        "processing": Q(status__in=UP.ACTIVE_STATUSES),
        "published": Q(status=UP.STATUS_COMPLETED),
        "": ~Q(status__in=(UP.STATUS_ABORTED, UP.STATUS_EXPIRED)),
    }[filter_key]


# ------------------------------------------------------------ serialisers


def _bytes(value) -> str:
    if not value:
        return ""
    size = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f} {unit}" if unit in ("B", "KB") else f"{size:.1f} {unit}"
        size /= 1024
    return ""


def _duration(seconds) -> str:
    if not seconds:
        return ""
    seconds = int(seconds)
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours} h {minutes:02d} m" if hours else f"{minutes} m {secs:02d} s"


def _facts(*pairs):
    return [{"label": label, "value": str(value)} for label, value in pairs if value not in (None, "")]


def _class_item(recording) -> dict:
    CR, _SR, _UP = _models()
    from apps.realtime.recording import services

    state = recording.state
    status = {
        CR.STATE_PUBLISHED: "published",
        CR.STATE_FAILED: "failed",
        CR.STATE_IMPORTED: "draft",
    }.get(state, "processing")
    lecture = recording.lecture if recording.lecture_id else None
    module = recording.module if recording.module_id else None
    session = recording.session if recording.session_id else None
    course = getattr(getattr(lecture, "section", None), "course", None) or getattr(module, "course", None)
    title = (lecture.title if lecture else "") or (session.title if session else "") or f"Recording #{recording.pk}"
    subtitle_parts = [part for part in (getattr(course, "title", ""), getattr(module, "title", "")) if part]
    lecture_published = bool(lecture and lecture.is_published)
    return {
        "id": f"cr_{recording.pk}",
        "source": "class_recording",
        "source_label": SOURCE_LABELS["class_recording"],
        "title": title,
        "subtitle": " · ".join(subtitle_parts) or (session.title if session and lecture else ""),
        "status": status,
        "state_label": recording.get_state_display(),
        "needs_review": bool(recording.needs_review and state != CR.STATE_FAILED),
        "review_reason": recording.review_reason or "",
        "error": recording.error or "",
        "created_at": recording.created_at.isoformat() if recording.created_at else None,
        "facts": _facts(
            ("Source", recording.get_source_display()),
            ("Class", session.title if session else ""),
            ("Course", getattr(course, "title", "")),
            ("Module", getattr(module, "title", "")),
            ("Lecture", f"{lecture.title} ({'published' if lecture_published else 'hidden'})" if lecture else ""),
            ("Length", _duration(recording.duration_seconds)),
            ("Size", _bytes(recording.file_size_bytes or recording.captured_bytes)),
            ("Attempts", recording.attempts or ""),
        ),
        "actions": {
            "publish": bool(lecture and not lecture_published),
            "unpublish": bool(lecture and lecture_published),
            "mark_reviewed": bool(recording.needs_review),
            "retry": services.can_retry(recording),
        },
        "links": {
            "back_office": _admin_url("realtime_classrecording_change", recording.pk),
            "course": f"/console/admin/courses/{course.pk}" if course else "",
            # Topic, module and description of the class (renames this lecture).
            "class_details": (
                f"/console/admin/classes/{recording.session_id}/studio?panel=setup" if recording.session_id else ""
            ),
        },
        "media_url": "",
    }


def _session_item(recording) -> dict:
    _CR, SR, _UP = _models()
    status = {SR.STATUS_FAILED: "failed", SR.STATUS_COMPLETED: "draft"}.get(recording.status, "processing")
    session = recording.session
    return {
        "id": f"sr_{recording.pk}",
        "source": "session_recording",
        "source_label": SOURCE_LABELS["session_recording"],
        "title": session.title if session else f"Recording #{recording.pk}",
        "subtitle": recording.get_recording_type_display(),
        "status": status,
        "state_label": recording.get_status_display(),
        "needs_review": False,
        "review_reason": "",
        "error": recording.error or "",
        "created_at": recording.created_at.isoformat() if recording.created_at else None,
        "facts": _facts(
            ("Type", recording.get_recording_type_display()),
            ("Started", recording.started_at.isoformat() if recording.started_at else ""),
            ("Ended", recording.ended_at.isoformat() if recording.ended_at else ""),
        ),
        "actions": {action: False for action in ACTIONS},
        "links": {"back_office": _admin_url("realtime_realtimesessionrecording_change", recording.pk), "course": ""},
        "media_url": "",
    }


def _upload_item(upload) -> dict:
    _CR, _SR, UP = _models()
    status = {
        UP.STATUS_COMPLETED: "published",
        UP.STATUS_FAILED: "failed",
        UP.STATUS_ABORTED: "off",
        UP.STATUS_EXPIRED: "off",
    }.get(upload.status, "processing")
    session = upload.session if upload.session_id else None
    lecture = upload.lecture if upload.lecture_id else None
    progress = ""
    if upload.status == UP.STATUS_UPLOADING and upload.total_bytes:
        progress = f"{round(100 * (upload.received_bytes or 0) / upload.total_bytes)}%"
    return {
        "id": f"up_{upload.pk}",
        "source": "upload",
        "source_label": SOURCE_LABELS["upload"],
        "title": upload.filename,
        "subtitle": " · ".join(part for part in ((session.title if session else ""), getattr(upload.owner, "email", "")) if part),
        "status": status,
        "state_label": upload.get_status_display(),
        "needs_review": False,
        "review_reason": "",
        "error": upload.error or "",
        "created_at": upload.created_at.isoformat() if upload.created_at else None,
        "facts": _facts(
            ("Class", session.title if session else ""),
            ("Lecture", lecture.title if lecture else ""),
            ("Outcome", upload.get_action_display() if upload.action else ""),
            ("Size", _bytes(upload.total_bytes)),
            ("Received", progress),
            ("Uploaded by", getattr(upload.owner, "email", "")),
        ),
        "actions": {action: False for action in ACTIONS},
        "links": {"back_office": _admin_url("recording_uploads_recordingupload_change", upload.pk), "course": ""},
        "media_url": "",
    }


@dataclass(frozen=True)
class _Source:
    prefix: str
    queryset: Callable
    q: Callable
    serialize: Callable


def _sources():
    CR, SR, UP = _models()
    return (
        _Source(
            "cr",
            lambda: CR.objects.select_related(
                "session", "module", "module__course", "lecture", "lecture__section", "lecture__section__course"
            ),
            _class_q,
            _class_item,
        ),
        _Source("sr", lambda: SR.objects.select_related("session"), _session_q, _session_item),
        _Source("up", lambda: UP.objects.select_related("session", "lecture", "owner"), _upload_q, _upload_item),
    )


# ------------------------------------------------------------------- list


def filter_counts() -> dict:
    CR, SR, UP = _models()
    cr = CR.objects.aggregate(**{key: Count("pk", filter=_class_q(key)) for key in FILTERS})
    sr = SR.objects.aggregate(**{key: Count("pk", filter=_session_q(key)) for key in ("failed", "processing")})
    up = UP.objects.aggregate(**{key: Count("pk", filter=_upload_q(key)) for key in ("failed", "processing", "published")})
    return {key: int(cr.get(key) or 0) + int(sr.get(key) or 0) + int(up.get(key) or 0) for key in FILTERS}


def list_recordings(user, *, filter_key: str = "", page: int = 1, page_size: int = DEFAULT_PAGE_SIZE) -> dict:
    filter_key = filter_key if filter_key in FILTERS else ""
    page = max(1, int(page or 1))
    page_size = max(1, min(MAX_PAGE_SIZE, int(page_size or DEFAULT_PAGE_SIZE)))
    window = page * page_size
    merged = []
    total = 0
    for source in _sources():
        condition = source.q(filter_key)
        if condition is None:
            continue
        queryset = source.queryset().filter(condition)
        total += queryset.count()
        for obj in queryset.order_by("-created_at")[:window]:
            merged.append((obj.created_at, source, obj))
    merged.sort(key=lambda entry: entry[0], reverse=True)
    rows = merged[(page - 1) * page_size : window]
    return {
        "results": [source.serialize(obj) for _when, source, obj in rows],
        "count": total,
        "page": page,
        "page_size": page_size,
        "filter": filter_key,
        "filters": [{"key": key, "label": FILTER_LABELS[key]} for key in FILTERS],
        "counts": filter_counts(),
    }


# ----------------------------------------------------------------- detail


def _find(item_id: str):
    text = str(item_id or "")
    prefix, _, pk = text.partition("_")
    for source in _sources():
        if source.prefix != prefix or not pk:
            continue
        if prefix != "up" and not pk.isdigit():
            break
        try:
            obj = source.queryset().filter(pk=pk).first()
        except (ValueError, ValidationError):
            obj = None
        if obj is not None:
            return source, obj
        break
    raise NotFound("This recording does not exist any more.", code="recording_not_found")


def get_recording(user, item_id: str) -> dict:
    source, obj = _find(item_id)
    item = source.serialize(obj)
    if source.prefix == "cr":
        from apps.realtime.recording import services

        try:
            path, playable = services.playable_file(obj)
        except OSError:
            path, playable = None, False
        if path is not None and playable:
            item["media_url"] = _admin_url("realtime_classrecording_media", obj.pk)
    return item


def act(user, item_id: str, action: str, *, request=None) -> dict:
    if action not in ACTIONS:
        raise ValidationFailed(details={"action": ["Choose publish, unpublish, mark_reviewed or retry."]})
    source, obj = _find(item_id)
    if source.prefix != "cr":
        raise ValidationFailed(
            "Open this one in the back office to change it.", details={"action": ["Not available for this recording."]}
        )
    from apps.realtime.recording import services

    try:
        if action in ("publish", "unpublish"):
            changed = services.set_lecture_published(obj, action == "publish", request=request)
            message = {
                ("publish", True): "Lecture published.",
                ("publish", False): "The lecture was already published.",
                ("unpublish", True): "Lecture hidden from students.",
                ("unpublish", False): "The lecture was already hidden.",
            }[(action, bool(changed))]
        elif action == "mark_reviewed":
            changed = services.mark_reviewed(obj, request=request)
            message = "Marked as reviewed." if changed else "It was already reviewed."
        else:
            changed = services.can_retry(obj) and services.retry(obj, request=request)
            if not changed:
                raise ValidationFailed(
                    "This recording can't be retried.", details={"action": ["Only failed recordings can be retried."]}
                )
            message = "Queued again from where it failed."
    except ValidationError as exc:
        raise ValidationFailed(" ".join(exc.messages), details={"action": exc.messages}) from exc
    if changed:
        _log_change(user, obj, message)
        try:
            from .attention import bump_version

            bump_version()
        except Exception:  # noqa: BLE001
            pass
    return {"message": message, "changed": bool(changed), "item": get_recording(user, item_id)}


def _log_change(user, obj, message: str) -> None:
    from django.contrib.admin.models import CHANGE, LogEntry

    if not getattr(user, "pk", None):
        return
    try:
        LogEntry.objects.log_actions(user.pk, [obj], CHANGE, change_message=message, single_object=True)
    except AttributeError:  # pragma: no cover - Django < 5.1
        pass
