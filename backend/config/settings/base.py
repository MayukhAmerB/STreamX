from datetime import timedelta
import logging
from pathlib import Path

import dj_database_url

from config.env import env, env_bool, env_int, env_list

# Developer credit: Ibrahim Mohsin Mayukh Bhatt
BASE_DIR = Path(__file__).resolve().parents[2]

SECRET_KEY = env("DJANGO_SECRET_KEY", "dev-only-secret-key")
DEBUG = env_bool("DEBUG", False)
APP_ENV = env("APP_ENV", "production" if not DEBUG else "development").strip().lower()
ALLOWED_HOSTS = env_list(
    "ALLOWED_HOSTS",
    ["localhost", "127.0.0.1"] if DEBUG else [],
)
ENABLE_WHITENOISE_STATIC = env_bool("ENABLE_WHITENOISE_STATIC", not DEBUG)
if ENABLE_WHITENOISE_STATIC:
    try:
        import whitenoise  # noqa: F401
    except ImportError:
        ENABLE_WHITENOISE_STATIC = False

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "rest_framework.authtoken",
    "apps.users",
    "apps.courses",
    "apps.payments",
    "apps.realtime",
]

MIDDLEWARE = [
    "config.observability.RequestContextMiddleware",
    "config.observability.PerformanceBudgetMiddleware",
    "django.middleware.security.SecurityMiddleware",
]
if ENABLE_WHITENOISE_STATIC:
    MIDDLEWARE.append("whitenoise.middleware.WhiteNoiseMiddleware")
MIDDLEWARE += [
    "corsheaders.middleware.CorsMiddleware",
    "config.security.SuspiciousInputFirewallMiddleware",
    "config.security.APISecurityHeadersMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]

DATABASE_URL = env("DATABASE_URL", "sqlite:///db.sqlite3")
is_postgres_database = DATABASE_URL.startswith(("postgres://", "postgresql://", "postgis://"))
DATABASES = {
    "default": dj_database_url.parse(
        DATABASE_URL,
        conn_max_age=env_int("DATABASE_CONN_MAX_AGE", 120),
        ssl_require=env_bool("DATABASE_SSL_REQUIRE", not DEBUG) if is_postgres_database else False,
    )
}
_db_engine_name = str(DATABASES["default"].get("ENGINE", "")).lower()
_db_name = str(DATABASES["default"].get("NAME", "")).strip()
if "sqlite3" in _db_engine_name and _db_name and not Path(_db_name).is_absolute():
    DATABASES["default"]["NAME"] = str((BASE_DIR / _db_name).resolve())
DATABASE_CONN_HEALTH_CHECKS = env_bool("DATABASE_CONN_HEALTH_CHECKS", True)
DATABASE_STATEMENT_TIMEOUT_MS = env_int("DATABASE_STATEMENT_TIMEOUT_MS", 15000)
DATABASE_LOCK_TIMEOUT_MS = env_int("DATABASE_LOCK_TIMEOUT_MS", 10000)
DATABASE_IDLE_IN_TX_TIMEOUT_MS = env_int("DATABASE_IDLE_IN_TX_TIMEOUT_MS", 30000)
DATABASE_CONNECT_TIMEOUT_SECONDS = env_int("DATABASE_CONNECT_TIMEOUT_SECONDS", 10)
DATABASES["default"]["CONN_HEALTH_CHECKS"] = DATABASE_CONN_HEALTH_CHECKS
_db_engine = str(DATABASES["default"].get("ENGINE", ""))
if "postgresql" in _db_engine:
    db_options = DATABASES["default"].get("OPTIONS", {})
    existing_option_string = str(db_options.get("options", "")).strip()
    hardening_options = (
        f"-c statement_timeout={DATABASE_STATEMENT_TIMEOUT_MS} "
        f"-c lock_timeout={DATABASE_LOCK_TIMEOUT_MS} "
        f"-c idle_in_transaction_session_timeout={DATABASE_IDLE_IN_TX_TIMEOUT_MS}"
    )
    db_options.setdefault("connect_timeout", DATABASE_CONNECT_TIMEOUT_SECONDS)
    db_options["options"] = f"{existing_option_string} {hardening_options}".strip()
    DATABASES["default"]["OPTIONS"] = db_options

CACHE_DEFAULT_TIMEOUT_SECONDS = env_int("CACHE_DEFAULT_TIMEOUT_SECONDS", 300)
REDIS_URL = env("REDIS_URL", "").strip()
if REDIS_URL:
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.redis.RedisCache",
            "LOCATION": REDIS_URL,
            "TIMEOUT": CACHE_DEFAULT_TIMEOUT_SECONDS,
            "OPTIONS": {
                "socket_connect_timeout": env_int("REDIS_SOCKET_CONNECT_TIMEOUT_SECONDS", 5),
                "socket_timeout": env_int("REDIS_SOCKET_TIMEOUT_SECONDS", 5),
                "retry_on_timeout": True,
            },
        }
    }
