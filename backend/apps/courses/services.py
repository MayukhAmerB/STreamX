import json
import hashlib
import subprocess
import time
from os.path import basename
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings
from django.core.cache import cache
from django.core import signing
from django.urls import reverse

from config.url_utils import build_public_url, get_media_public_url


class S3VideoError(Exception):
    pass


class VideoTranscodeError(Exception):
    pass


class ProtectedMediaError(Exception):
    pass


PROTECTED_LECTURE_MEDIA_SIGNING_SALT = "courses.protected-lecture-media"
PROTECTED_LECTURE_MEDIA_CACHE_PREFIX = "courses:protected-media-token"
PROTECTED_GUIDE_MEDIA_SIGNING_SALT = "courses.protected-guide-media"
ADAPTIVE_HLS_PROFILES = [
    {
        "name": "360p",
        "width": 640,
        "height": 360,
        "video_bitrate": "800k",
        "maxrate": "856k",
        "bufsize": "1200k",
        "audio_bitrate": "96k",
    },
    {
        "name": "540p",
        "width": 960,
        "height": 540,
        "video_bitrate": "1600k",
        "maxrate": "1712k",
        "bufsize": "2400k",
        "audio_bitrate": "128k",
    },
    {
        "name": "720p",
        "width": 1280,
        "height": 720,
        "video_bitrate": "2800k",
        "maxrate": "2996k",
        "bufsize": "4200k",
        "audio_bitrate": "128k",
    },
]


def normalize_storage_key(storage_key):
    text = str(storage_key or "").strip().replace("\\", "/")
    if not text:
        raise ProtectedMediaError("Storage key is missing.")

    media_url = str(getattr(settings, "MEDIA_URL", "/media/") or "/media/")
    if media_url and text.startswith(media_url):
        text = text[len(media_url) :]

    text = text.lstrip("/")
    parts = []
    for part in PurePosixPath(text).parts:
        if part in {"", "."}:
            continue
        if part == "..":
            raise ProtectedMediaError("Invalid protected media path.")
        parts.append(part)

    if not parts:
        raise ProtectedMediaError("Protected media path is empty.")
    return "/".join(parts)


def resolve_local_media_storage_key(storage_key):
    text = str(storage_key or "").strip()
    if not text:
        return ""

    media_url = str(getattr(settings, "MEDIA_URL", "/media/") or "/media/")
    parsed_path = ""
    if text.startswith(("http://", "https://")):
        try:
            parsed_path = urlparse(text).path or ""
        except Exception:
            parsed_path = ""

    candidates = []

    def add_candidate(value):
        normalized_value = str(value or "").strip()
        if normalized_value and normalized_value not in candidates:
            candidates.append(normalized_value)

    add_candidate(text)
    add_candidate(parsed_path)
    if media_url:
        if text.startswith(media_url):
            add_candidate(text[len(media_url) :])
        if parsed_path.startswith(media_url):
            add_candidate(parsed_path[len(media_url) :])
        if media_url in text:
            add_candidate(text.split(media_url, 1)[1])
        if parsed_path and media_url in parsed_path:
            add_candidate(parsed_path.split(media_url, 1)[1])

    for candidate in candidates:
        try:
            normalized_key = normalize_storage_key(candidate)
        except ProtectedMediaError:
            continue
        local_path = Path(settings.MEDIA_ROOT) / normalized_key
        if local_path.exists() and local_path.is_file():
            return normalized_key

    return ""


def resolve_lecture_local_video_storage_key(lecture):
    if not lecture:
        return ""

    direct_storage_key = resolve_local_media_storage_key(getattr(lecture, "video_file", None) and lecture.video_file.name)
    if direct_storage_key:
        return direct_storage_key

    direct_storage_key = resolve_local_media_storage_key(getattr(lecture, "video_key", ""))
    if direct_storage_key:
        return direct_storage_key

    course_slug = getattr(getattr(getattr(lecture, "section", None), "course", None), "slug", "") or "course"
    section_id = getattr(lecture, "section_id", None) or "module"
    expected_dir = Path(settings.MEDIA_ROOT) / "lecture_videos" / course_slug / f"module_{section_id}"
    if not expected_dir.exists() or not expected_dir.is_dir():
        return ""

    expected_files = sorted(path for path in expected_dir.iterdir() if path.is_file())
    if not expected_files:
        return ""

    raw_video_key = str(getattr(lecture, "video_key", "") or "").strip()
    file_hint = basename(raw_video_key)
    if file_hint:
        matching_files = [path for path in expected_files if path.name == file_hint]
        if len(matching_files) == 1:
            return str(matching_files[0].relative_to(Path(settings.MEDIA_ROOT))).replace("\\", "/")

    if len(expected_files) == 1:
        return str(expected_files[0].relative_to(Path(settings.MEDIA_ROOT))).replace("\\", "/")

    return ""


