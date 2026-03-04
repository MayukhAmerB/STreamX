import subprocess
from pathlib import Path

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from django.conf import settings

from config.url_utils import get_media_public_url


class S3VideoError(Exception):
    pass


class VideoTranscodeError(Exception):
    pass


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

    local_path = Path(settings.MEDIA_ROOT) / str(storage_key)
    if local_path.exists():
        media_url = f"{settings.MEDIA_URL.rstrip('/')}/{str(storage_key).lstrip('/')}"
        return get_media_public_url(media_url, request=request), None

    signer = signer or generate_signed_video_url
    return signer(storage_key, expires_in=expires_in), expires_in


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

    playlist_name = "master.m3u8"
    playlist_abs_path = output_abs_dir / playlist_name
    segment_pattern = str(output_abs_dir / "segment_%03d.ts")

    lecture.stream_status = getattr(lecture, "STREAM_PROCESSING", "processing")
    lecture.stream_error = ""
    lecture.save(update_fields=["stream_status", "stream_error", "updated_at"])

    cmd = [
        ffmpeg_binary,
        "-y",
        "-i",
        str(source_path),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-hls_time",
        "6",
        "-hls_playlist_type",
        "vod",
        "-hls_segment_filename",
        segment_pattern,
        str(playlist_abs_path),
    ]

    try:
        result = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        lecture.stream_status = getattr(lecture, "STREAM_FAILED", "failed")
        lecture.stream_error = "FFmpeg is not installed or not found in PATH."
        lecture.save(update_fields=["stream_status", "stream_error", "updated_at"])
        raise VideoTranscodeError("FFmpeg is not installed or not found in PATH.") from exc

    if result.returncode != 0 or not playlist_abs_path.exists():
        error_text = (result.stderr or result.stdout or "FFmpeg transcoding failed.").strip()
        lecture.stream_status = getattr(lecture, "STREAM_FAILED", "failed")
        lecture.stream_error = error_text[:4000]
        lecture.save(update_fields=["stream_status", "stream_error", "updated_at"])
        raise VideoTranscodeError("FFmpeg transcoding failed.")

    lecture.stream_manifest_key = str((output_rel_dir / playlist_name).as_posix())
    lecture.stream_status = getattr(lecture, "STREAM_READY", "ready")
    lecture.stream_error = ""
    lecture.save(update_fields=["stream_manifest_key", "stream_status", "stream_error", "updated_at"])
    return lecture
