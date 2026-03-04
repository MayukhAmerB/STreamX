from django.conf import settings


def is_absolute_http_url(value):
    text = str(value or "").strip().lower()
    return text.startswith(("http://", "https://"))


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
    return build_public_url(
        path_or_url=path_or_url,
        request=request,
        base_url=getattr(settings, "MEDIA_PUBLIC_BASE_URL", ""),
    )