else:
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "al-syed-initiative-cache",
            "TIMEOUT": CACHE_DEFAULT_TIMEOUT_SECONDS,
        }
    }

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": env_int("AUTH_MIN_PASSWORD_LENGTH", 12)},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher",
]
try:
    import argon2  # noqa: F401
except ImportError:
    pass
else:
    PASSWORD_HASHERS.insert(0, "django.contrib.auth.hashers.Argon2PasswordHasher")

LANGUAGE_CODE = "en-us"
TIME_ZONE = "Asia/Kolkata"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
WHITENOISE_MAX_AGE = env_int("WHITENOISE_MAX_AGE", 0 if DEBUG else 31536000)
WHITENOISE_ALLOW_ALL_ORIGINS = env_bool("WHITENOISE_ALLOW_ALL_ORIGINS", True)
WHITENOISE_KEEP_ONLY_HASHED_FILES = env_bool("WHITENOISE_KEEP_ONLY_HASHED_FILES", True)
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"
MEDIA_PUBLIC_BASE_URL = env("MEDIA_PUBLIC_BASE_URL", "").rstrip("/")

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}

if ENABLE_WHITENOISE_STATIC:
    STORAGES["staticfiles"] = {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_USER_MODEL = "users.User"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "config.authentication.CookieJWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.AllowAny",
    ],
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
        "rest_framework.throttling.ScopedRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "50/minute",
        "user": "200/minute",
        "login": "10/minute",
        "login_burst": "10/minute",
        "contact": "5/hour",
        "public_enrollment_lead": "20/hour",
        "password_reset_request": "5/hour",
        "password_reset_confirm": "20/hour",
        "payment_create": "20/hour",
        "payment_verify": "60/hour",
        "course_enroll": "20/hour",
        "live_class_enroll": "20/hour",
        "lecture_playback": "120/minute",
        "realtime_session_create": "30/hour",
        "realtime_session_join": "240/hour",
    },
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=30),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": False,
    "BLACKLIST_AFTER_ROTATION": False,
    "AUTH_HEADER_TYPES": ("Bearer",),
}

JWT_COOKIE_SECURE = env_bool("JWT_COOKIE_SECURE", False)
JWT_COOKIE_SAMESITE = env("JWT_COOKIE_SAMESITE", "Lax")

