"""WhatsApp Business Cloud API (Meta) provider: template messages with a PDF document.

Configured only by environment variables (see ``config.settings.base``):

* ``WHATSAPP_CLOUD_API_TOKEN``: a permanent System User access token with
  ``whatsapp_business_messaging``.
* ``WHATSAPP_PHONE_NUMBER_ID``: the sending number's id (not the number).
* ``WHATSAPP_TEMPLATE_CERTIFICATE``: an APPROVED template with a DOCUMENT
  header and four body variables: {{1}} name, {{2}} certificate title,
  {{3}} reference number, {{4}} verification URL.
* ``WHATSAPP_TEMPLATE_LETTER`` (optional): an APPROVED template with a
  DOCUMENT header and one body variable {{1}} name, used for the
  congratulations letter. Without it only the certificate goes by WhatsApp
  (the letter still goes by e-mail).
* ``WHATSAPP_TEMPLATE_LANGUAGE`` (default ``en``), ``WHATSAPP_API_VERSION``
  (default ``v21.0``), ``WHATSAPP_DEFAULT_COUNTRY_CODE`` (default ``91``).

Until the token, phone number id and certificate template are all set the
provider is DISABLED: ``provider_from_settings()`` returns ``None`` and the
delivery is recorded as not sent (``whatsapp_not_configured``). It never
pretends to have sent anything.

Each document is uploaded first (``POST /<phone-id>/media``) so the letter
never needs a public URL, then sent by its media id. Errors say whether a
retry can help (``retryable``): network errors, timeouts, HTTP 429 / 5xx and
Meta's throttling codes are retryable; other 4xx answers are not.
"""

from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass

from django.conf import settings

logger = logging.getLogger("apps.certification.whatsapp")

DEFAULT_GRAPH_BASE = "https://graph.facebook.com"
RETRYABLE_META_CODES = frozenset({1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 131056})


class WhatsAppError(Exception):
    def __init__(self, message: str, *, retryable: bool, status: int | None = None, code=None):
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.code = code


@dataclass(frozen=True)
class WhatsAppConfig:
    token: str
    phone_number_id: str
    certificate_template: str
    letter_template: str = ""
    language: str = "en"
    api_version: str = "v21.0"
    graph_base: str = DEFAULT_GRAPH_BASE
    default_country_code: str = "91"
    timeout: float = 15.0


def _setting(name: str, default: str = "") -> str:
    return str(getattr(settings, name, default) or default).strip()


def config_from_settings() -> WhatsAppConfig | None:
    token = _setting("WHATSAPP_CLOUD_API_TOKEN")
    phone_id = _setting("WHATSAPP_PHONE_NUMBER_ID")
    template = _setting("WHATSAPP_TEMPLATE_CERTIFICATE")
    if not (token and phone_id and template):
        return None
    try:
        timeout = float(getattr(settings, "WHATSAPP_HTTP_TIMEOUT_SECONDS", 15) or 15)
    except (TypeError, ValueError):
        timeout = 15.0
    return WhatsAppConfig(
        token=token,
        phone_number_id=phone_id,
        certificate_template=template,
        letter_template=_setting("WHATSAPP_TEMPLATE_LETTER"),
        language=_setting("WHATSAPP_TEMPLATE_LANGUAGE", "en") or "en",
        api_version=_setting("WHATSAPP_API_VERSION", "v21.0") or "v21.0",
        graph_base=(_setting("WHATSAPP_GRAPH_BASE_URL", DEFAULT_GRAPH_BASE) or DEFAULT_GRAPH_BASE).rstrip("/"),
        default_country_code=re.sub(r"\D", "", _setting("WHATSAPP_DEFAULT_COUNTRY_CODE", "91")),
        timeout=max(1.0, min(60.0, timeout)),
    )


def is_configured() -> bool:
    return config_from_settings() is not None


def missing_settings() -> list[str]:
    names = ("WHATSAPP_CLOUD_API_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_TEMPLATE_CERTIFICATE")
    return [name for name in names if not _setting(name)]