def resolve_lecture_playback_expires_in(lecture):
    return max(1800, int(getattr(settings, "COURSE_PLAYBACK_URL_TTL_SECONDS", 21600)))


def resolve_guide_playback_expires_in(guide):
    configured = getattr(
        settings,
        "GUIDE_PLAYBACK_URL_TTL_SECONDS",
        getattr(settings, "COURSE_PLAYBACK_URL_TTL_SECONDS", 21600),
    )
    return max(1800, int(configured))


def resolve_guide_local_video_storage_key(guide):
    if not guide or not getattr(guide, "video_file", None):
        return ""
    return resolve_local_media_storage_key(guide.video_file.name)


def build_protected_lecture_playback_url(request, lecture, storage_key, *, expires_in, asset_type):
    normalized_path = normalize_storage_key(storage_key)
    asset_type = str(asset_type or "").strip().lower()
    if asset_type not in {"file", "hls"}:
        raise ProtectedMediaError("Unsupported protected media asset type.")

    if asset_type == "hls":
        root_prefix = PurePosixPath(normalized_path).parent.as_posix()
        if root_prefix in {"", "."}:
            raise ProtectedMediaError("Invalid HLS protected media root.")
    else:
        root_prefix = normalized_path

    request_user = getattr(request, "user", None)
    request_user_id = (
        int(getattr(request_user, "id", 0) or 0)
        if request_user and getattr(request_user, "is_authenticated", False)
        else 0
    )

    token = signing.dumps(
        {
            "lecture_id": int(lecture.id),
            "asset_type": asset_type,
            "root_prefix": root_prefix,
            "subject_uid": request_user_id,
        },
        salt=PROTECTED_LECTURE_MEDIA_SIGNING_SALT,
        compress=True,
    )
    playback_path = reverse(
        "lecture-playback-asset",
        kwargs={
            "pk": lecture.id,
            "token": token,
            "asset_path": normalized_path,
        },
    )
    return build_public_url(playback_path, request=request), expires_in


def build_protected_guide_playback_url(request, guide, storage_key, *, expires_in):
    normalized_path = normalize_storage_key(storage_key)
    request_user = getattr(request, "user", None)
    request_user_id = (
        int(getattr(request_user, "id", 0) or 0)
        if request_user and getattr(request_user, "is_authenticated", False)
        else 0
    )
    token = signing.dumps(
        {
            "guide_id": int(guide.id),
            "root_prefix": normalized_path,
            "subject_uid": request_user_id,
        },
        salt=PROTECTED_GUIDE_MEDIA_SIGNING_SALT,
        compress=True,
    )
    playback_path = reverse(
        "guide-playback-asset",
        kwargs={
            "pk": guide.id,
            "token": token,
            "asset_path": normalized_path,
        },
    )
    return build_public_url(playback_path, request=request), expires_in


def _protected_media_token_cache_key(token, lecture_id):
    token_hash = hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()
    return f"{PROTECTED_LECTURE_MEDIA_CACHE_PREFIX}:{int(lecture_id)}:{token_hash}"


def _protected_media_token_remaining_ttl(token, max_age):
    now = int(time.time())
    max_age = max(1, int(max_age or 1))
    try:
        timestamp_b62 = str(token).rsplit(":", 2)[1]
        issued_at = int(signing.b62_decode(timestamp_b62))
    except Exception:
        # Fail-safe fallback when token timestamp cannot be parsed.
        return min(max_age, 60)
    return max(1, max_age - max(0, now - issued_at))


def _load_cached_protected_media_token_payload(token, lecture_id):
    if not bool(getattr(settings, "COURSE_PROTECTED_MEDIA_TOKEN_CACHE_ENABLED", True)):
        return None

    cache_key = _protected_media_token_cache_key(token, lecture_id)
    now = int(time.time())
    try:
        cached_payload = cache.get(cache_key)
    except Exception:
        return None

    if not isinstance(cached_payload, dict):
        return None

    expires_at = int(cached_payload.get("expires_at") or 0)
    payload = cached_payload.get("payload")
    if not isinstance(payload, dict) or expires_at <= now:
        return None
    return payload