SESSION_COOKIE_SECURE = env_bool("SESSION_COOKIE_SECURE", not DEBUG)
CSRF_COOKIE_SECURE = env_bool("CSRF_COOKIE_SECURE", not DEBUG)
SESSION_COOKIE_HTTPONLY = True
CSRF_COOKIE_HTTPONLY = env_bool("CSRF_COOKIE_HTTPONLY", False)
SESSION_COOKIE_SAMESITE = env("SESSION_COOKIE_SAMESITE", "Lax")
CSRF_COOKIE_SAMESITE = env("CSRF_COOKIE_SAMESITE", "Lax")
SESSION_COOKIE_AGE = env_int("SESSION_COOKIE_AGE", 1209600)
SESSION_EXPIRE_AT_BROWSER_CLOSE = env_bool("SESSION_EXPIRE_AT_BROWSER_CLOSE", False)
SESSION_SAVE_EVERY_REQUEST = env_bool("SESSION_SAVE_EVERY_REQUEST", False)
_session_cookie_domain = env("SESSION_COOKIE_DOMAIN", "").strip()
_csrf_cookie_domain = env("CSRF_COOKIE_DOMAIN", "").strip()
SESSION_COOKIE_DOMAIN = _session_cookie_domain or None
CSRF_COOKIE_DOMAIN = _csrf_cookie_domain or None
_default_session_engine = "django.contrib.sessions.backends.cached_db" if REDIS_URL else "django.contrib.sessions.backends.db"
SESSION_ENGINE = env("SESSION_ENGINE", "").strip() or _default_session_engine
SESSION_CACHE_ALIAS = "default"

CORS_ALLOWED_ORIGINS = env_list("CORS_ALLOWED_ORIGINS", ["http://localhost:5173"])
CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_ALL_ORIGINS = False
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", ["http://localhost:5173"])

if DEBUG:
    dev_frontend_origins = [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:5175",
    ]
    CORS_ALLOWED_ORIGINS = list(dict.fromkeys([*CORS_ALLOWED_ORIGINS, *dev_frontend_origins]))
    CSRF_TRUSTED_ORIGINS = list(dict.fromkeys([*CSRF_TRUSTED_ORIGINS, *dev_frontend_origins]))

SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", False)
USE_X_FORWARDED_HOST = env_bool("USE_X_FORWARDED_HOST", True)
USE_X_FORWARDED_PORT = env_bool("USE_X_FORWARDED_PORT", True)
if env_bool("USE_SECURE_PROXY_SSL_HEADER", True):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
else:
    SECURE_PROXY_SSL_HEADER = None

SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = env("SECURE_REFERRER_POLICY", "strict-origin-when-cross-origin")
X_FRAME_OPTIONS = env("X_FRAME_OPTIONS", "DENY")
SECURE_CROSS_ORIGIN_OPENER_POLICY = env("SECURE_CROSS_ORIGIN_OPENER_POLICY", "same-origin")
SECURE_CROSS_ORIGIN_RESOURCE_POLICY = env("SECURE_CROSS_ORIGIN_RESOURCE_POLICY", "same-origin")
SECURE_PERMISSIONS_POLICY = env(
    "SECURE_PERMISSIONS_POLICY",
    (
        "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), "
        "geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"
    ),
)
API_SECURITY_CSP = env(
    "API_SECURITY_CSP",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
)

SECURE_HSTS_SECONDS = env_int("SECURE_HSTS_SECONDS", 0 if DEBUG else 31536000)
SECURE_HSTS_INCLUDE_SUBDOMAINS = env_bool("SECURE_HSTS_INCLUDE_SUBDOMAINS", not DEBUG)
SECURE_HSTS_PRELOAD = env_bool("SECURE_HSTS_PRELOAD", not DEBUG)

SECURE_REDIRECT_EXEMPT = env_list("SECURE_REDIRECT_EXEMPT", [])
SECURE_SSL_HOST = env("SECURE_SSL_HOST", None)

