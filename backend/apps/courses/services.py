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
        "video_bitrate": "1000k",
        "maxrate": "1070k",
        "bufsize": "1500k",
        "audio_bitrate": "96k",
    },
    {
        "name": "540p",
        "width": 960,
        "height": 540,
        "video_bitrate": "2200k",
        "maxrate": "2354k",
        "bufsize": "3300k",
        "audio_bitrate": "128k",
    },
    {
        "name": "720p",
        "width": 1280,
        "height": 720,
        "video_bitrate": "4200k",
        "maxrate": "4494k",
        "bufsize": "6300k",
        "audio_bitrate": "160k",
    },
    {
        "name": "1080p",
        "width": 1920,
        "height": 1080,
        "video_bitrate": "6800k",
        "maxrate": "7276k",
        "bufsize": "10200k",
        "audio_bitrate": "192k",
    },
]


def resolve_hls_segment_duration_seconds():
    return max(2, int(getattr(settings, "COURSE_HLS_SEGMENT_DURATION_SECONDS", 4) or 4))


def resolve_hls_keyframe_interval_seconds():
    segment_duration_seconds = resolve_hls_segment_duration_seconds()
    configured = int(
        getattr(settings, "COURSE_HLS_KEYFRAME_INTERVAL_SECONDS", segment_duration_seconds)
        or segment_duration_seconds
    )
    return max(1, configured)


def resolve_hls_crf_value():
    return max(16, min(30, int(getattr(settings, "COURSE_HLS_CRF", 18) or 18)))


def resolve_hls_x264_preset():
    preset = str(getattr(settings, "COURSE_HLS_X264_PRESET", "slow") or "slow").strip().lower()
    if preset in {"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"}:
        return preset
    return "medium"