def _store_cached_protected_media_token_payload(token, lecture_id, payload, *, max_age):
    if not bool(getattr(settings, "COURSE_PROTECTED_MEDIA_TOKEN_CACHE_ENABLED", True)):
        return

    cache_ttl = _protected_media_token_remaining_ttl(token, max_age=max_age)
    if cache_ttl <= 0:
        return

    cache_key = _protected_media_token_cache_key(token, lecture_id)
    cache_entry = {
        "payload": payload,
        "expires_at": int(time.time()) + cache_ttl,
    }
    try:
        cache.set(cache_key, cache_entry, timeout=cache_ttl)
    except Exception:
        # Playback must remain available even if cache backend is degraded.
        return


def validate_protected_lecture_playback_request(token, lecture_id, asset_path, *, max_age, request=None):
    max_age = max(1, int(max_age or 1))
    requested_lecture_id = int(lecture_id)
    payload = _load_cached_protected_media_token_payload(token, requested_lecture_id)

    if payload is None:
        try:
            signed_payload = signing.loads(
                token,
                max_age=max_age,
                salt=PROTECTED_LECTURE_MEDIA_SIGNING_SALT,
            )
        except signing.BadSignature as exc:
            raise ProtectedMediaError("Invalid or expired protected media token.") from exc

        payload_lecture_id = int(signed_payload.get("lecture_id", 0) or 0)
        if payload_lecture_id != requested_lecture_id:
            raise ProtectedMediaError("Protected media token does not match the lecture.")

        asset_type = str(signed_payload.get("asset_type", "")).strip().lower()
        if asset_type not in {"hls", "file"}:
            raise ProtectedMediaError("Unsupported protected media asset type.")

        root_prefix = normalize_storage_key(signed_payload.get("root_prefix"))
        subject_uid = int(signed_payload.get("subject_uid", 0) or 0)
        payload = {
            "lecture_id": payload_lecture_id,
            "asset_type": asset_type,
            "root_prefix": root_prefix,
            "subject_uid": subject_uid,
        }
        _store_cached_protected_media_token_payload(
            token,
            requested_lecture_id,
            payload,
            max_age=max_age,
        )

    normalized_path = normalize_storage_key(asset_path)
    asset_type = str(payload.get("asset_type", "")).strip().lower()
    root_prefix = normalize_storage_key(payload.get("root_prefix"))
    subject_uid = int(payload.get("subject_uid", 0) or 0)

    if subject_uid > 0:
        request_user = getattr(request, "user", None)
        request_user_id = (
            int(getattr(request_user, "id", 0) or 0)
            if request_user and getattr(request_user, "is_authenticated", False)
            else 0
        )
        if request_user_id != subject_uid:
            raise ProtectedMediaError("Protected media token user mismatch.")

    if asset_type == "hls":
        if normalized_path != root_prefix and not normalized_path.startswith(f"{root_prefix}/"):
            raise ProtectedMediaError("Protected media path is outside the HLS asset root.")
    elif asset_type == "file":
        if normalized_path != root_prefix:
            raise ProtectedMediaError("Protected media token does not allow this file.")
    else:
        raise ProtectedMediaError("Unsupported protected media asset type.")

    return normalized_path


def validate_protected_guide_playback_request(token, guide_id, asset_path, *, max_age, request=None):
    max_age = max(1, int(max_age or 1))
    requested_guide_id = int(guide_id)
    try:
        payload = signing.loads(
            token,
            max_age=max_age,
            salt=PROTECTED_GUIDE_MEDIA_SIGNING_SALT,
        )
    except signing.BadSignature as exc:
        raise ProtectedMediaError("Invalid or expired protected media token.") from exc

    payload_guide_id = int(payload.get("guide_id", 0) or 0)
    if payload_guide_id != requested_guide_id:
        raise ProtectedMediaError("Protected media token does not match the guide.")

    normalized_path = normalize_storage_key(asset_path)
    root_prefix = normalize_storage_key(payload.get("root_prefix"))
    subject_uid = int(payload.get("subject_uid", 0) or 0)

    if subject_uid > 0:
        request_user = getattr(request, "user", None)
        request_user_id = (
            int(getattr(request_user, "id", 0) or 0)
            if request_user and getattr(request_user, "is_authenticated", False)
            else 0
        )
        if request_user_id != subject_uid:
            raise ProtectedMediaError("Protected media token user mismatch.")

    if normalized_path != root_prefix:
        raise ProtectedMediaError("Protected media token does not allow this file.")

    return normalized_path


