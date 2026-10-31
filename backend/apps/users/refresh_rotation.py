"""Idempotent refresh-token rotation.

Rotation makes refresh tokens single-use, but clients legitimately present the
same token more than once: several requests hit 401 together, tabs share one
cookie jar, or a response is lost on a flaky network. Without coordination the
first request rotates the token, every concurrent one is rejected, and the
user is logged out.

The successor's jti is a keyed hash of its predecessor's jti, so every
concurrent rotation of one token derives the same successor identity. The
unique index on OutstandingToken.jti makes rotation idempotent across all
workers and replicas, and blacklisting is by jti, so every copy of a successor
is revoked together. A token minted within the grace window is re-issued
rather than rotated again, so tabs that pick up a fresh cookie converge on it
instead of forking the chain.

Rotation history forms a hash chain (token -> successor -> ...). An
already-used token is redeemed only within the grace window and only while its
successor is unrevoked; logout walks the chain and revokes every descendant, so
logging out with a stale token still ends the live session.
"""

from dataclasses import dataclass
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import salted_hmac
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.utils import datetime_from_epoch, get_md5_hash_password

from config.audit import log_security_event

from .session_policy import (
    SESSION_VERSION_CLAIM,
    get_active_session_version,
    should_enforce_single_session,
    token_matches_active_session,
)

_SUCCESSOR_SALT = "apps.users.refresh_rotation.successor"
_MAX_REVOKE_HOPS = 32

REJECT_INVALID = "refresh_token_invalid"
REJECT_SESSION_REPLACED = "session_replaced"
REJECT_REVOKED = "refresh_token_revoked"


class RefreshRejected(Exception):
    def __init__(self, code, detail, *, clear_cookies):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        # A reused token's request may race a sibling that already stored the
        # successor cookie; clearing cookies then would log the browser out.
        self.clear_cookies = clear_cookies


@dataclass(frozen=True)
class RotatedSession:
    user: object
    access: str
    refresh: str


class _PresentedRefreshToken(RefreshToken):
    """Verifies signature, expiry and type; callers decide blacklist state."""

    def check_blacklist(self):
        return None


def successor_jti(jti):
    return salted_hmac(_SUCCESSOR_SALT, str(jti)).hexdigest()


def _reuse_grace_period():
    try:
        seconds = int(getattr(settings, "AUTH_REFRESH_REUSE_GRACE_SECONDS", 60))
    except (TypeError, ValueError):
        seconds = 60
    return timedelta(seconds=max(0, seconds))


def _minted_within_grace(outstanding):
    grace = _reuse_grace_period()
    if not grace or outstanding is None or outstanding.created_at is None:
        return False
    return outstanding.created_at >= timezone.now() - grace


def _is_blacklisted(outstanding):
    return BlacklistedToken.objects.filter(token=outstanding).exists()


def _issue_refresh_token(user, jti):
    token = RefreshToken()
    token[api_settings.JTI_CLAIM] = jti
    user_id = getattr(user, api_settings.USER_ID_FIELD)
    token[api_settings.USER_ID_CLAIM] = user_id if isinstance(user_id, int) else str(user_id)
    if api_settings.CHECK_REVOKE_TOKEN:
        token[api_settings.REVOKE_TOKEN_CLAIM] = get_md5_hash_password(user.password)
    if should_enforce_single_session(user):
        token[SESSION_VERSION_CLAIM] = get_active_session_version(user)
    OutstandingToken.objects.get_or_create(
        jti=jti,
        defaults={
            "user": user,
            "token": str(token),
            "created_at": token.current_time,
            "expires_at": datetime_from_epoch(token["exp"]),
        },
    )
    return token


def _live_successor(used, user):
    """Return the used token's successor while it is fresh and unrevoked.

    One hop suffices: a fresh successor is re-issued rather than rotated, so it
    can only gain a successor of its own after the grace window has closed.
    """
    successor = OutstandingToken.objects.filter(jti=successor_jti(used.jti)).first()
    if not _minted_within_grace(successor) or successor.user_id != user.pk:
        return None
    if _is_blacklisted(successor):
        return None
    return successor


def _session(user, refresh):
    return RotatedSession(user=user, access=str(refresh.access_token), refresh=str(refresh))


def _rotate_locked(presented, user, request):
    jti = presented[api_settings.JTI_CLAIM]
    outstanding = OutstandingToken.objects.filter(jti=jti).first()
    if outstanding is None or not _is_blacklisted(outstanding):
        if not api_settings.ROTATE_REFRESH_TOKENS:
            return _session(user, presented)
        if _minted_within_grace(outstanding):
            return _session(user, _issue_refresh_token(user, jti))
        if api_settings.BLACKLIST_AFTER_ROTATION:
            presented.blacklist()
        return _session(user, _issue_refresh_token(user, successor_jti(jti)))

    successor = _live_successor(outstanding, user)
    if successor is None:
        log_security_event("auth.refresh_reuse_rejected", request=request, target_user_id=user.pk)
        raise RefreshRejected(REJECT_REVOKED, "Token is blacklisted", clear_cookies=False)
    log_security_event("auth.refresh_reuse_redeemed", request=request, target_user_id=user.pk)
    return _session(user, _issue_refresh_token(user, successor.jti))


def rotate_refresh_token(raw_token, request=None):
    User = get_user_model()
    try:
        presented = _PresentedRefreshToken(raw_token)
        user_pk = presented[api_settings.USER_ID_CLAIM]
        if not User.objects.filter(pk=user_pk).exists():
            raise User.DoesNotExist("User not found")
    except (TokenError, KeyError, ValueError, User.DoesNotExist) as exc:
        raise RefreshRejected(REJECT_INVALID, str(exc), clear_cookies=True) from exc

    with transaction.atomic():
        # Lock the user row first, matching login's single-session rotation:
        # both then insert blacklist rows, and opposite lock orders deadlock.
        user = User.objects.select_for_update().get(pk=user_pk)
        if token_matches_active_session(presented, user):
            return _rotate_locked(presented, user, request)
        presented.blacklist()

    raise RefreshRejected(
        REJECT_SESSION_REPLACED,
        "This account is active on another device. Please log in again.",
        clear_cookies=True,
    )


def revoke_refresh_token(raw_token):
    """Blacklist a presented token and every successor derived from it.

    Clients can log out with a token that was already rotated (a stale tab or
    app state); revoking only that token would leave its live successor valid.
    """
    value = str(raw_token or "").strip()
    if not value:
        return
    try:
        presented = _PresentedRefreshToken(value)
    except TokenError:
        return
    presented.blacklist()
    jti = presented[api_settings.JTI_CLAIM]
    for _ in range(_MAX_REVOKE_HOPS):
        jti = successor_jti(jti)
        node = OutstandingToken.objects.filter(jti=jti).first()
        if node is None:
            return
        BlacklistedToken.objects.get_or_create(token=node)
