"""Student profile services. Views map HTTP onto these functions only.

Rules enforced here (never trust the client):

* every document the owner saves is rebuilt by ``document.normalize_document``
  (known keys only, cleaned text, https links, owned images, earned badges);
* publishing runs the PII guard over every user-written string of the draft
  and refuses with the findings (masked) when anything is found;
* only the published snapshot is ever shown to anyone but the owner and staff;
* a hidden profile (moderation) is visible to its owner and staff only;
* every state change writes a ``ProfileAuditLog`` row without the PII itself.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import timedelta

from django.apps import apps as django_apps
from django.conf import settings
from django.core.files.base import ContentFile
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.core.errors import Conflict, NotFound, PermissionDenied, Unprocessable, ValidationFailed
from config.client_ip import resolve_client_ip

from . import document, handles, pii, richtext
from .images import process_upload
from .models import ProfileAuditLog, ProfileImage, ProfileReport, ProfileSiteSettings, StudentProfile
from .pii.detectors import handle_mentions_identity
from .sanitize import clean_text

logger = logging.getLogger("apps.profiles")

FEATURE_KEY = "public_profiles"
HANDLE_MIN = 3
HANDLE_MAX = 30
HANDLE_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9_]{1,28})[a-z0-9]$")
HANDLE_CHANGE_COOLDOWN = timedelta(days=7)
MAX_AVATARS = 4
MAX_BANNERS = 4
RESERVED_HANDLES = frozenset(
    {
        "admin", "administrator", "root", "staff", "support", "help", "moderator", "mod", "official", "system",
        "alsyed", "al_syed", "alsyedinitiative", "owlcognito", "owl_cognito", "security", "abuse", "billing",
        "payments", "teacher", "teachers", "instructor", "console", "api", "me", "edit", "new", "settings",
        "profile", "profiles", "null", "undefined", "anonymous", "everyone", "here", "team",
    }
)


# --- feature switch and settings ---------------------------------------------------------------
def is_enabled() -> bool:
    from apps.core import features

    return features.is_enabled(FEATURE_KEY)


def require_enabled() -> None:
    from apps.core import features

    features.require(FEATURE_KEY)


def site_settings() -> ProfileSiteSettings:
    return ProfileSiteSettings.load()


def is_staff(user) -> bool:
    return bool(user and getattr(user, "is_authenticated", False) and (user.is_staff or user.is_superuser))


def real_names_shown(profile: StudentProfile, rules: ProfileSiteSettings | None = None) -> bool:
    """Always False (owner rule: handle only; real names appear only on certificates).

    ``ProfileSiteSettings.allow_real_names`` and ``show_real_name`` are retired:
    kept for the admin history, never honoured."""
    return False


def scan_context(user, profile: StudentProfile | None = None, rules: ProfileSiteSettings | None = None) -> pii.ScanContext:
    allow = bool(profile is not None and real_names_shown(profile, rules))
    return pii.ScanContext(
        full_name=str(getattr(user, "full_name", "") or ""),
        email=str(getattr(user, "email", "") or ""),
        phone=str(getattr(user, "phone_number", "") or ""),
        allow_real_name=allow,
    )


# --- audit ---------------------------------------------------------------------------------------
def audit(profile, action: str, *, actor=None, request=None, **details) -> ProfileAuditLog:
    request_id = ""
    ip = None
    if request is not None:
        request_id = str(request.headers.get("X-Request-ID", "") or getattr(request, "request_id", "") or "")[:64]
        try:
            ip = resolve_client_ip(request) or None
        except Exception:  # noqa: BLE001 - the audit row matters more than the address
            ip = None
    return ProfileAuditLog.objects.create(
        profile=profile,
        handle=getattr(profile, "handle", "") or "",
        actor=actor if getattr(actor, "pk", None) else None,
        action=action,
        details=details,
        ip=ip,
        request_id=request_id,
    )


# --- handles -------------------------------------------------------------------------------------
def normalize_handle(value) -> str:
    return str(value or "").strip().lstrip("@").lower()


def validate_handle(value, *, user, profile: StudentProfile | None = None) -> str:
    handle = normalize_handle(value)
    if not (HANDLE_MIN <= len(handle) <= HANDLE_MAX) or not HANDLE_PATTERN.match(handle) or "__" in handle:
        raise ValidationFailed(
            details={
                "handle": [
                    f"Use {HANDLE_MIN}-{HANDLE_MAX} lower-case letters, numbers or single underscores "
                    "(it can't start or end with an underscore)."
                ]
            }
        )
    if handle in RESERVED_HANDLES or handle.replace("_", "") in RESERVED_HANDLES:
        raise ValidationFailed(details={"handle": ["That handle is reserved. Pick another one."]})
    ctx = scan_context(user, profile)
    if handle_mentions_identity(handle, ctx):
        raise ValidationFailed(
            details={"handle": ["Your handle can't contain your real name or email name. Pick a nickname."]},
            code="handle_identity",
        )
    findings = pii.scan_text(handle.replace("_", " "), ctx, path="handle")
    if findings:
        raise ValidationFailed(details={"handle": [findings[0].message]}, code="handle_identity")
    taken = StudentProfile.objects.filter(handle=handle)
    if profile is not None:
        taken = taken.exclude(pk=profile.pk)
    if taken.exists():
        raise Conflict("That handle is taken. Pick another one.", code="handle_taken", details={"handle": ["That handle is taken."]})
    if handles.is_auto_handle(handle) and not (profile is not None and profile.handle == handle):
        raise ValidationFailed(
            details={"handle": [f"Handles starting with {handles.AUTO_PREFIX} are kept for automatic handles. Pick another one."]}
        )
    return handle


_ADJECTIVES = ("quiet", "swift", "keen", "bright", "steady", "silent", "sharp", "calm", "bold", "clear", "lucid", "noble")
_NOUNS = ("falcon", "cipher", "beacon", "lantern", "compass", "harbor", "signal", "vector", "quill", "kestrel", "atlas", "ember")


def _suggested_handle() -> str:
    return f"{secrets.choice(_ADJECTIVES)}_{secrets.choice(_NOUNS)}_{secrets.randbelow(9000) + 1000}"


# --- profile lifecycle --------------------------------------------------------------------------
def get_profile(user) -> StudentProfile | None:
    return StudentProfile.objects.filter(user_id=user.pk).first()


AUTO_HANDLE_ATTEMPTS = 8


def create_auto_profile(user, *, actor=None, request=None, source: str = "editor") -> StudentProfile:
    """Create ``user``'s profile with its automatic handle (``handles.derived_handle``,
    the same one public surfaces already show for the account). Idempotent: an
    existing profile is returned untouched."""
    profile = get_profile(user)
    if profile is not None:
        return profile
    for attempt in range(AUTO_HANDLE_ATTEMPTS):
        handle = handles.derived_handle(user.pk, attempt)
        if StudentProfile.objects.filter(handle=handle).exists():
            continue
        try:
            with transaction.atomic():
                profile = StudentProfile.objects.create(
                    user=user,
                    handle=handle,
                    handle_auto=True,
                    draft=document.default_document(handle),
                    draft_updated_at=timezone.now(),
                )
                audit(profile, ProfileAuditLog.ACTION_AUTO_CREATED if source == "command" else ProfileAuditLog.ACTION_CREATED,
                      actor=actor, request=request, source=source)
            transaction.on_commit(lambda: handles.forget_handle(user.pk))
            return profile
        except IntegrityError:
            existing = get_profile(user)
            if existing is not None:
                return existing
    raise Conflict("Could not create your profile. Try again.", code="profile_create_failed")


def get_or_create_profile(user, *, request=None) -> StudentProfile:
    profile = get_profile(user)
    if profile is not None:
        return profile
    return create_auto_profile(user, actor=user, request=request)


def handle_prompt_pending(profile: StudentProfile) -> bool:
    """Show the one-time "customise your handle" prompt?"""
    return bool(profile.handle_auto and profile.handle_prompt_dismissed_at is None)


def dismiss_handle_prompt(profile: StudentProfile, *, actor=None, request=None) -> StudentProfile:
    if profile.handle_prompt_dismissed_at is None:
        profile.handle_prompt_dismissed_at = timezone.now()
        profile.save(update_fields=["handle_prompt_dismissed_at", "updated_at"])
    return profile


def owned_images(profile: StudentProfile) -> dict[str, str]:
    return {str(image_id): kind for image_id, kind in profile.images.values_list("id", "kind")}


def earned_badge_keys(user_id: int) -> set[str] | None:
    """Badge keys the user holds (None when the engagement app is not installed)."""
    try:
        model = django_apps.get_model("engagement", "BadgeAward")
    except LookupError:
        return None
    return set(model.objects.filter(user_id=user_id, revoked_at__isnull=True).values_list("badge_key", flat=True))


def badge_catalogue(extra_keys=()) -> dict[str, dict]:
    """Earnable badges, the release-day legacy badges and any ``extra_keys`` the
    engagement app can resolve (e.g. the per-batch "Batch Pioneer" badges)."""
    try:
        from apps.engagement import badges
    except ImportError:  # pragma: no cover - engagement is installed in this project
        return {}
    catalogue = {badge.key: badge.as_dict() for badge in (*badges.CATALOGUE, *badges.LEGACY_BADGES)}
    for key in extra_keys or ():
        if key not in catalogue:
            badge = badges.get(key)
            if badge is not None:
                catalogue[key] = badge.as_dict()
    return catalogue


def _normalize(profile: StudentProfile, raw) -> tuple[dict, list[tuple[str, str]]]:
    earned = earned_badge_keys(profile.user_id)
    return document.normalize_document(
        raw, handle=profile.handle, owned_images=owned_images(profile), badge_keys=(lambda: earned)
    )


def scan_document(profile: StudentProfile, fields) -> list[pii.Finding]:
    return pii.scan_fields(fields, scan_context(profile.user, profile))


def save_draft(profile: StudentProfile, raw, *, expected_version=None, actor=None, request=None):
    """Store a cleaned draft. Returns ``(profile, findings)``; findings are
    warnings here (the editor highlights them), publishing refuses them."""
    clean, fields = _normalize(profile, raw)
    with transaction.atomic():
        locked = StudentProfile.objects.select_for_update().get(pk=profile.pk)
        if expected_version is not None:
            try:
                expected = int(expected_version)
            except (TypeError, ValueError):
                raise ValidationFailed(details={"draft_version": ["Send the draft_version you edited."]}) from None
            if expected != locked.draft_version:
                raise Conflict(
                    "Your profile was changed in another tab. Reload to get the latest draft.",
                    code="draft_version_conflict",
                    details={"draft_version": locked.draft_version},
                )
        locked.draft = clean
        locked.draft_version += 1
        locked.draft_updated_at = timezone.now()
        locked.save(update_fields=["draft", "draft_version", "draft_updated_at", "updated_at"])
    return locked, scan_document(locked, fields)


class PiiDetected(Unprocessable):
    code = "pii_detected"
    default_message = "Your profile contains personal information."


def publish(profile: StudentProfile, *, actor=None, request=None) -> StudentProfile:
    if profile.status == StudentProfile.STATUS_HIDDEN:
        raise Conflict(
            "A moderator has hidden your profile, so it can't be published. Contact support.", code="profile_hidden"
        )
    # Re-validate the stored draft: images may have been deleted, badges revoked,
    # or the admin may have stopped allowing real names since it was saved.
    clean, fields = _normalize(profile, profile.draft or document.default_document(profile.handle))
    findings = scan_document(profile, fields)
    if findings:
        audit(
            profile,
            ProfileAuditLog.ACTION_PUBLISH_BLOCKED,
            actor=actor,
            request=request,
            codes=sorted({finding.code for finding in findings}),
            paths=sorted({finding.path for finding in findings})[:40],
        )
        raise PiiDetected(pii.summary(findings), details={"findings": [finding.as_dict() for finding in findings]})
    with transaction.atomic():
        locked = StudentProfile.objects.select_for_update().get(pk=profile.pk)
        if locked.status == StudentProfile.STATUS_HIDDEN:
            raise Conflict("A moderator has hidden your profile, so it can't be published.", code="profile_hidden")
        locked.draft = clean
        locked.published = clean
        locked.published_version = locked.draft_version
        locked.published_at = timezone.now()
        locked.save(update_fields=["draft", "published", "published_version", "published_at", "updated_at"])
        audit(locked, ProfileAuditLog.ACTION_PUBLISHED, actor=actor, request=request, version=locked.published_version)
    return locked


def unpublish(profile: StudentProfile, *, actor=None, request=None) -> StudentProfile:
    with transaction.atomic():
        locked = StudentProfile.objects.select_for_update().get(pk=profile.pk)
        if locked.published is None and locked.published_at is None:
            return locked
        locked.published = None
        locked.published_at = None
        locked.save(update_fields=["published", "published_at", "updated_at"])
        audit(locked, ProfileAuditLog.ACTION_UNPUBLISHED, actor=actor, request=request)
    return locked


def change_handle(profile: StudentProfile, value, *, actor=None, request=None) -> StudentProfile:
    handle = validate_handle(value, user=profile.user, profile=profile)
    if handle == profile.handle:
        return profile
    now = timezone.now()
    if profile.handle_changed_at and now - profile.handle_changed_at < HANDLE_CHANGE_COOLDOWN and not is_staff(actor):
        next_change = profile.handle_changed_at + HANDLE_CHANGE_COOLDOWN
        raise Conflict(
            f"You can change your handle again on {timezone.localtime(next_change):%d %b %Y}.",
            code="handle_change_too_soon",
            details={"next_change_at": next_change.isoformat()},
        )
    old = profile.handle
    with transaction.atomic():
        locked = StudentProfile.objects.select_for_update().get(pk=profile.pk)
        locked.handle = handle
        locked.handle_changed_at = now
        locked.handle_auto = False
        header = (locked.draft or {}).get("header") or {}
        if header.get("display_name") in ("", old):
            locked.draft = {**(locked.draft or {}), "header": {**header, "display_name": handle}}
        try:
            locked.save(update_fields=["handle", "handle_changed_at", "handle_auto", "draft", "updated_at"])
        except IntegrityError:
            raise Conflict("That handle is taken. Pick another one.", code="handle_taken") from None
        audit(locked, ProfileAuditLog.ACTION_HANDLE_CHANGED, actor=actor, request=request)
        transaction.on_commit(lambda: handles.forget_handle(locked.user_id))
    return locked


def leaderboard_visible(user) -> bool | None:
    try:
        model = django_apps.get_model("engagement", "EngagementSettings")
    except LookupError:
        return None
    mode = model.objects.filter(user_id=user.pk).values_list("leaderboard_display", flat=True).first()
    return mode != "hidden"


def set_leaderboard_visible(user, visible: bool) -> bool | None:
    try:
        from apps.engagement import services as engagement_services
        from apps.engagement.models import EngagementSettings
    except ImportError:  # pragma: no cover
        return None
    mode = EngagementSettings.DISPLAY_HANDLE if visible else EngagementSettings.DISPLAY_HIDDEN
    engagement_services.update_settings(user, leaderboard_display=mode)
    return visible


def update_settings(profile: StudentProfile, values: dict, *, actor=None, request=None) -> StudentProfile:
    changed: dict[str, object] = {}
    fields: list[str] = []
    if "visibility" in values:
        visibility = values["visibility"]
        if visibility not in dict(StudentProfile.VISIBILITY_CHOICES):
            raise ValidationFailed(details={"visibility": ["Choose public or members."]})
        if visibility != profile.visibility:
            profile.visibility = visibility
            fields.append("visibility")
            changed["visibility"] = visibility
    if "show_real_name" in values:
        wanted = bool(values["show_real_name"])
        if wanted:  # owner rule: handle only (real names appear only on certificates)
            raise PermissionDenied(
                "Real names are switched off. Profiles show your public handle only.", code="real_names_not_allowed"
            )
        if wanted != profile.show_real_name:
            profile.show_real_name = wanted
            fields.append("show_real_name")
            changed["show_real_name"] = wanted
    if fields:
        profile.save(update_fields=[*fields, "updated_at"])
    if "show_on_leaderboards" in values:
        result = set_leaderboard_visible(profile.user, bool(values["show_on_leaderboards"]))
        if result is not None:
            changed["show_on_leaderboards"] = result
    if changed:
        audit(profile, ProfileAuditLog.ACTION_SETTINGS_CHANGED, actor=actor, request=request, **changed)
    return profile


# --- images --------------------------------------------------------------------------------------
def image_limit(kind: str, rules: ProfileSiteSettings | None = None) -> int:
    if kind == ProfileImage.KIND_AVATAR:
        return MAX_AVATARS
    if kind == ProfileImage.KIND_BANNER:
        return MAX_BANNERS
    rules = rules or site_settings()
    return max(0, min(int(rules.max_gallery_images or 0), document.LIMITS["gallery"]))


def add_image(profile: StudentProfile, upload, *, kind: str, actor=None, request=None) -> ProfileImage:
    if kind not in dict(ProfileImage.KIND_CHOICES):
        raise ValidationFailed(details={"kind": ["Choose avatar, banner or gallery."]})
    limit = image_limit(kind)
    if profile.images.filter(kind=kind).count() >= limit:
        raise Conflict(
            f"You can keep up to {limit} {kind} images. Delete one first.", code="image_limit", details={"limit": limit}
        )
    try:
        processed = process_upload(upload, kind=kind, ctx=scan_context(profile.user, profile))
    except Exception as exc:
        code = getattr(exc, "code", type(exc).__name__)
        audit(profile, ProfileAuditLog.ACTION_IMAGE_REJECTED, actor=actor, request=request, kind=kind, reason=str(code)[:40])
        raise
    image = ProfileImage(
        profile=profile,
        kind=kind,
        content_type=processed.content_type,
        width=processed.width,
        height=processed.height,
        size_bytes=len(processed.data),
        sha256=processed.sha256,
        scanner=processed.scanner[:64],
        scanner_version=processed.scanner_version[:128],
    )
    image.file.save("image.bin", ContentFile(processed.data), save=False)
    try:
        image.save()
    except Exception:
        image.file.delete(save=False)
        raise
    audit(
        profile,
        ProfileAuditLog.ACTION_IMAGE_ADDED,
        actor=actor,
        request=request,
        kind=kind,
        image_id=str(image.id),
        stripped=processed.stripped,
    )
    return image


def delete_image(profile: StudentProfile, image_id, *, actor=None, request=None) -> None:
    image = profile.images.filter(pk=image_id).first()
    if image is None:
        raise NotFound("Image not found.", code="image_not_found")
    key = str(image.id)
    with transaction.atomic():
        locked = StudentProfile.objects.select_for_update().get(pk=profile.pk)
        locked.draft = _without_image(locked.draft, key)
        locked.draft_version += 1
        if locked.published is not None and key in document.referenced_image_ids(locked.published):
            locked.published = _without_image(locked.published, key)
        locked.save(update_fields=["draft", "draft_version", "published", "updated_at"])
        image.delete()
        transaction.on_commit(lambda: image.file.delete(save=False))
    audit(profile, ProfileAuditLog.ACTION_IMAGE_DELETED, actor=actor, request=request, kind=image.kind, image_id=key)


def _without_image(doc, key: str):
    if not isinstance(doc, dict):
        return doc
    header = dict(doc.get("header") or {})
    for field in ("avatar_id", "banner_id"):
        if str(header.get(field) or "") == key:
            header[field] = None
    blocks = []
    for block in doc.get("blocks") or []:
        if isinstance(block, dict) and block.get("type") == "gallery":
            block = {**block, "items": [item for item in block.get("items") or [] if str(item.get("image_id")) != key]}
        blocks.append(block)
    return {**doc, "header": header, "blocks": blocks}


# --- viewing ------------------------------------------------------------------------------------
def find_by_handle(handle) -> StudentProfile:
    value = normalize_handle(handle)
    if not value or len(value) > HANDLE_MAX:
        raise NotFound("Profile not found.", code="profile_not_found")
    profile = StudentProfile.objects.select_related("user").filter(handle=value).first()
    if profile is None:
        raise NotFound("Profile not found.", code="profile_not_found")
    return profile


def check_can_view(profile: StudentProfile, viewer) -> None:
    """Raise NotFound (never reveal that a hidden/unpublished profile exists)
    or AuthenticationRequired-style 403 for members-only profiles."""
    if viewer is not None and getattr(viewer, "pk", None) == profile.user_id:
        return
    if is_staff(viewer):
        return
    if profile.status != StudentProfile.STATUS_ACTIVE or not profile.is_published:
        raise NotFound("Profile not found.", code="profile_not_found")
    if not getattr(profile.user, "is_active", True):
        raise NotFound("Profile not found.", code="profile_not_found")
    if profile.visibility == StudentProfile.VISIBILITY_MEMBERS and not getattr(viewer, "is_authenticated", False):
        raise PermissionDenied("Sign in to see this profile.", code="profile_members_only")


def media_url(image_id) -> str:
    return f"/api/profiles/media/{image_id}/"


def render_document(profile: StudentProfile, doc: dict, *, rules: ProfileSiteSettings | None = None) -> dict:
    """The view model of a document (what the page renders)."""
    rules = rules or site_settings()
    doc = doc if isinstance(doc, dict) else document.default_document(profile.handle)
    header = doc.get("header") or {}
    earned = earned_badge_keys(profile.user_id) or set()
    catalogue = badge_catalogue(earned)
    blocks = []
    for block in doc.get("blocks") or []:
        if not isinstance(block, dict) or not block.get("visible", True):
            continue
        kind = block.get("type")
        item = {"id": block.get("id"), "type": kind, "title": block.get("title") or document.DEFAULT_TITLES.get(kind, "")}
        if kind == "bio":
            body = block.get("doc") if richtext.is_valid(block.get("doc")) else {"type": "doc", "content": []}
            if not body["content"]:
                continue
            item["doc"] = body
        elif kind == "badges":
            badges = [catalogue[key] for key in block.get("badge_keys") or [] if key in catalogue and key in earned]
            if not badges:
                continue
            item["items"] = badges
        elif kind == "gallery":
            item["items"] = [
                {**entry, "src": media_url(entry["image_id"])} for entry in block.get("items") or [] if entry.get("image_id")
            ]
            if not item["items"]:
                continue
        elif kind in ("skills", "writeups", "links"):
            item["items"] = list(block.get("items") or [])
            if not item["items"]:
                continue
        else:
            continue
        blocks.append(item)
    avatar = header.get("avatar_id")
    banner = header.get("banner_id")
    return {
        "theme": {**document.DEFAULT_THEME, **(doc.get("theme") or {})},
        "header": {
            "display_name": header.get("display_name") or profile.handle,
            "tagline": header.get("tagline") or "",
            "avatar": media_url(avatar) if avatar else None,
            "banner": media_url(banner) if banner else None,
            "real_name": None,  # owner rule: handle only (real names appear only on certificates)
        },
        "blocks": blocks,
    }


def public_payload(profile: StudentProfile, viewer, *, draft: bool = False) -> dict:
    rules = site_settings()
    source = profile.draft if draft else profile.published
    is_owner = bool(viewer is not None and getattr(viewer, "pk", None) == profile.user_id)
    return {
        "handle": profile.handle,
        "url": f"/u/{profile.handle}",
        "preview": bool(draft),
        "published_at": profile.published_at.isoformat() if profile.published_at else None,
        "visibility": profile.visibility,
        "is_owner": is_owner,
        "can_report": bool(getattr(viewer, "is_authenticated", False)) and not is_owner,
        "status": profile.status if (is_owner or is_staff(viewer)) else StudentProfile.STATUS_ACTIVE,
        # Release-day Founding Glow frame (30 days, active legacy students); null otherwise.
        "frame": _profile_frame(profile.user_id),
        # Rewards the student chose to feature (handle only; certificates as a plain badge, no link).
        "highlights": reward_highlights(profile.user_id),
        **render_document(profile, source, rules=rules),
    }


def reward_highlights(user_id) -> list[dict]:
    try:
        from apps.engagement.history import public_highlights
    except ImportError:  # pragma: no cover
        return []
    return public_highlights(user_id)


def _profile_frame(user_id) -> dict | None:
    try:
        from apps.engagement.journey import founding_glow
    except ImportError:  # pragma: no cover
        return None
    ends = founding_glow([user_id]).get(user_id)
    return {"kind": "founding_glow", "label": "Founding Glow", "ends_at": ends} if ends else None


def can_view_image(image: ProfileImage, viewer) -> bool:
    profile = image.profile
    if viewer is not None and getattr(viewer, "pk", None) == profile.user_id:
        return True
    if is_staff(viewer):
        return True
    try:
        check_can_view(profile, viewer)
    except (NotFound, PermissionDenied):
        return False
    return str(image.id) in document.referenced_image_ids(profile.published)


def owner_payload(profile: StudentProfile, *, request=None) -> dict:
    rules = site_settings()
    earned = earned_badge_keys(profile.user_id)
    catalogue = badge_catalogue(earned or ())
    images = [
        {
            "id": str(image.id),
            "kind": image.kind,
            "src": media_url(image.id),
            "width": image.width,
            "height": image.height,
            "created_at": image.created_at.isoformat(),
        }
        for image in profile.images.all()
    ]
    next_handle_change = None
    if profile.handle_changed_at:
        next_handle_change = profile.handle_changed_at + HANDLE_CHANGE_COOLDOWN
        if next_handle_change <= timezone.now():
            next_handle_change = None
    return {
        "handle": profile.handle,
        "url": f"/u/{profile.handle}",
        "draft": profile.draft or document.default_document(profile.handle),
        "draft_version": profile.draft_version,
        "draft_updated_at": profile.draft_updated_at.isoformat() if profile.draft_updated_at else None,
        "published_version": profile.published_version,
        "published_at": profile.published_at.isoformat() if profile.published_at else None,
        "is_published": profile.is_published,
        "has_unpublished_changes": profile.has_unpublished_changes,
        "status": profile.status,
        "hidden_reason": profile.hidden_reason if profile.status == StudentProfile.STATUS_HIDDEN else "",
        "settings": {
            "visibility": profile.visibility,
            "show_real_name": False,
            "allow_real_names": False,
            "show_on_leaderboards": leaderboard_visible(profile.user),
        },
        "next_handle_change_at": next_handle_change.isoformat() if next_handle_change else None,
        "handle_auto": bool(profile.handle_auto),
        "handle_prompt": handle_prompt_pending(profile),
        "images": images,
        "earned_badges": [catalogue[key] for key in sorted(earned or ()) if key in catalogue],
        "highlights": reward_highlights(profile.user_id),
        "limits": {
            **document.LIMITS,
            "bio": richtext.MAX_SOURCE_LENGTH,
            "avatar_images": MAX_AVATARS,
            "banner_images": MAX_BANNERS,
            "gallery_images": image_limit(ProfileImage.KIND_GALLERY, rules),
            "image_bytes": int(getattr(settings, "PROFILES_IMAGE_MAX_BYTES", 8 * 1024 * 1024) or 8 * 1024 * 1024),
        },
        "block_types": list(document.BLOCK_TYPES),
        "theme_choices": {key: list(values) for key, values in document.THEME_CHOICES.items()},
    }


# --- reports and moderation -------------------------------------------------------------------
def report_profile(profile: StudentProfile, *, reporter, reason: str, details: str = "", request=None) -> ProfileReport:
    if reporter is None or not reporter.is_authenticated:
        raise PermissionDenied("Sign in to report a profile.", code="not_authenticated")
    if reporter.pk == profile.user_id:
        raise ValidationFailed(details={"reason": ["You can't report your own profile."]})
    if reason not in dict(ProfileReport.REASON_CHOICES):
        raise ValidationFailed(details={"reason": ["Choose a reason."]})
    text = clean_text(details, field="details", max_length=500, multiline=True)
    try:
        with transaction.atomic():
            report = ProfileReport.objects.create(profile=profile, reporter=reporter, reason=reason, details=text)
    except IntegrityError:
        raise Conflict(
            "You already reported this profile. A moderator will look at it.", code="already_reported"
        ) from None
    audit(profile, ProfileAuditLog.ACTION_REPORTED, actor=reporter, request=request, reason=reason, report_id=report.pk)
    logger.info("profiles.reported profile=%s report=%s reason=%s", profile.pk, report.pk, reason)
    return report


def hide_profile(profile: StudentProfile, *, actor, reason: str, request=None) -> StudentProfile:
    if not is_staff(actor):
        raise PermissionDenied()
    note = clean_text(reason, field="reason", max_length=300, required=True)
    now = timezone.now()
    with transaction.atomic():
        locked = StudentProfile.objects.select_for_update().get(pk=profile.pk)
        locked.status = StudentProfile.STATUS_HIDDEN
        locked.hidden_reason = note
        locked.hidden_at = now
        locked.hidden_by = actor
        locked.save(update_fields=["status", "hidden_reason", "hidden_at", "hidden_by", "updated_at"])
        ProfileReport.objects.filter(profile=locked, status=ProfileReport.STATUS_OPEN).update(
            status=ProfileReport.STATUS_ACTIONED, resolved_at=now, resolved_by=actor, resolution_note=note[:300]
        )
        audit(locked, ProfileAuditLog.ACTION_HIDDEN, actor=actor, request=request, reason=note)
    return locked


def restore_profile(profile: StudentProfile, *, actor, note: str = "", request=None) -> StudentProfile:
    if not is_staff(actor):
        raise PermissionDenied()
    text = clean_text(note, field="note", max_length=300)
    with transaction.atomic():
        locked = StudentProfile.objects.select_for_update().get(pk=profile.pk)
        locked.status = StudentProfile.STATUS_ACTIVE
        locked.hidden_reason = ""
        locked.hidden_at = None
        locked.hidden_by = None
        locked.save(update_fields=["status", "hidden_reason", "hidden_at", "hidden_by", "updated_at"])
        audit(locked, ProfileAuditLog.ACTION_RESTORED, actor=actor, request=request, note=text)
    return locked


def dismiss_report(report: ProfileReport, *, actor, note: str = "", request=None) -> ProfileReport:
    if not is_staff(actor):
        raise PermissionDenied()
    if report.status != ProfileReport.STATUS_OPEN:
        return report
    report.status = ProfileReport.STATUS_DISMISSED
    report.resolved_at = timezone.now()
    report.resolved_by = actor
    report.resolution_note = clean_text(note, field="note", max_length=300)
    report.save(update_fields=["status", "resolved_at", "resolved_by", "resolution_note"])
    audit(report.profile, ProfileAuditLog.ACTION_REPORT_DISMISSED, actor=actor, request=request, report_id=report.pk)
    return report