def generate_signed_video_url(video_key, expires_in=300):
    if not all(
        [
            settings.AWS_ACCESS_KEY_ID,
            settings.AWS_SECRET_ACCESS_KEY,
            settings.AWS_STORAGE_BUCKET_NAME,
            settings.AWS_S3_REGION_NAME,
        ]
    ):
        raise S3VideoError("AWS S3 credentials or bucket configuration is missing.")

    client = boto3.client(
        "s3",
        region_name=settings.AWS_S3_REGION_NAME,
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
    )
    try:
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.AWS_STORAGE_BUCKET_NAME, "Key": video_key},
            ExpiresIn=expires_in,
        )
    except (BotoCoreError, ClientError) as exc:
        raise S3VideoError("Failed to generate signed video URL.") from exc


def generate_playback_url(request, storage_key, expires_in=300, signer=None):
    if not storage_key:
        raise S3VideoError("Video key is missing.")

    if str(storage_key).startswith(("http://", "https://")):
        return str(storage_key), None

    local_storage_key = resolve_local_media_storage_key(storage_key)
    if local_storage_key:
        media_url = f"{settings.MEDIA_URL.rstrip('/')}/{local_storage_key.lstrip('/')}"
        return get_media_public_url(media_url, request=request), None

    signer = signer or generate_signed_video_url
    return signer(storage_key, expires_in=expires_in), expires_in