def _parse_frame_rate(raw_value):
    text = str(raw_value or "").strip()
    if not text or text == "0/0":
        return 30.0

    if "/" in text:
        numerator, denominator = text.split("/", 1)
        try:
            numerator_value = float(numerator)
            denominator_value = float(denominator)
        except (TypeError, ValueError):
            return 30.0
        if denominator_value <= 0:
            return 30.0
        frame_rate = numerator_value / denominator_value
    else:
        try:
            frame_rate = float(text)
        except (TypeError, ValueError):
            return 30.0

    if frame_rate <= 0:
        return 30.0
    return min(frame_rate, 120.0)


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
    subject_uid = request_user_id if asset_type == "file" else 0

    token = signing.dumps(
        {
            "lecture_id": int(lecture.id),
            "asset_type": asset_type,
            "root_prefix": root_prefix,
            "subject_uid": subject_uid,
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


PROBE_TIMEOUT_SECONDS = 120


def _probe_media_metadata(source_path, *, runner=None):
    ffprobe_binary = getattr(settings, "FFPROBE_BINARY", "ffprobe")
    cmd = [
        ffprobe_binary,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_entries",
        "stream=index,codec_type,codec_name,width,height,avg_frame_rate:format=duration",
        str(source_path),
    ]
    run = runner or subprocess.run
    try:
        result = run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise VideoTranscodeError(f"FFprobe timed out after {PROBE_TIMEOUT_SECONDS}s.") from exc
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

    frame_rate = _parse_frame_rate(video_stream.get("avg_frame_rate"))

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
        "frame_rate": frame_rate,
        "duration_seconds": duration_seconds,
        "has_audio": bool(audio_stream),
        "video_codec": str(video_stream.get("codec_name") or "").strip().lower(),
    }


def _select_hls_profiles(source_width, source_height):
    selected = [
        profile.copy()
        for profile in ADAPTIVE_HLS_PROFILES
        if (
            (source_width <= 0 or profile["width"] <= source_width)
            and (source_height <= 0 or profile["height"] <= source_height)
        )
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
    frame_rate,
    has_audio,
):
    segment_duration_seconds = resolve_hls_segment_duration_seconds()
    keyframe_interval_seconds = resolve_hls_keyframe_interval_seconds()
    keyframe_frame_count = max(1, int(round(max(frame_rate, 1.0) * keyframe_interval_seconds)))
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
        resolve_hls_x264_preset(),
        "-profile:v",
        "main",
        "-crf",
        str(resolve_hls_crf_value()),
        "-sc_threshold",
        "0",
        "-force_key_frames",
        f"expr:gte(t,n_forced*{keyframe_interval_seconds})",
        "-g",
        str(keyframe_frame_count),
        "-keyint_min",
        str(keyframe_frame_count),
        "-b:v",
        profile["video_bitrate"],
        "-maxrate",
        profile["maxrate"],
        "-bufsize",
        profile["bufsize"],
        "-hls_time",
        str(segment_duration_seconds),
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


# --------------------------------------------------------------------------
# Phase 2 transcode: one ffmpeg pass for every rendition, a hard timeout, and
# blue/green output directories (streams/<course>/lecture_<id>/v<revision>/).
# --------------------------------------------------------------------------

X264_PRESETS = frozenset({"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"})


class TranscodeSuperseded(VideoTranscodeError):
    """The lecture's video changed while it was being transcoded (output discarded)."""


def resolve_hls_single_pass_enabled():
    return bool(getattr(settings, "COURSE_HLS_SINGLE_PASS", True))


def resolve_hls_single_pass_preset():
    preset = str(getattr(settings, "COURSE_HLS_SINGLE_PASS_PRESET", "veryfast") or "veryfast").strip().lower()
    return preset if preset in X264_PRESETS else "veryfast"


def resolve_hls_single_pass_crf():
    return max(16, min(30, int(getattr(settings, "COURSE_HLS_SINGLE_PASS_CRF", 23) or 23)))


def resolve_transcode_timeout_seconds(duration_seconds):
    """Hard ffmpeg timeout: base + factor x media duration, capped."""
    base = max(60, int(getattr(settings, "COURSE_HLS_TRANSCODE_TIMEOUT_BASE_SECONDS", 600) or 600))
    try:
        factor = float(getattr(settings, "COURSE_HLS_TRANSCODE_TIMEOUT_FACTOR", 3) or 3)
    except (TypeError, ValueError):
        factor = 3.0
    cap = max(600, int(getattr(settings, "COURSE_HLS_TRANSCODE_MAX_TIMEOUT_SECONDS", 6 * 3600) or 6 * 3600))
    duration = max(0, int(duration_seconds or 0))
    if not duration:
        return cap
    return int(min(cap, base + factor * duration))


def _scale_pad_filter(profile):
    return (
        f"scale={profile['width']}:{profile['height']}:"
        "force_original_aspect_ratio=decrease:force_divisible_by=2,"
        f"pad={profile['width']}:{profile['height']}:(ow-iw)/2:(oh-ih)/2:color=black"
    )


def can_copy_top_rendition(metadata, profiles):
    """The source is H.264 at exactly the top rendition's size (Owncast captures usually are)."""
    if not bool(getattr(settings, "COURSE_HLS_TOP_RUNG_COPY", False)) or not profiles:
        return False
    top = profiles[-1]
    return (
        metadata.get("video_codec") == "h264"
        and int(metadata.get("width") or 0) == int(top["width"])
        and int(metadata.get("height") or 0) == int(top["height"])
    )


def build_single_pass_transcode_command(
    *,
    ffmpeg_binary,
    source_path,
    profiles,
    output_dir,
    frame_rate,
    has_audio,
    copy_top=False,
    preset=None,
    crf=None,
):
    """One ffmpeg process: decode once, ``split`` + scale per rendition, HLS out.

    Every option is per output stream (``:v:N`` / ``:a:N``) so a stream-copied
    top rendition never receives encoder options. The variant playlists land
    in ``<output_dir>/<name>/index.m3u8``; the master playlist is written by
    ``_write_master_playlist`` afterwards (same format as before). Capped CRF
    (``-crf`` with ``-maxrate``/``-bufsize``) suits slide/screen content.
    """
    preset = preset or resolve_hls_single_pass_preset()
    crf = crf if crf is not None else resolve_hls_single_pass_crf()
    segment_duration_seconds = resolve_hls_segment_duration_seconds()
    keyframe_interval_seconds = resolve_hls_keyframe_interval_seconds()
    keyframe_frame_count = max(1, int(round(max(frame_rate, 1.0) * keyframe_interval_seconds)))
    count = len(profiles)
    top_index = count - 1
    encoded = [index for index in range(count) if not (copy_top and index == top_index)]

    graph = []
    if encoded:
        if len(encoded) == 1:
            index = encoded[0]
            graph.append(f"[0:v]{_scale_pad_filter(profiles[index])}[v{index}]")
        else:
            labels = "".join(f"[s{index}]" for index in encoded)
            graph.append(f"[0:v]split={len(encoded)}{labels}")
            for index in encoded:
                graph.append(f"[s{index}]{_scale_pad_filter(profiles[index])}[v{index}]")

    cmd = [str(ffmpeg_binary), "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(source_path)]
    if graph:
        cmd += ["-filter_complex", ";".join(graph)]
    for index in range(count):
        cmd += ["-map", f"[v{index}]" if index in encoded else "0:v:0"]
        if has_audio:
            cmd += ["-map", "0:a:0"]
    for index, profile in enumerate(profiles):
        stream = f"v:{index}"
        if index not in encoded:
            cmd += [f"-c:{stream}", "copy"]
            continue
        cmd += [
            f"-c:{stream}", "libx264",
            f"-preset:{stream}", preset,
            f"-profile:{stream}", "main",
            f"-crf:{stream}", str(crf),
            f"-maxrate:{stream}", profile["maxrate"],
            f"-bufsize:{stream}", profile["bufsize"],
            f"-sc_threshold:{stream}", "0",
            f"-g:{stream}", str(keyframe_frame_count),
            f"-keyint_min:{stream}", str(keyframe_frame_count),
            f"-force_key_frames:{stream}", f"expr:gte(t,n_forced*{keyframe_interval_seconds})",
        ]
    if has_audio:
        cmd += ["-c:a", "aac", "-ar", "48000"]
        for index, profile in enumerate(profiles):
            cmd += [f"-b:a:{index}", profile["audio_bitrate"]]
    stream_map = " ".join(
        f"v:{index},a:{index},name:{profile['name']}" if has_audio else f"v:{index},name:{profile['name']}"
        for index, profile in enumerate(profiles)
    )
    output_dir = Path(output_dir)
    cmd += [
        "-f", "hls",
        "-hls_time", str(segment_duration_seconds),
        "-hls_playlist_type", "vod",
        "-hls_flags", "independent_segments",
        "-hls_segment_filename", str(output_dir / "%v" / "segment_%03d.ts"),
        "-var_stream_map", stream_map,
        str(output_dir / "%v" / "index.m3u8"),
    ]
    return cmd


def lecture_stream_root(lecture):
    course_slug = getattr(getattr(lecture.section, "course", None), "slug", "course") or "course"
    return Path("streams") / course_slug / f"lecture_{lecture.pk}"


def _next_revision_dir(lecture, stream_root):
    """A revision directory that is never the one students are watching."""
    revision = int(getattr(lecture, "stream_revision", 0) or 0) + 1
    current = str(lecture.stream_manifest_key or "")
    while current.startswith((stream_root / f"v{revision}").as_posix() + "/"):
        revision += 1
    return revision, stream_root / f"v{revision}"


def _run_ffmpeg(runner, cmd, *, timeout):
    try:
        return runner(cmd, check=False, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise VideoTranscodeError(f"FFmpeg timed out after {int(timeout)}s and was stopped.") from exc


def _transcode_failed(lecture, message):
    from .transcode_queue import mark_transcode_failed  # transcode_queue imports this module

    mark_transcode_failed(lecture, message)


def transcode_lecture_to_hls(lecture, *, runner=None):
    """Build the lecture's adaptive HLS stream and swap it in (blue/green).

    The renditions are written to a fresh ``v<revision>`` directory while
    students keep watching the current stream (or the MP4); the lecture is
    switched over with one conditional UPDATE once every playlist exists, and
    only if its video file is still the one that was transcoded. Old revisions
    are deleted later (COURSE_HLS_REVISION_GRACE_SECONDS), never while a viewer
    may still be fetching their segments. ``runner`` replaces subprocess.run
    (tests use a fake ffmpeg).

    Raises VideoTranscodeError (the failure and its retry schedule are
    recorded on the lecture) or TranscodeSuperseded (the video changed).
    """
    import shutil

    from django.utils import timezone

    run = runner or subprocess.run
    if not getattr(lecture, "video_file", None):
        raise VideoTranscodeError("Lecture has no uploaded video file.")
    source_name = str(lecture.video_file.name or "")
    source_path = Path(lecture.video_file.path)
    if not source_path.exists():
        _transcode_failed(lecture, "Uploaded video file does not exist on disk.")
        raise VideoTranscodeError("Uploaded video file does not exist on disk.")

    ffmpeg_binary = getattr(settings, "FFMPEG_BINARY", "ffmpeg")
    stream_root = lecture_stream_root(lecture)
    revision, output_rel_dir = _next_revision_dir(lecture, stream_root)
    output_abs_dir = Path(settings.MEDIA_ROOT) / output_rel_dir
    if output_abs_dir.exists():
        shutil.rmtree(output_abs_dir, ignore_errors=True)  # leftover of a crashed attempt
    output_abs_dir.mkdir(parents=True, exist_ok=True)

    # A ready lecture keeps serving its current stream during a forced rebuild.
    type(lecture).objects.filter(pk=lecture.pk).exclude(stream_status=lecture.STREAM_READY).update(
        stream_status=lecture.STREAM_PROCESSING, stream_error=""
    )

    try:
        try:
            metadata = _probe_media_metadata(source_path, runner=run)
        except FileNotFoundError as exc:
            raise VideoTranscodeError("FFmpeg/FFprobe is not installed or not found in PATH.") from exc
        profiles = _select_hls_profiles(metadata["width"], metadata["height"])
        timeout = resolve_transcode_timeout_seconds(metadata["duration_seconds"])
        for profile in profiles:
            (output_abs_dir / profile["name"]).mkdir(parents=True, exist_ok=True)
        try:
            if resolve_hls_single_pass_enabled():
                cmd = build_single_pass_transcode_command(
                    ffmpeg_binary=ffmpeg_binary,
                    source_path=source_path,
                    profiles=profiles,
                    output_dir=output_abs_dir,
                    frame_rate=metadata["frame_rate"],
                    has_audio=metadata["has_audio"],
                    copy_top=can_copy_top_rendition(metadata, profiles),
                )
                result = _run_ffmpeg(run, cmd, timeout=timeout)
                if result.returncode != 0:
                    error_text = (result.stderr or result.stdout or "FFmpeg transcoding failed.").strip()
                    raise VideoTranscodeError(error_text[-4000:] or "FFmpeg transcoding failed.")
            else:
                started = time.monotonic()
                for profile in profiles:
                    profile_dir = output_abs_dir / profile["name"]
                    cmd = _build_profile_transcode_command(
                        ffmpeg_binary=ffmpeg_binary,
                        source_path=source_path,
                        profile=profile,
                        profile_dir=profile_dir,
                        frame_rate=metadata["frame_rate"],
                        has_audio=metadata["has_audio"],
                    )
                    remaining = max(1, timeout - (time.monotonic() - started))
                    result = _run_ffmpeg(run, cmd, timeout=remaining)
                    if result.returncode != 0 or not (profile_dir / "index.m3u8").exists():
                        error_text = (result.stderr or result.stdout or "FFmpeg transcoding failed.").strip()
                        raise VideoTranscodeError(error_text[-4000:] or "FFmpeg transcoding failed.")
        except FileNotFoundError as exc:
            raise VideoTranscodeError("FFmpeg is not installed or not found in PATH.") from exc
        missing = [
            profile["name"]
            for profile in profiles
            if not (output_abs_dir / profile["name"] / "index.m3u8").is_file()
            or (output_abs_dir / profile["name"] / "index.m3u8").stat().st_size == 0
        ]
        if missing:
            raise VideoTranscodeError(f"FFmpeg did not write the playlist of: {', '.join(missing)}.")
        _write_master_playlist(output_abs_dir, profiles)
    except VideoTranscodeError as exc:
        shutil.rmtree(output_abs_dir, ignore_errors=True)
        _transcode_failed(lecture, str(exc))
        raise

    manifest_key = (output_rel_dir / "master.m3u8").as_posix()
    swapped = type(lecture).objects.filter(pk=lecture.pk, video_file=source_name).update(
        stream_manifest_key=manifest_key,
        stream_duration_seconds=metadata["duration_seconds"],
        stream_status=lecture.STREAM_READY,
        stream_error="",
        stream_revision=revision,
        stream_attempts=0,
        stream_next_attempt_at=None,
        stream_claimed_at=None,
        stream_claimed_by="",
        updated_at=timezone.now(),
    )
    if not swapped:
        shutil.rmtree(output_abs_dir, ignore_errors=True)
        raise TranscodeSuperseded("The lecture video changed during the transcode; the new video is queued.")
    lecture.stream_manifest_key = manifest_key
    lecture.stream_duration_seconds = metadata["duration_seconds"]
    lecture.stream_status = lecture.STREAM_READY
    lecture.stream_error = ""
    lecture.stream_revision = revision
    lecture.stream_attempts = 0
    lecture.stream_next_attempt_at = None
    try:
        from .transcode_queue import gc_lecture_stream_revisions

        gc_lecture_stream_revisions(lecture)
    except Exception:  # cleanup only; never fail a finished transcode
        pass
    return lecture