AWS_ACCESS_KEY_ID = env("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = env("AWS_SECRET_ACCESS_KEY", "")
AWS_STORAGE_BUCKET_NAME = env("AWS_STORAGE_BUCKET_NAME", "")
AWS_S3_REGION_NAME = env("AWS_S3_REGION_NAME", "")

RAZORPAY_KEY_ID = env("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = env("RAZORPAY_KEY_SECRET", "")
RAZORPAY_WEBHOOK_SECRET = env("RAZORPAY_WEBHOOK_SECRET", "")
GOOGLE_CLIENT_ID = env("GOOGLE_CLIENT_ID", "")

FRONTEND_URL = env("FRONTEND_URL", "http://localhost:5173")
FRONTEND_PUBLIC_ORIGIN = env("FRONTEND_PUBLIC_ORIGIN", "")

EMAIL_BACKEND = env("EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend")
EMAIL_HOST = env("EMAIL_HOST", "")
EMAIL_PORT = env_int("EMAIL_PORT", 587)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = env_bool("EMAIL_USE_TLS", True)
EMAIL_USE_SSL = env_bool("EMAIL_USE_SSL", False)
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", "no-reply@alsyedinitiative.local")
CONTACT_RECEIVER_EMAIL = env("CONTACT_RECEIVER_EMAIL", DEFAULT_FROM_EMAIL)
FFMPEG_BINARY = env("FFMPEG_BINARY", "ffmpeg")
FFPROBE_BINARY = env("FFPROBE_BINARY", "ffprobe")
SECURITY_BLOCK_SUSPICIOUS_INPUT = env_bool("SECURITY_BLOCK_SUSPICIOUS_INPUT", True)
SECURITY_MAX_INSPECTION_BODY_BYTES = env_int("SECURITY_MAX_INSPECTION_BODY_BYTES", 16384)
AUTH_LOGIN_MAX_FAILURES = env_int("AUTH_LOGIN_MAX_FAILURES", 10)
AUTH_LOGIN_LOCKOUT_SECONDS = env_int("AUTH_LOGIN_LOCKOUT_SECONDS", 3600)
ACCOUNT_SELF_SERVICE_CREDENTIALS_ENABLED = env_bool("ACCOUNT_SELF_SERVICE_CREDENTIALS_ENABLED", False)
COURSE_LIST_CACHE_TTL_SECONDS = env_int("COURSE_LIST_CACHE_TTL_SECONDS", 60)
COURSE_DETAIL_CACHE_TTL_SECONDS = env_int("COURSE_DETAIL_CACHE_TTL_SECONDS", 60)
LIVE_CLASS_LIST_CACHE_TTL_SECONDS = env_int("LIVE_CLASS_LIST_CACHE_TTL_SECONDS", 30)
DATA_UPLOAD_MAX_MEMORY_SIZE = env_int("DATA_UPLOAD_MAX_MEMORY_SIZE", 2621440)
FILE_UPLOAD_MAX_MEMORY_SIZE = env_int("FILE_UPLOAD_MAX_MEMORY_SIZE", 2621440)
MAX_VIDEO_UPLOAD_BYTES = env_int("MAX_VIDEO_UPLOAD_BYTES", 2147483648)
DATA_UPLOAD_MAX_NUMBER_FIELDS = env_int("DATA_UPLOAD_MAX_NUMBER_FIELDS", 1000)
TRUST_X_FORWARDED_FOR = env_bool("TRUST_X_FORWARDED_FOR", not DEBUG)
TRUSTED_PROXY_COUNT = max(1, env_int("TRUSTED_PROXY_COUNT", 1))
LIVEKIT_URL = env("LIVEKIT_URL", "")
LIVEKIT_SERVER_URL = env("LIVEKIT_SERVER_URL", "")
LIVEKIT_PUBLIC_URL = env("LIVEKIT_PUBLIC_URL", "")
LIVEKIT_API_KEY = env("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = env("LIVEKIT_API_SECRET", "")
LIVEKIT_MEET_URL = env("LIVEKIT_MEET_URL", "https://meet.livekit.io")
LIVEKIT_RECORDING_ENABLED = env_bool("LIVEKIT_RECORDING_ENABLED", True)
LIVEKIT_RECORDING_FILEPATH_PREFIX = env("LIVEKIT_RECORDING_FILEPATH_PREFIX", "/recordings")
LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT = env("LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT", "/recordings")
LIVEKIT_RECORDING_OUTPUT_PUBLIC_BASE_URL = env("LIVEKIT_RECORDING_OUTPUT_PUBLIC_BASE_URL", "").strip()

REALTIME_DEFAULT_MEETING_CAPACITY = env_int("REALTIME_DEFAULT_MEETING_CAPACITY", 200)
REALTIME_DEFAULT_MAX_AUDIENCE = env_int("REALTIME_DEFAULT_MAX_AUDIENCE", 50000)
REALTIME_JOIN_TOKEN_TTL_SECONDS = env_int("REALTIME_JOIN_TOKEN_TTL_SECONDS", 3600)
REALTIME_SESSION_LIST_CACHE_TTL_SECONDS = env_int("REALTIME_SESSION_LIST_CACHE_TTL_SECONDS", 5)
REALTIME_PARTICIPANT_COUNT_CACHE_TTL_SECONDS = env_int("REALTIME_PARTICIPANT_COUNT_CACHE_TTL_SECONDS", 5)
REALTIME_TELEMETRY_ENABLED = env_bool("REALTIME_TELEMETRY_ENABLED", True)
REALTIME_TELEMETRY_LOG_WINDOW_SECONDS = env_int("REALTIME_TELEMETRY_LOG_WINDOW_SECONDS", 60)
REALTIME_WARN_PARTICIPANT_FALLBACK_SOURCE = env_bool("REALTIME_WARN_PARTICIPANT_FALLBACK_SOURCE", True)
try:
    REALTIME_CAPACITY_WARNING_RATIO = float(env("REALTIME_CAPACITY_WARNING_RATIO", "0.8"))
except (TypeError, ValueError):
    REALTIME_CAPACITY_WARNING_RATIO = 0.8
REALTIME_CAPACITY_WARNING_RATIO = max(0.1, min(1.0, REALTIME_CAPACITY_WARNING_RATIO))

PERF_MONITORING_ENABLED = env_bool("PERF_MONITORING_ENABLED", True)
PERF_DB_QUERY_TRACKING_ENABLED = env_bool("PERF_DB_QUERY_TRACKING_ENABLED", True)
_default_perf_sample_rate = "1.0" if DEBUG else "0.25"
try:
    PERF_DB_QUERY_SAMPLE_RATE = float(env("PERF_DB_QUERY_SAMPLE_RATE", _default_perf_sample_rate))
except (TypeError, ValueError):
    PERF_DB_QUERY_SAMPLE_RATE = float(_default_perf_sample_rate)
PERF_DB_QUERY_SAMPLE_RATE = max(0.0, min(1.0, PERF_DB_QUERY_SAMPLE_RATE))
PERF_SLOW_QUERY_MS = env_int("PERF_SLOW_QUERY_MS", 120)
PERF_DEFAULT_ENDPOINT_BUDGET_MS = env_int("PERF_DEFAULT_ENDPOINT_BUDGET_MS", 800)
PERF_WARN_QUERY_COUNT = env_int("PERF_WARN_QUERY_COUNT", 30)
PERF_WARN_QUERY_TIME_MS = env_int("PERF_WARN_QUERY_TIME_MS", 300)
PERF_LOG_ALL_REQUESTS = env_bool("PERF_LOG_ALL_REQUESTS", False)
PERF_RESPONSE_TIME_HEADER_ENABLED = env_bool("PERF_RESPONSE_TIME_HEADER_ENABLED", DEBUG)
PERF_PATH_BUDGETS = {}
for _raw_budget_row in env_list(
    "PERF_PATH_BUDGETS",
    [
        "/api/realtime/sessions/=650",
        "/api/live-classes/=450",
        "/api/courses/=550",
        "/api/lectures/=650",
        "/api/auth/=500",
    ],
):
    budget_row = str(_raw_budget_row or "").strip()
    if not budget_row:
        continue
    delimiter = "=" if "=" in budget_row else ":" if ":" in budget_row else None
    if delimiter is None:
        continue
    path_prefix, budget_value = [segment.strip() for segment in budget_row.split(delimiter, 1)]
    if not path_prefix:
        continue
    try:
        PERF_PATH_BUDGETS[path_prefix] = max(50, int(budget_value))
    except (TypeError, ValueError):
        continue

METRICS_ENABLED = env_bool("METRICS_ENABLED", True)
METRICS_AUTH_TOKEN = env("METRICS_AUTH_TOKEN", "").strip()
ASYNC_JOBS_ENABLED = env_bool("ASYNC_JOBS_ENABLED", False)
ASYNC_JOBS_POLL_SECONDS = env_int("ASYNC_JOBS_POLL_SECONDS", 10)
ASYNC_JOBS_LOCK_TIMEOUT_SECONDS = env_int("ASYNC_JOBS_LOCK_TIMEOUT_SECONDS", 300)
ASYNC_EMAIL_MAX_ATTEMPTS = env_int("ASYNC_EMAIL_MAX_ATTEMPTS", 5)
ASYNC_WEBHOOK_RETRY_MAX_ATTEMPTS = env_int("ASYNC_WEBHOOK_RETRY_MAX_ATTEMPTS", 6)

SENTRY_DSN = env("SENTRY_DSN", "").strip()
SENTRY_ENVIRONMENT = env("SENTRY_ENVIRONMENT", APP_ENV).strip() or APP_ENV
try:
    SENTRY_TRACES_SAMPLE_RATE = float(env("SENTRY_TRACES_SAMPLE_RATE", "0.0"))
except (TypeError, ValueError):
    SENTRY_TRACES_SAMPLE_RATE = 0.0
SENTRY_TRACES_SAMPLE_RATE = max(0.0, min(1.0, SENTRY_TRACES_SAMPLE_RATE))
SENTRY_SEND_PII = env_bool("SENTRY_SEND_PII", False)

if SENTRY_DSN:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.django import DjangoIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration
    except ImportError:
        sentry_sdk = None
    if sentry_sdk is not None:
        sentry_sdk.init(
            dsn=SENTRY_DSN,
            environment=SENTRY_ENVIRONMENT,
            integrations=[
                DjangoIntegration(),
                LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
            ],
            traces_sample_rate=SENTRY_TRACES_SAMPLE_RATE,
            send_default_pii=SENTRY_SEND_PII,
        )

OWNCAST_BASE_URL = env("OWNCAST_BASE_URL", "")
OWNCAST_STREAM_PUBLIC_BASE_URL = env("OWNCAST_STREAM_PUBLIC_BASE_URL", "")
OWNCAST_CHAT_PUBLIC_BASE_URL = env("OWNCAST_CHAT_PUBLIC_BASE_URL", "")
OWNCAST_DEFAULT_STREAM_PATH = env("OWNCAST_DEFAULT_STREAM_PATH", "/embed/video")
OWNCAST_DEFAULT_CHAT_PATH = env("OWNCAST_DEFAULT_CHAT_PATH", "/embed/chat/readwrite")
OWNCAST_RTMP_TARGET = env("OWNCAST_RTMP_TARGET", "")
LIVEKIT_EGRESS_LAYOUT = env("LIVEKIT_EGRESS_LAYOUT", "speaker-dark")

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {
        "request_id": {
            "()": "config.observability.RequestIDLogFilter",
        }
    },
    "formatters": {
        "standard": {
            "format": "%(asctime)s %(levelname)s [%(request_id)s] %(name)s %(message)s",
        }
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "standard",
            "filters": ["request_id"],
        }
    },
    "loggers": {
        "django": {
            "handlers": ["console"],
            "level": env("LOG_LEVEL", "INFO"),
            "propagate": False,
        },
        "security.audit": {
            "handlers": ["console"],
            "level": env("LOG_LEVEL", "INFO"),
            "propagate": False,
        },
        "django.security": {
            "handlers": ["console"],
            "level": env("DJANGO_SECURITY_LOG_LEVEL", env("LOG_LEVEL", "INFO")),
            "propagate": False,
        },
        "ops.performance": {
            "handlers": ["console"],
            "level": env("PERF_LOG_LEVEL", env("LOG_LEVEL", "INFO")),
            "propagate": False,
        },
        "ops.realtime": {
            "handlers": ["console"],
            "level": env("REALTIME_TELEMETRY_LOG_LEVEL", env("LOG_LEVEL", "INFO")),
            "propagate": False,
        },
    },
    "root": {
        "handlers": ["console"],
        "level": env("LOG_LEVEL", "INFO"),
    },
}

