from django.conf import settings


def is_absolute_http_url(value):
    text = str(value or "").strip().lower()
    return text.startswith(("http://", "https://"))


def _normalize_media_path(path_or_url):
    text = str(path_or_url or "").strip()
    if not text:
        return ""
    if is_absolute_http_url(text):
        return text
    if not text.startswith("/"):
        text = f"/{text}"
    if text == "/media":
        return "/media/"
    if text.startswith("/media/"):
        return text
    return f"/media{text}"


def build_public_url(path_or_url, request=None, base_url=""):
    text = str(path_or_url or "").strip()
    if not text:
        return ""
    if is_absolute_http_url(text):
        return text

    if not text.startswith("/"):
        text = f"/{text}"

    resolved_base_url = str(base_url or "").strip().rstrip("/")
    if resolved_base_url:
        return f"{resolved_base_url}{text}"

    if request:
        return request.build_absolute_uri(text)
    return text


def get_media_public_url(path_or_url, request=None):
    normalized_media_path = _normalize_media_path(path_or_url)
    if not normalized_media_path:
        return ""
    if is_absolute_http_url(normalized_media_path):
        return normalized_media_path

    media_base = str(getattr(settings, "MEDIA_PUBLIC_BASE_URL", "") or "").strip().rstrip("/")
    if media_base:
        # Support both forms:
        # 1) MEDIA_PUBLIC_BASE_URL=https://alsyedinitiative.com
        # 2) MEDIA_PUBLIC_BASE_URL=https://alsyedinitiative.com/media
        if media_base.lower().endswith("/media"):
            suffix = (
                normalized_media_path[len("/media") :]
                if normalized_media_path.startswith("/media")
                else normalized_media_path
            )
            return f"{media_base}{suffix}"
        return f"{media_base}{normalized_media_path}"

    return build_public_url(path_or_url=normalized_media_path, request=request, base_url="")