def normalize_phone(raw, default_country_code: str = "91") -> str:
    """Digits in international format without '+' (what the Cloud API wants), or '' when unusable."""
    text = str(raw or "").strip()
    if not text:
        return ""
    plus = text.startswith("+")
    digits = re.sub(r"\D", "", text)
    if not plus and digits.startswith("00"):
        digits, plus = digits[2:], True
    if not plus:
        digits = digits.lstrip("0")
        if len(digits) == 10 and default_country_code:
            digits = default_country_code + digits
    if not 8 <= len(digits) <= 15:
        return ""
    return digits


def mask_phone(digits: str) -> str:
    return f"+{digits[:2]}{'•' * max(0, len(digits) - 6)}{digits[-4:]}" if digits else ""


def urllib_transport(method: str, url: str, headers: dict, body: bytes | None, timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https Graph URL
            return int(response.status), response.read()
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read() or b""


class WhatsAppCloudProvider:
    def __init__(self, config: WhatsAppConfig, transport=None):
        self.config = config
        self.transport = transport or urllib_transport

    def _url(self, path: str) -> str:
        return f"{self.config.graph_base}/{self.config.api_version}/{self.config.phone_number_id}/{path}"

    def _call(self, path: str, *, body: bytes, content_type: str) -> dict:
        headers = {"Authorization": f"Bearer {self.config.token}", "Content-Type": content_type}
        try:
            status, raw = self.transport("POST", self._url(path), headers, body, self.config.timeout)
        except TimeoutError as exc:
            raise WhatsAppError(f"WhatsApp API timed out: {exc}", retryable=True) from exc
        except (urllib.error.URLError, OSError, ConnectionError) as exc:
            raise WhatsAppError(f"WhatsApp API unreachable: {exc}", retryable=True) from exc
        try:
            data = json.loads(raw.decode("utf-8") or "{}") if raw else {}
        except (ValueError, UnicodeDecodeError):
            data = {}
        if 200 <= status < 300 and "error" not in data:
            return data
        error = data.get("error") if isinstance(data, dict) else None
        error = error if isinstance(error, dict) else {}
        code = error.get("code")
        message = str(error.get("message") or f"HTTP {status}")[:300]
        retryable = status == 429 or status >= 500 or code in RETRYABLE_META_CODES
        raise WhatsAppError(f"WhatsApp API error {status} (code {code}): {message}", retryable=retryable, status=status, code=code)

    def upload_document(self, data: bytes, filename: str, mime: str = "application/pdf") -> str:
        boundary = f"----asi{uuid.uuid4().hex}"
        parts = []
        for name, value in (("messaging_product", "whatsapp"), ("type", mime)):
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", filename)[:100] or "document.pdf"
        parts.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
                f"Content-Type: {mime}\r\n\r\n"
            ).encode()
            + data
            + b"\r\n"
        )
        parts.append(f"--{boundary}--\r\n".encode())
        result = self._call("media", body=b"".join(parts), content_type=f"multipart/form-data; boundary={boundary}")
        media_id = str(result.get("id") or "")
        if not media_id:
            raise WhatsAppError("WhatsApp media upload returned no id.", retryable=True)
        return media_id

    def send_document_template(self, *, to: str, template: str, media_id: str, filename: str, body_params) -> str:
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "template",
            "template": {
                "name": template,
                "language": {"code": self.config.language},
                "components": [
                    {"type": "header", "parameters": [{"type": "document", "document": {"id": media_id, "filename": filename}}]},
                    {"type": "body", "parameters": [{"type": "text", "text": str(value)[:1000]} for value in body_params]},
                ],
            },
        }
        result = self._call("messages", body=json.dumps(payload).encode("utf-8"), content_type="application/json")
        messages = result.get("messages") if isinstance(result, dict) else None
        message_id = str((messages or [{}])[0].get("id") or "") if isinstance(messages, list) else ""
        if not message_id:
            raise WhatsAppError("WhatsApp accepted the request but returned no message id.", retryable=False)
        return message_id


def provider_from_settings(transport=None) -> WhatsAppCloudProvider | None:
    config = config_from_settings()
    return WhatsAppCloudProvider(config, transport=transport) if config else None