def _probe_media_metadata(source_path):
    ffprobe_binary = getattr(settings, "FFPROBE_BINARY", "ffprobe")
    cmd = [
        ffprobe_binary,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_entries",
        "stream=index,codec_type,width,height:format=duration",
        str(source_path),
    ]
    result = subprocess.run(
        cmd,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise VideoTranscodeError("FFprobe metadata inspection failed.")

    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise VideoTranscodeError("FFprobe returned invalid metadata output.") from exc

    streams = payload.get("streams") or []
    video_stream = next((row for row in streams if row.get("codec_type") == "video"), {})
    audio_stream = next((row for row in streams if row.get("codec_type") == "audio"), None)
    try:
        width = int(video_stream.get("width") or 0)
        height = int(video_stream.get("height") or 0)
    except (TypeError, ValueError):
        width = 0
        height = 0

    duration_seconds = None
    try:
        raw_duration = float((payload.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        raw_duration = 0
    if raw_duration > 0:
        duration_seconds = int(round(raw_duration))

    return {
        "width": width,
        "height": height,
        "duration_seconds": duration_seconds,
        "has_audio": bool(audio_stream),
    }


def _select_hls_profiles(source_width, source_height):
    selected = [
        profile.copy()
        for profile in ADAPTIVE_HLS_PROFILES
        if source_height <= 0 or profile["height"] <= source_height
    ]
    if not selected:
        fallback = ADAPTIVE_HLS_PROFILES[0].copy()
        if source_width > 0:
            fallback["width"] = min(fallback["width"], source_width)
        if source_height > 0:
            fallback["height"] = min(fallback["height"], source_height)
        fallback["name"] = "source"
        selected = [fallback]
    return selected


def _bandwidth_value(video_bitrate, audio_bitrate):
    def _parse(value):
        text = str(value or "").strip().lower()
        if text.endswith("k"):
            return int(float(text[:-1]) * 1000)
        if text.endswith("m"):
            return int(float(text[:-1]) * 1000000)
        return int(float(text or 0))

    return _parse(video_bitrate) + _parse(audio_bitrate)


def _write_master_playlist(output_abs_dir, profiles):
    lines = ["#EXTM3U", "#EXT-X-VERSION:3"]
    for profile in profiles:
        bandwidth = _bandwidth_value(profile["video_bitrate"], profile["audio_bitrate"])
        lines.append(
            (
                "#EXT-X-STREAM-INF:"
                f"BANDWIDTH={bandwidth},"
                f"AVERAGE-BANDWIDTH={bandwidth},"
                f"RESOLUTION={profile['width']}x{profile['height']}"
            )
        )
        lines.append(f"{profile['name']}/index.m3u8")
    (output_abs_dir / "master.m3u8").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _build_profile_transcode_command(
    *,
    ffmpeg_binary,
    source_path,
    profile,
    profile_dir,
    has_audio,
):
    scale_filter = (
        f"scale={profile['width']}:{profile['height']}:"
        "force_original_aspect_ratio=decrease:force_divisible_by=2,"
        f"pad={profile['width']}:{profile['height']}:(ow-iw)/2:(oh-ih)/2:color=black"
    )
    cmd = [
        ffmpeg_binary,
        "-y",
        "-i",
        str(source_path),
        "-vf",
        scale_filter,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-profile:v",
        "main",
        "-crf",
        "21",
        "-sc_threshold",
        "0",
        "-g",
        "48",
        "-keyint_min",
        "48",
        "-b:v",
        profile["video_bitrate"],
        "-maxrate",
        profile["maxrate"],
        "-bufsize",
        profile["bufsize"],
        "-hls_time",
        "6",
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
        str(profile_dir / "segment_%03d.ts"),
    ]
    if has_audio:
        cmd += [
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-b:a",
            profile["audio_bitrate"],
        ]
    else:
        cmd.append("-an")
    cmd.append(str(profile_dir / "index.m3u8"))
    return cmd


def transcode_lecture_to_hls(lecture):
    """
    Phase 2 local transcoding path.
    Converts an uploaded lecture video file into an HLS playlist under MEDIA_ROOT/streams/.
    """
    if not getattr(lecture, "video_file", None):
        raise VideoTranscodeError("Lecture has no uploaded video file.")

    source_path = Path(lecture.video_file.path)
    if not source_path.exists():
        raise VideoTranscodeError("Uploaded video file does not exist on disk.")

    ffmpeg_binary = getattr(settings, "FFMPEG_BINARY", "ffmpeg")
    course_slug = getattr(getattr(lecture.section, "course", None), "slug", "course") or "course"
    output_rel_dir = Path("streams") / course_slug / f"lecture_{lecture.pk}"
    output_abs_dir = Path(settings.MEDIA_ROOT) / output_rel_dir
    output_abs_dir.mkdir(parents=True, exist_ok=True)

    # Clean old HLS artifacts for this lecture before re-transcoding.
    for artifact in output_abs_dir.iterdir():
        if artifact.is_file() and artifact.suffix.lower() in {".m3u8", ".ts", ".m4s", ".mp4"}:
            artifact.unlink(missing_ok=True)

    lecture.stream_status = getattr(lecture, "STREAM_PROCESSING", "processing")
    lecture.stream_error = ""
    lecture.save(update_fields=["stream_status", "stream_error", "updated_at"])

    try:
        metadata = _probe_media_metadata(source_path)
    except FileNotFoundError as exc:
        lecture.stream_status = getattr(lecture, "STREAM_FAILED", "failed")
        lecture.stream_error = "FFmpeg/FFprobe is not installed or not found in PATH."
        lecture.save(update_fields=["stream_status", "stream_error", "updated_at"])
        raise VideoTranscodeError("FFmpeg/FFprobe is not installed or not found in PATH.") from exc
    except VideoTranscodeError as exc:
        lecture.stream_status = getattr(lecture, "STREAM_FAILED", "failed")
        lecture.stream_error = str(exc)[:4000]
        lecture.save(update_fields=["stream_status", "stream_error", "updated_at"])
        raise

    profiles = _select_hls_profiles(metadata["width"], metadata["height"])

    try:
        for profile in profiles:
            profile_dir = output_abs_dir / profile["name"]
            profile_dir.mkdir(parents=True, exist_ok=True)
            for artifact in profile_dir.iterdir():
                if artifact.is_file() and artifact.suffix.lower() in {".m3u8", ".ts", ".m4s", ".mp4"}:
                    artifact.unlink(missing_ok=True)
            cmd = _build_profile_transcode_command(
                ffmpeg_binary=ffmpeg_binary,
                source_path=source_path,
                profile=profile,
                profile_dir=profile_dir,
                has_audio=metadata["has_audio"],
            )
            result = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0 or not (profile_dir / "index.m3u8").exists():
                error_text = (result.stderr or result.stdout or "FFmpeg transcoding failed.").strip()
                raise VideoTranscodeError(error_text[:4000] or "FFmpeg transcoding failed.")
        _write_master_playlist(output_abs_dir, profiles)
    except FileNotFoundError as exc:
        lecture.stream_status = getattr(lecture, "STREAM_FAILED", "failed")
        lecture.stream_error = "FFmpeg is not installed or not found in PATH."
        lecture.save(update_fields=["stream_status", "stream_error", "updated_at"])
        raise VideoTranscodeError("FFmpeg is not installed or not found in PATH.") from exc
    except VideoTranscodeError as exc:
        lecture.stream_status = getattr(lecture, "STREAM_FAILED", "failed")
        lecture.stream_error = str(exc)[:4000]
        lecture.save(update_fields=["stream_status", "stream_error", "updated_at"])
        raise

    lecture.stream_manifest_key = str((output_rel_dir / "master.m3u8").as_posix())
    lecture.stream_duration_seconds = metadata["duration_seconds"]
    lecture.stream_status = getattr(lecture, "STREAM_READY", "ready")
    lecture.stream_error = ""
    lecture.save(
        update_fields=[
            "stream_manifest_key",
            "stream_duration_seconds",
            "stream_status",
            "stream_error",
            "updated_at",
        ]
    )
    return lecture
