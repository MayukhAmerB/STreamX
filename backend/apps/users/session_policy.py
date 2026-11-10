"""Concurrent-session limits.

Students may stay signed in on up to MAX_CONCURRENT_SESSIONS_PER_STUDENT
devices. Each signed-in device owns a SessionSlot row; its access and refresh
tokens carry the slot id in SESSION_SLOT_CLAIM and are valid only while that
row exists. Signing in on one device too many deletes the least recently used
slot, which signs that device out: its next refresh is rejected with
``session_replaced``. Instructors, staff, superusers and the
AUTH_CONCURRENT_SESSION_EMAILS allow-list are never limited and get no slot.

Lock order: every writer that adds or removes a user's slots first locks that
user's row (select_for_update), the same lock refresh rotation takes before it
writes blacklist rows, so the two can never deadlock. Recording activity
(last_seen_at) only updates the slot row and takes no user lock.

Tokens minted before slots existed carry no slot claim. They keep the old
rule (their session_version must equal the user's active_session_version, so
only the last device signed in before the upgrade qualifies) and are moved
into a slot on their first refresh, without logging anyone out on deploy.
"""

import secrets
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import salted_hmac

from config.audit import log_security_event

from .models import SessionSlot


SESSION_VERSION_CLAIM = "session_version"
SESSION_SLOT_CLAIM = "session_slot"
DEFAULT_MAX_CONCURRENT_SESSIONS_PER_STUDENT = 2

# Activity is recorded at most this often per device; refresh rotation always
# records it. Eviction order only needs minute-level precision.
LAST_SEEN_TOUCH_INTERVAL = timedelta(seconds=60)

_LEGACY_SLOT_SALT = "apps.users.session_policy.legacy_slot"


def _normalized_email(value):
    return str(value or "").strip().lower()


def allows_concurrent_sessions(user):
    """True for accounts that may sign in on any number of devices."""
    if not user:
        return False
    if getattr(user, "is_superuser", False) or getattr(user, "is_staff", False):
        return True
    if getattr(user, "role", "") == getattr(user, "ROLE_INSTRUCTOR", "instructor"):
        return True

    allowed_emails = {
        _normalized_email(email)
        for email in getattr(settings, "AUTH_CONCURRENT_SESSION_EMAILS", [])
    }
    return bool(_normalized_email(getattr(user, "email", "")) in allowed_emails)


def enforces_session_limit(user):
    return bool(user and not allows_concurrent_sessions(user))


def max_concurrent_sessions():
    try:
        value = int(
            getattr(
                settings,
                "MAX_CONCURRENT_SESSIONS_PER_STUDENT",
                DEFAULT_MAX_CONCURRENT_SESSIONS_PER_STUDENT,
            )
        )
    except (TypeError, ValueError):
        value = DEFAULT_MAX_CONCURRENT_SESSIONS_PER_STUDENT
    return max(1, value)


def get_active_session_version(user):
    try:
        return max(0, int(getattr(user, "active_session_version", 0) or 0))
    except (TypeError, ValueError):
        return 0


def _claim(token, name):
    try:
        return token.get(name)
    except AttributeError:
        return None


def token_session_slot(token):
    value = _claim(token, SESSION_SLOT_CLAIM)
    return str(value) if value not in (None, "") else None


def legacy_session_slot(jti):
    """Slot id a pre-slot refresh token migrates into.

    Derived from the token's jti so concurrent refreshes of one legacy token
    all claim the same slot.
    """
    return salted_hmac(_LEGACY_SLOT_SALT, str(jti)).hexdigest()


def _session_version_matches(token, user):
    active_version = get_active_session_version(user)
    token_version = _claim(token, SESSION_VERSION_CLAIM)

    if active_version <= 0:
        if token_version in (None, "", 0, "0"):
            return True
        try:
            return int(token_version) == 0
        except (TypeError, ValueError):
            return False

    try:
        return int(token_version) == active_version
    except (TypeError, ValueError):
        return False


def _touch_threshold(now):
    return now - LAST_SEEN_TOUCH_INTERVAL


def _record_activity_later(slot_pk, now):
    def touch():
        SessionSlot.objects.filter(pk=slot_pk, last_seen_at__lt=_touch_threshold(now)).update(last_seen_at=now)

    # Runs immediately outside a transaction. Inside one it waits for commit, so
    # a request never holds a slot row lock while a sign-in that holds the
    # user row lock waits to evict that slot.
    transaction.on_commit(touch, robust=True)


def token_matches_session_version(token, user):
    """The version rule alone; a token passing it may still have lost its slot."""
    if not user:
        return False
    if not enforces_session_limit(user):
        return True
    return _session_version_matches(token, user)


def token_matches_active_session(token, user, *, record_activity=False):
    if not token_matches_session_version(token, user):
        return False
    if not enforces_session_limit(user):
        return True

    slot_id = token_session_slot(token)
    if slot_id is None:
        # Pre-slot token: the session_version rule above is all it ever had.
        return True

    slot = SessionSlot.objects.filter(user_id=user.pk, slot_id=slot_id).values("pk", "last_seen_at").first()
    if slot is None:
        return False
    if record_activity:
        now = timezone.now()
        if slot["last_seen_at"] < _touch_threshold(now):
            _record_activity_later(slot["pk"], now)
    return True


def session_slot_exists(user, slot_id):
    return SessionSlot.objects.filter(user_id=user.pk, slot_id=slot_id).exists()


def touch_session_slot(user, slot_id):
    """Record activity on a slot. Caller holds the user's row lock."""
    SessionSlot.objects.filter(user_id=user.pk, slot_id=slot_id).update(last_seen_at=timezone.now())


def claim_session_slot(user, slot_id=None, *, request=None):
    """Return the user's slot ``slot_id``, creating it within the cap.

    Creating a slot when the user already holds the maximum deletes the least
    recently used ones. The caller must hold the user's row lock, which
    serialises every sign-in, migration and sign-out of that user.
    """
    slot_id = slot_id or secrets.token_hex(16)
    if SessionSlot.objects.filter(user_id=user.pk, slot_id=slot_id).exists():
        touch_session_slot(user, slot_id)
        return slot_id

    keep = max_concurrent_sessions() - 1
    evicted = list(
        SessionSlot.objects.filter(user_id=user.pk)
        .order_by("-last_seen_at", "-created_at", "-pk")
        .values_list("pk", flat=True)[keep:]
    )
    if evicted:
        SessionSlot.objects.filter(pk__in=evicted).delete()
        log_security_event(
            "auth.session_evicted",
            request=request,
            target_user_id=user.pk,
            evicted_sessions=len(evicted),
        )
    SessionSlot.objects.create(user=user, slot_id=slot_id)
    return slot_id


def release_session_slot(user, slot_id):
    """Free one device's slot. Caller holds the user's row lock."""
    if slot_id:
        SessionSlot.objects.filter(user_id=user.pk, slot_id=slot_id).delete()


def release_all_session_slots(user):
    """Sign every slot-holding device out. Caller holds the user's row lock."""
    SessionSlot.objects.filter(user_id=user.pk).delete()
