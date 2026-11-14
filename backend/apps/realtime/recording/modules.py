"""Which module receives a class recording. Never "none" while a course exists.

Precedence (first match wins):

1. ``ClassRecording.module``          an admin's choice (module picker / admin)
2. ``RealtimeSession.target_module``  the host's choice for this session
3. ``LiveClass.default_module``       the class's standing default
4. the course's auto-created "Class recordings" section (RECORDING_AUTO_MODULE_TITLE),
   with ``needs_review`` so an admin can move it later.

A module that belongs to a different course than the session is skipped (and
the fallback is flagged for review) instead of failing the recording. The only
case without a module is a session whose live class is linked to no course at
all: there is no course to publish into.
"""

from dataclasses import dataclass

from django.db import transaction
from django.db.models import Max

from apps.courses.cache_utils import bump_course_list_cache_version
from apps.courses.models import Course, Section

from . import config

AUTO_MODULE_DESCRIPTION = "Recordings of live classes, published automatically after each class."
NO_COURSE_REASON = (
    "This class is not linked to a course, so its recording has nowhere to be published. Link the live class "
    "to a course (or choose a module for the recording) and retry."
)


@dataclass(frozen=True)
class ModuleChoice:
    module: object  # courses.Section or None
    origin: str  # recording | session | live_class | auto | none
    needs_review: bool = False
    reason: str = ""


def session_course_id(session):
    if session is None:
        return None
    try:
        return session.resolve_course_id()
    except Exception:  # a dangling live-class FK must not stop the recording
        return getattr(session, "linked_course_id", None)


def _live_class_default(session):
    live_class = getattr(session, "linked_live_class", None) if session is not None else None
    if live_class is None:
        return None
    return getattr(live_class, "default_module", None)


def derive_module(recording, *, create=True):
    """Return the ModuleChoice for ``recording`` (see the module docstring)."""
    session = recording.session if recording.session_id else None
    course_id = session_course_id(session)
    candidates = (
        ("recording", recording.module if recording.module_id else None),
        ("session", getattr(session, "target_module", None) if session is not None else None),
        ("live_class", _live_class_default(session)),
    )
    skipped = []
    for origin, module in candidates:
        if module is None:
            continue
        if course_id is None or module.course_id == course_id:
            return ModuleChoice(module, origin)
        skipped.append(origin)
    if course_id is None:
        return ModuleChoice(None, "none", True, NO_COURSE_REASON)
    title = config.auto_module_title()
    if skipped:
        reason = (
            f"The module chosen for this class belongs to another course, so the recording was published to "
            f'"{title}". Move it to the right module.'
        )
    else:
        reason = f'No module was chosen for this class, so the recording was published to "{title}". Move it if needed.'
    if not create:
        return ModuleChoice(None, "auto", True, reason)
    module, _created = ensure_auto_module(course_id)
    return ModuleChoice(module, "auto", True, reason)


def ensure_auto_module(course_id):
    """Get or create the course's "Class recordings" section (one per course).

    The course row is locked while looking, so two finalizes of the same
    course cannot create two sections.
    """
    title = config.auto_module_title()
    with transaction.atomic():
        course = Course.objects.select_for_update().get(pk=course_id)
        section = Section.objects.filter(course=course, title=title).order_by("id").first()
        if section is not None:
            return section, False
        top = Section.objects.filter(course=course).aggregate(top=Max("order"))["top"] or 0
        section = Section.objects.create(
            course=course, title=title, description=AUTO_MODULE_DESCRIPTION, order=int(top) + 1
        )
    bump_course_list_cache_version()
    return section, True
