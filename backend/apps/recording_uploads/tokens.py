"""Personal upload tokens: create, hash, authenticate, revoke.

A token is ``asu_`` + 43 random URL-safe characters (256 bits). Only its
SHA-256 is stored (a high-entropy secret needs no salt or slow hash). It is
sent as ``X-Upload-Token: <token>`` and is accepted ONLY by the recording
upload endpoints (their ``authentication_classes``); every other API ignores
the header. It can never manage tokens, so a leaked token cannot mint more.
"""

import hashlib
import hmac
import secrets
from datetime import timedelta

from django.utils import timezone
from rest_framework import exceptions
from rest_framework.authentication import BaseAuthentication

from config.client_ip import resolve_client_ip

from .models import RecordingUploadToken

TOKEN_PREFIX = "asu_"
HEADER = "HTTP_X_UPLOAD_TOKEN"
HEADER_NAME = "X-Upload-Token"
PREFIX_LENGTH = 12
LAST_USED_WRITE_INTERVAL = timedelta(seconds=60)


def hash_token(raw):
    return hashlib.sha256(str(raw or "").encode("utf-8")).hexdigest()


def can_upload_recordings(user):
    """Staff (admins) and instructors.

    While the Teachers section is off (``apps.users.teaching``) an instructor
    account gets 403 ``feature_disabled`` with the calm reason instead of a
    plain refusal: this raises ``FeatureDisabled`` for them, so the Console
    and the desktop uploader can say why (personal tokens included).
    """
    from apps.users import teaching

    if not user or not getattr(user, "is_authenticated", False) or not getattr(user, "is_active", False):
        return False
    if getattr(user, "is_staff", False) or getattr(user, "is_superuser", False):
        return True
    if not teaching.has_instructor_role(user):
        return False
    teaching.require_teaching(user)
    return True


def create_token(owner, name, *, expires_in_days=None):
    """Returns ``(token row, raw token)``; the raw token is never stored."""
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    expires_at = timezone.now() + timedelta(days=int(expires_in_days)) if expires_in_days else None
    token = RecordingUploadToken.objects.create(
        owner=owner,
        name=str(name or "").strip()[:80] or "OBS uploader",
        prefix=raw[:PREFIX_LENGTH],
        token_hash=hash_token(raw),
        expires_at=expires_at,
    )
    return token, raw


def revoke_token(token):
    if token.revoked_at is None:
        RecordingUploadToken.objects.filter(pk=token.pk, revoked_at__isnull=True).update(revoked_at=timezone.now())
        token.refresh_from_db(fields=["revoked_at"])
    return token


def token_is_usable(token, *, now=None):
    now = now or timezone.now()
    if token.revoked_at is not None:
        return False
    if token.expires_at is not None and token.expires_at <= now:
        return False
    return token.scope == RecordingUploadToken.SCOPE_RECORDING_UPLOAD


def lookup(raw):
    raw = str(raw or "").strip()
    if not raw.startswith(TOKEN_PREFIX) or len(raw) > 128:
        return None
    digest = hash_token(raw)
    token = RecordingUploadToken.objects.select_related("owner").filter(token_hash=digest).first()
    if token is None or not hmac.compare_digest(token.token_hash, digest):
        return None
    return token


class RecordingUploadTokenAuthentication(BaseAuthentication):
    """``X-Upload-Token`` for the recording upload endpoints only."""

    def authenticate(self, request):
        raw = request.META.get(HEADER)
        if not raw:
            return None
        token = lookup(raw)
        now = timezone.now()
        if token is None or not token_is_usable(token, now=now):
            raise exceptions.AuthenticationFailed("This upload token is invalid, expired or revoked.")
        owner = token.owner
        if not can_upload_recordings(owner):
            raise exceptions.AuthenticationFailed("This account can no longer upload class recordings.")
        if token.last_used_at is None or now - token.last_used_at >= LAST_USED_WRITE_INTERVAL:
            RecordingUploadToken.objects.filter(pk=token.pk).update(
                last_used_at=now, last_used_ip=str(resolve_client_ip(request) or "")[:64]
            )
        return owner, token

    def authenticate_header(self, request):
        return HEADER_NAME
