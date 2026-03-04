from django.conf import settings
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token


class GoogleAuthError(Exception):
    pass


def verify_google_credential(credential):
    if not settings.GOOGLE_CLIENT_ID:
        raise GoogleAuthError("GOOGLE_CLIENT_ID is not configured.")
    try:
        info = id_token.verify_oauth2_token(
            credential,
            google_requests.Request(),
            settings.GOOGLE_CLIENT_ID,
        )
    except Exception as exc:
        raise GoogleAuthError("Invalid Google credential.") from exc
    if info.get("iss") not in ["accounts.google.com", "https://accounts.google.com"]:
        raise GoogleAuthError("Invalid Google issuer.")
    return info
