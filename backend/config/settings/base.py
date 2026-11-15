import logging
from datetime import timedelta
from pathlib import Path

import dj_database_url
from corsheaders.defaults import default_headers

from config.env import env, env_bool, env_int, env_list

# Developer credit: Ibrahim Mohsin Mayukh Bhatt
BASE_DIR = Path(__file__).resolve().parents[2]


def _dedupe_preserve_order(values):
    return list(dict.fromkeys([value for value in values if value]))


def append_internal_allowed_hosts(hosts):
    if not hosts:
        return hosts
    return _dedupe_preserve_order([*hosts, *INTERNAL_ALLOWED_HOSTS])

SECRET_KEY = env("DJANGO_SECRET_KEY", "")
DEBUG = env_bool("DEBUG", False)
APP_ENV = env("APP_ENV", "production" if not DEBUG else "development").strip().lower()
ALLOWED_HOSTS = env_list(
    "ALLOWED_HOSTS",
    ["localhost", "127.0.0.1"] if DEBUG else [],
)
INTERNAL_ALLOWED_HOSTS = env_list(
    "INTERNAL_ALLOWED_HOSTS",
    ["backend", "backend-2", "backend-3", "backend-4", "gateway"],
)
ALLOWED_HOSTS = append_internal_allowed_hosts(ALLOWED_HOSTS)
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
    "drf_spectacular",
    "rest_framework.authtoken",
    "rest_framework_simplejwt.token_blacklist",
    "apps.core.apps.CoreConfig",
    "apps.users",
    "apps.courses",
    "apps.payments",
    "apps.realtime",
    "apps.campaigns",
    "apps.social_accounts.apps.SocialAccountsConfig",
    "apps.national_desk.apps.NationalDeskConfig",
    "apps.join_requests.apps.JoinRequestsConfig",
    "apps.notifications.apps.NotificationsConfig",
    "apps.insights.apps.InsightsConfig",
    "apps.reports.apps.ReportsConfig",
    "apps.site_media.apps.SiteMediaConfig",
    "apps.ctf.apps.CtfConfig",
    # Resumable (chunked) class recording uploads + personal upload tokens.
    "apps.recording_uploads.apps.RecordingUploadsConfig",
    # UI overhaul: Console workspace + admin API (/api/console/, /api/admin/).
    "apps.console_api.apps.ConsoleApiConfig",
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
    # The labs site may only write to the CTF exam API (see config/labs_origin.py).
    "config.labs_origin.LabsOriginScopeMiddleware",
    "config.security.SuspiciousInputFirewallMiddleware",
    "config.security.APISecurityHeadersMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    # X-Session-State: live-grace for a device evicted mid-class (apps/users/live_grace.py).
    "apps.users.live_grace.LiveGraceHeaderMiddleware",
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
# Behind PgBouncer (transaction pooling) the pooler already checks its server
# connections, so Django's per-request "SELECT 1" health check is pure cost.
# Detected from the DATABASE_URL host; DATABASE_BEHIND_POOLER overrides it.
_db_host = str(DATABASES["default"].get("HOST", "") or "").strip().lower()
DATABASE_BEHIND_POOLER = env_bool("DATABASE_BEHIND_POOLER", "pgbouncer" in _db_host)
if DATABASE_BEHIND_POOLER:
    DATABASE_CONN_HEALTH_CHECKS = env_bool("DATABASE_POOLER_CONN_HEALTH_CHECKS", False)
# Server-side cursors (QuerySet.iterator()) cannot cross transactions in
# PgBouncer transaction mode ("cursor ... does not exist" under load), so they
# are off for PostgreSQL; iterator() then fetches client-side.
DATABASE_DISABLE_SERVER_SIDE_CURSORS = env_bool("DATABASE_DISABLE_SERVER_SIDE_CURSORS", True)
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
    # PgBouncer discards the libpq "options" above (IGNORE_STARTUP_PARAMETERS),
    # so production also sets these timeouts on the database role:
    # infra/hostinger/apply-db-role-timeouts.sh.
    DATABASES["default"]["DISABLE_SERVER_SIDE_CURSORS"] = DATABASE_DISABLE_SERVER_SIDE_CURSORS

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
# Keep local media readable by the nginx media container even when upload
# directories are created by a restrictive process umask inside Docker.
FILE_UPLOAD_PERMISSIONS = 0o644
FILE_UPLOAD_DIRECTORY_PERMISSIONS = 0o755

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}

if ENABLE_WHITENOISE_STATIC:
    STORAGES["staticfiles"] = {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_USER_MODEL = "users.User"

REST_FRAMEWORK = {
    "DEFAULT_SCHEMA_CLASS": "config.openapi.StreamXAutoSchema",
    # One error contract: every raised error leaves as the success/message/
    # data/errors envelope with a stable errors.code (see apps/core/README.md).
    "EXCEPTION_HANDLER": "apps.core.exception_handler.api_exception_handler",
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "config.authentication.CookieJWTAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_THROTTLE_CLASSES": [
        "config.throttling.ClientIpAnonRateThrottle",
        "config.throttling.ClientIpUserRateThrottle",
        "config.throttling.ClientIpScopedRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "50/minute",
        "user": "200/minute",
        # Per-IP ceiling across all accounts; per-account abuse is covered by
        # login_burst (IP + email) and the failed-login lockout.
        "login": env("AUTH_LOGIN_IP_RATE", "120/minute"),
        "refresh": env("AUTH_REFRESH_TOKEN_RATE", "30/minute"),
        "refresh_ip": env("AUTH_REFRESH_IP_RATE", "600/minute"),
        "login_burst": "10/minute",
        "contact": "5/hour",
        "public_enrollment_lead": "20/hour",
        "campaign_volunteer": "30/hour",
        "join_application": "30/hour",
        "password_reset_request": "5/hour",
        "password_reset_confirm": "20/hour",
        "payment_create": "120/minute",
        "payment_verify": "240/minute",
        "course_enroll": "20/hour",
        "live_class_enroll": "20/hour",
        "lecture_playback": "120/minute",
        "lecture_engagement_read": env("LECTURE_ENGAGEMENT_READ_RATE", "240/minute"),
        "lecture_like": env("LECTURE_LIKE_RATE", "60/minute"),
        "lecture_comment_write": env("LECTURE_COMMENT_WRITE_RATE", "10/minute"),
        "class_recording_upload": env("CLASS_RECORDING_UPLOAD_RATE", "20/hour"),
        "realtime_session_create": "30/hour",
        # Per account (config.throttling.RealtimeJoinUserRateThrottle), plus a
        # high per-IP ceiling: classrooms and carrier NAT share one address.
        "realtime_session_join": env("REALTIME_SESSION_JOIN_RATE", "240/hour"),
        "realtime_session_join_ip": env("REALTIME_SESSION_JOIN_IP_RATE", "6000/hour"),
        "realtime_connection_telemetry": "600/hour",
        # Weekly reports: one file per upload request, so the upload budget
        # covers several files per task plus retries.
        "report_upload": env("REPORT_UPLOAD_RATE", "120/hour"),
        "report_submit": env("REPORT_SUBMIT_RATE", "60/hour"),
        "report_grade": env("REPORT_GRADE_RATE", "1200/hour"),
        "report_export": env("REPORT_EXPORT_RATE", "60/hour"),
        # Public website YouTube section (GET /api/site/youtube/), per client IP. Generous:
        # classrooms share one NAT address and every open tab polls once a minute.
        "site_youtube": env("SITE_YOUTUBE_RATE", "300/minute"),
        # Public website figures (GET /api/site/stats/): one cached payload for everyone.
        "site_stats": env("SITE_STATS_RATE", "120/minute"),
        # OSINT CTF exams (apps.ctf). Per student; the per-question attempt cap
        # is the real brute-force limit.
        "ctf_attempt": env("CTF_ATTEMPT_RATE", "30/minute"),
        "ctf_read": env("CTF_READ_RATE", "240/minute"),
        # Resumable class recording uploads (apps.recording_uploads). A 3 GB
        # file is ~96 chunks of 32 MiB; retries and 3 parallel streams fit.
        "recording_upload_create": env("RECORDING_UPLOAD_CREATE_RATE", "60/hour"),
        "recording_upload_chunk": env("RECORDING_UPLOAD_CHUNK_RATE", "1200/hour"),
        "recording_upload_read": env("RECORDING_UPLOAD_READ_RATE", "600/hour"),
        "recording_upload_token": env("RECORDING_UPLOAD_TOKEN_RATE", "20/hour"),
    },
}

SPECTACULAR_SETTINGS = {
    "TITLE": "StreamX API",
    "DESCRIPTION": "Versioned API contract for StreamX frontends and operational clients.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
    "SCHEMA_PATH_PREFIX": r"/api",
    "SCHEMA_PATH_PREFIX_TRIM": True,
    "SERVERS": [{"url": "/api", "description": "Current origin API"}],
    "PREPROCESSING_HOOKS": ["config.openapi.preprocess_api_endpoints"],
    # Explicit names keep new enums from renaming existing components (e.g. StateEnum).
    "ENUM_NAME_OVERRIDES": {
        "StateEnum": "apps.join_requests.india_locations.STATE_CHOICES",
        "ClassRecordingStateEnum": "apps.realtime.recording.models.ClassRecording.STATE_CHOICES",
        "ClassRecordingSourceEnum": "apps.realtime.recording.models.ClassRecording.SOURCE_CHOICES",
        "ReportTaskStatusEnum": "apps.reports.models.ReportTask.STATUS_CHOICES",
        "ReportLatePolicyEnum": "apps.reports.models.ReportTask.LATE_POLICY_CHOICES",
        "ReportMarksVisibilityEnum": "apps.reports.models.ReportTask.MARKS_VISIBILITY_CHOICES",
        "ReportSubmissionStatusEnum": "apps.reports.models.ReportSubmission.STATUS_CHOICES",
        "ReportGradeActionEnum": "apps.reports.models.GRADE_ACTION_CHOICES",
        "ReportGradebookCellStatusEnum": "apps.reports.serializers.CELL_STATUS_CHOICES",
        "ReportWindowEnum": "apps.reports.serializers.WINDOW_CHOICES",
        "ReportFilePreviewEnum": "apps.reports.serializers.PREVIEW_CHOICES",
        "ReportFileTypeEnum": "apps.reports.serializers.FILE_TYPE_CHOICES",
        # Pinned so the reports enums above cannot rename this existing component.
        "StatusEnum": "apps.national_desk.models.TrackerUpdate.STATUS_CHOICES",
        # CtfExam.STATUS_CHOICES has the same values as ReportTask (draft/published/closed),
        # so it shares ReportTaskStatusEnum; a second override would be a duplicate.
        # Pinned so the CTF question "category" enum cannot rename the course one.
        "CategoryEnum": "apps.courses.models.Course.CATEGORY_CHOICES",
        "CtfExamWindowEnum": "apps.ctf.models.CtfExam.WINDOW_CHOICES",
        "CtfParticipationStatusEnum": "apps.ctf.models.CtfParticipation.STATUS_CHOICES",
        "CtfQuestionCategoryEnum": "apps.ctf.models.CATEGORY_CHOICES",
        "CtfQuestionDifficultyEnum": "apps.ctf.models.DIFFICULTY_CHOICES",
        "CtfMaterialKindEnum": "apps.ctf.serializers.MATERIAL_KIND_CHOICES",
        # Phase 3: Console exams and the unified gradebook.
        "CtfConsoleExamStateEnum": "apps.ctf.console.STATE_CHOICES",
        "UnifiedGradebookItemKindEnum": "apps.ctf.gradebook_serializers.KIND_CHOICES",
    },
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=30),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
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
# If-None-Match/ETag: conditional polling of the realtime session list (304).
CORS_ALLOW_HEADERS = (*default_headers, "idempotency-key", "if-none-match")
# X-Session-State: a device evicted mid-class finishes it with a banner.
CORS_EXPOSE_HEADERS = ["ETag", "X-Session-State"]
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

# --- OSINT CTF exams (apps.ctf) ---
# The labs site calls /api/ctf/ from the browser with the student's cookies.
# It is trusted for CSRF, but CORS is enabled for it ONLY on /api/ctf/ and the
# CSRF/refresh endpoints (apps/ctf/signals.py), and every other write from a
# labs origin is refused (config/labs_origin.py). Never add it to
# CORS_ALLOWED_ORIGINS.
CTF_LABS_ORIGINS = env_list("CTF_LABS_ORIGINS", ["https://labs.alsyedinitiative.com"])
if DEBUG:
    CTF_LABS_ORIGINS = _dedupe_preserve_order([*CTF_LABS_ORIGINS, "http://localhost:8092", "http://127.0.0.1:8092"])
CSRF_TRUSTED_ORIGINS = _dedupe_preserve_order([*CSRF_TRUSTED_ORIGINS, *CTF_LABS_ORIGINS])
# HMAC key for exam answer hashes. A separate secret (not SECRET_KEY), at
# least 32 characters; rotating it requires reloading every exam file.
CTF_ANSWER_PEPPER = env("CTF_ANSWER_PEPPER", "").strip()
# >>> Phase 3: exams lifecycle, materials and gradebook (apps.ctf) >>>
# ctf.scheduler (apps/ctf/scheduler.py): auto-publish at opens_at, auto-close,
# expire participations, write results to the gradebook, notify students.
CTF_SCHEDULER_ENABLED = env_bool("CTF_SCHEDULER_ENABLED", True)
CTF_SCHEDULER_INTERVAL_SECONDS = max(15, env_int("CTF_SCHEDULER_INTERVAL_SECONDS", 60))
CTF_OPENING_SOON_MINUTES = max(5, env_int("CTF_OPENING_SOON_MINUTES", 60))
# Where exam notifications and the Console card send students.
CTF_LABS_EXAM_URL = env("CTF_LABS_EXAM_URL", "https://labs.alsyedinitiative.com/#exam").strip()
# Exam evidence uploaded from the Console: signed URL lifetime and size cap.
CTF_MATERIAL_URL_TTL_SECONDS = max(60, env_int("CTF_MATERIAL_URL_TTL_SECONDS", 7200))
CTF_MATERIAL_MAX_UPLOAD_MB = max(1, env_int("CTF_MATERIAL_MAX_UPLOAD_MB", 25))
# <<< Phase 3: exams lifecycle, materials and gradebook <<<

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
try:
    RAZORPAY_HTTP_TIMEOUT_SECONDS = max(
        1.0, float(env("RAZORPAY_HTTP_TIMEOUT_SECONDS", "12"))
    )
except (TypeError, ValueError):
    RAZORPAY_HTTP_TIMEOUT_SECONDS = 12.0
PAYMENT_IDEMPOTENCY_LEASE_SECONDS = max(
    env_int("PAYMENT_IDEMPOTENCY_LEASE_SECONDS", 60),
    int(RAZORPAY_HTTP_TIMEOUT_SECONDS) + 5,
)
PAYMENT_ORDER_RESUME_MAX_AGE_SECONDS = max(
    env_int("PAYMENT_ORDER_RESUME_MAX_AGE_SECONDS", 3600),
    60,
)
DIRECT_COURSE_PAYMENTS_ENABLED = env_bool("DIRECT_COURSE_PAYMENTS_ENABLED", False)
PAYMENT_SUPPORT_WHATSAPP_NUMBER = env(
    "PAYMENT_SUPPORT_WHATSAPP_NUMBER",
    "919970875040",
).strip()
TURNSTILE_ENABLED = env_bool("TURNSTILE_ENABLED", False)
TURNSTILE_SITE_KEY = env("TURNSTILE_SITE_KEY", "").strip()
TURNSTILE_SECRET_KEY = env("TURNSTILE_SECRET_KEY", "").strip()
TURNSTILE_VERIFY_URL = env(
    "TURNSTILE_VERIFY_URL",
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
).strip()
TURNSTILE_VERIFY_TIMEOUT_SECONDS = env_int("TURNSTILE_VERIFY_TIMEOUT_SECONDS", 5)
TURNSTILE_MAX_TOKEN_LENGTH = env_int("TURNSTILE_MAX_TOKEN_LENGTH", 2048)
TURNSTILE_ALLOWED_HOSTNAMES = env_list("TURNSTILE_ALLOWED_HOSTNAMES", [])

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
CONTACT_RECEIVER_EMAIL = env("CONTACT_RECEIVER_EMAIL", "contact@adlfront.com")
FFMPEG_BINARY = env("FFMPEG_BINARY", "ffmpeg")
FFPROBE_BINARY = env("FFPROBE_BINARY", "ffprobe")

# Server-side recording of OBS (Owncast) classes; see apps/realtime/recording/.
# Off by default: enable once the stream-recorder compose service is deployed.
STREAM_RECORDER_ENABLED = env_bool("STREAM_RECORDER_ENABLED", False)
STREAM_RECORDER_SOURCE_URL = env("STREAM_RECORDER_SOURCE_URL", "http://owncast:8080/hls/stream.m3u8").strip()
STREAM_RECORDER_WORK_DIR = env("STREAM_RECORDER_WORK_DIR", "/recordings/class-recordings").strip()
STREAM_RECORDER_MAX_BYTES = env_int("STREAM_RECORDER_MAX_BYTES", 30 * 1024 * 1024 * 1024)
STREAM_RECORDER_MIN_FREE_BYTES = env_int("STREAM_RECORDER_MIN_FREE_BYTES", 5 * 1024 * 1024 * 1024)
STREAM_RECORDER_MAX_DURATION_SECONDS = env_int("STREAM_RECORDER_MAX_DURATION_SECONDS", 6 * 3600)
STREAM_RECORDER_RESTART_BACKOFF_SECONDS = env_int("STREAM_RECORDER_RESTART_BACKOFF_SECONDS", 5)
STREAM_RECORDER_NICE = env_int("STREAM_RECORDER_NICE", 10)
STREAM_RECORDER_EGRESS_WAIT_SECONDS = env_int("STREAM_RECORDER_EGRESS_WAIT_SECONDS", 1800)
# Finalize/remux needs free space on the media disk >= input bytes x this factor
# + STREAM_RECORDER_MIN_FREE_BYTES (concat output + the HLS transcode after it).
STREAM_RECORDER_FINALIZE_SPACE_FACTOR = float(env("STREAM_RECORDER_FINALIZE_SPACE_FACTOR", "2.0") or 2.0)
# Captured parts of a failed recording are kept this long for a retry, then swept.
STREAM_RECORDER_FAILED_RETENTION_DAYS = env_int("STREAM_RECORDER_FAILED_RETENTION_DAYS", 7)
STREAM_RECORDER_SWEEP_INTERVAL_SECONDS = env_int("STREAM_RECORDER_SWEEP_INTERVAL_SECONDS", 3600)
STREAM_RECORDER_FINALIZE_QUEUE_SIZE = env_int("STREAM_RECORDER_FINALIZE_QUEUE_SIZE", 32)
# Capture through the recorder's local playlist filter, which keeps Owncast's
# offline clip out of recordings (see apps/realtime/recording/hls_proxy.py).
STREAM_RECORDER_HLS_FILTER = env_bool("STREAM_RECORDER_HLS_FILTER", True)
# When on, creating a broadcast session requires target_module_id (enable once the UI sends it).
REALTIME_BROADCAST_REQUIRE_TARGET_MODULE = env_bool("REALTIME_BROADCAST_REQUIRE_TARGET_MODULE", False)
COURSE_HLS_SEGMENT_DURATION_SECONDS = max(2, env_int("COURSE_HLS_SEGMENT_DURATION_SECONDS", 4))
COURSE_HLS_KEYFRAME_INTERVAL_SECONDS = max(
    1,
    env_int("COURSE_HLS_KEYFRAME_INTERVAL_SECONDS", COURSE_HLS_SEGMENT_DURATION_SECONDS),
)
COURSE_HLS_CRF = env_int("COURSE_HLS_CRF", 18)
_course_hls_x264_preset = env("COURSE_HLS_X264_PRESET", "slow").strip().lower()
COURSE_HLS_X264_PRESET = (
    _course_hls_x264_preset
    if _course_hls_x264_preset in {"ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"}
    else "medium"
)
SECURITY_BLOCK_SUSPICIOUS_INPUT = env_bool("SECURITY_BLOCK_SUSPICIOUS_INPUT", True)
SECURITY_MAX_INSPECTION_BODY_BYTES = env_int("SECURITY_MAX_INSPECTION_BODY_BYTES", 16384)
AUTH_LOGIN_MAX_FAILURES = env_int("AUTH_LOGIN_MAX_FAILURES", 10)
AUTH_LOGIN_LOCKOUT_SECONDS = env_int("AUTH_LOGIN_LOCKOUT_SECONDS", 3600)
AUTH_CONCURRENT_SESSION_EMAILS = env_list("AUTH_CONCURRENT_SESSION_EMAILS", [])
# Devices a student may stay signed in on; signing in on one more signs out the
# least recently used. Instructors, staff and the list above are unlimited.
MAX_CONCURRENT_SESSIONS_PER_STUDENT = max(1, env_int("MAX_CONCURRENT_SESSIONS_PER_STUDENT", 2))
AUTH_REFRESH_REUSE_GRACE_SECONDS = env_int("AUTH_REFRESH_REUSE_GRACE_SECONDS", 60)
ACCOUNT_SELF_SERVICE_CREDENTIALS_ENABLED = env_bool("ACCOUNT_SELF_SERVICE_CREDENTIALS_ENABLED", False)
COURSE_LIST_CACHE_TTL_SECONDS = env_int("COURSE_LIST_CACHE_TTL_SECONDS", 60)
COURSE_DETAIL_CACHE_TTL_SECONDS = env_int("COURSE_DETAIL_CACHE_TTL_SECONDS", 60)
LIVE_CLASS_LIST_CACHE_TTL_SECONDS = env_int("LIVE_CLASS_LIST_CACHE_TTL_SECONDS", 30)
DATA_UPLOAD_MAX_MEMORY_SIZE = env_int("DATA_UPLOAD_MAX_MEMORY_SIZE", 2621440)
FILE_UPLOAD_MAX_MEMORY_SIZE = env_int("FILE_UPLOAD_MAX_MEMORY_SIZE", 2621440)
MAX_VIDEO_UPLOAD_BYTES = env_int("MAX_VIDEO_UPLOAD_BYTES", 5368709120)
DATA_UPLOAD_MAX_NUMBER_FIELDS = env_int("DATA_UPLOAD_MAX_NUMBER_FIELDS", 1000)
TRUST_X_FORWARDED_FOR = env_bool("TRUST_X_FORWARDED_FOR", not DEBUG)
# Internal proxy hops (the nginx gateway) that append to X-Forwarded-For after
# host nginx records the real client; see config.client_ip.resolve_client_ip.
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
REALTIME_DEFAULT_MAX_AUDIENCE = env_int("REALTIME_DEFAULT_MAX_AUDIENCE", 500)
REALTIME_JOIN_TOKEN_TTL_SECONDS = env_int("REALTIME_JOIN_TOKEN_TTL_SECONDS", 10800)
REALTIME_SESSION_LIST_CACHE_TTL_SECONDS = env_int("REALTIME_SESSION_LIST_CACHE_TTL_SECONDS", 10)
# Shared (all students) active-session rows, single-flight filled; and the
# hard cap on unpaginated list responses.
REALTIME_SESSION_LIST_SHARED_CACHE_TTL_SECONDS = env_int("REALTIME_SESSION_LIST_SHARED_CACHE_TTL_SECONDS", 4)
REALTIME_SESSION_LIST_MAX_ROWS = env_int("REALTIME_SESSION_LIST_MAX_ROWS", 200)
# How often the async worker persists OBS stream health (the only writer).
REALTIME_OBS_STREAM_HEALTH_INTERVAL_SECONDS = env_int("REALTIME_OBS_STREAM_HEALTH_INTERVAL_SECONDS", 5)
# Attendees may join a live session whatever the weekly clock says, but only for
# this many hours after it went live: a room the host never ended is abandoned,
# not a class. Managers are not bound. 0 disables the bound.
REALTIME_ATTENDEE_JOIN_MAX_LIVE_HOURS = env_int("REALTIME_ATTENDEE_JOIN_MAX_LIVE_HOURS", 6)
REALTIME_PARTICIPANT_COUNT_CACHE_TTL_SECONDS = env_int("REALTIME_PARTICIPANT_COUNT_CACHE_TTL_SECONDS", 5)
REALTIME_ENROLLMENT_ACCESS_CACHE_TTL_SECONDS = env_int("REALTIME_ENROLLMENT_ACCESS_CACHE_TTL_SECONDS", 10)
REALTIME_BROADCAST_URL_CACHE_TTL_SECONDS = env_int("REALTIME_BROADCAST_URL_CACHE_TTL_SECONDS", 15)
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
ASYNC_PAYMENT_PROVISION_MAX_ATTEMPTS = env_int(
    "ASYNC_PAYMENT_PROVISION_MAX_ATTEMPTS", 8
)
# --- apps.core reliability building blocks (see apps/core/README.md) ---
# Idempotency-Key storage for unsafe API calls.
IDEMPOTENCY_KEY_TTL_SECONDS = env_int("IDEMPOTENCY_KEY_TTL_SECONDS", 86400)
IDEMPOTENCY_LEASE_SECONDS = env_int("IDEMPOTENCY_LEASE_SECONDS", 60)
# Transactional outbox, drained by process_async_jobs.
OUTBOX_DEFAULT_MAX_ATTEMPTS = env_int("OUTBOX_DEFAULT_MAX_ATTEMPTS", 8)
OUTBOX_LOCK_TIMEOUT_SECONDS = env_int("OUTBOX_LOCK_TIMEOUT_SECONDS", 300)
OUTBOX_BACKOFF_BASE_SECONDS = env_int("OUTBOX_BACKOFF_BASE_SECONDS", 15)
OUTBOX_MAX_BACKOFF_SECONDS = env_int("OUTBOX_MAX_BACKOFF_SECONDS", 3600)
OUTBOX_RETENTION_DAYS = env_int("OUTBOX_RETENTION_DAYS", 14)
# Outbound HTTP (apps.core.http) and per-upstream circuit breakers.
OUTBOUND_HTTP_DEFAULT_TIMEOUT_SECONDS = max(1, env_int("OUTBOUND_HTTP_DEFAULT_TIMEOUT_SECONDS", 5))
CIRCUIT_BREAKER_DEFAULTS = {
    "failure_threshold": max(1, env_int("CIRCUIT_BREAKER_FAILURE_THRESHOLD", 5)),
    "failure_window_seconds": max(5, env_int("CIRCUIT_BREAKER_FAILURE_WINDOW_SECONDS", 60)),
    "open_seconds": max(1, env_int("CIRCUIT_BREAKER_OPEN_SECONDS", 30)),
    "probe_timeout_seconds": max(1, env_int("CIRCUIT_BREAKER_PROBE_TIMEOUT_SECONDS", 15)),
}
# Named upstreams are listed (state shown on /health/ready) even before first use.
CIRCUIT_BREAKERS = {
    "owncast": {"open_seconds": 15},
    "livekit": {},
    "razorpay": {"failure_threshold": 3, "open_seconds": 60},
    "prometheus": {},
    # ClamAV (report uploads). Uploads fail closed while it is open.
    "clamd": {"failure_threshold": 3, "open_seconds": 30},
    # Public YouTube feed / live page for the website (apps.site_media). Fail soft.
    "youtube": {"failure_threshold": 3, "open_seconds": 120},
}
# Website YouTube section (apps.site_media.youtube): cache windows and timeouts.
YOUTUBE_FEED_CACHE_SECONDS = max(60, env_int("YOUTUBE_FEED_CACHE_SECONDS", 900))
YOUTUBE_LIVE_CACHE_SECONDS = max(15, env_int("YOUTUBE_LIVE_CACHE_SECONDS", 60))
YOUTUBE_FEED_TIMEOUT_SECONDS = max(1, env_int("YOUTUBE_FEED_TIMEOUT_SECONDS", 4))
YOUTUBE_LIVE_TIMEOUT_SECONDS = max(1, env_int("YOUTUBE_LIVE_TIMEOUT_SECONDS", 5))
YOUTUBE_LIVE_CHECK_ENABLED = env_bool("YOUTUBE_LIVE_CHECK_ENABLED", True)
# Readiness probe memo and MEDIA_ROOT disk thresholds.
HEALTH_READINESS_CACHE_SECONDS = env_int("HEALTH_READINESS_CACHE_SECONDS", 3)
HEALTH_MEDIA_MIN_FREE_BYTES = env_int("HEALTH_MEDIA_MIN_FREE_BYTES", 512 * 1024 * 1024)
HEALTH_MEDIA_WARN_FREE_BYTES = env_int("HEALTH_MEDIA_WARN_FREE_BYTES", 5 * 1024 * 1024 * 1024)
# Soft readiness probes: dotted callables returning (state, details). A state
# other than "ok" is reported under upstreams/warnings but never fails readiness.
HEALTH_SOFT_PROBES = {"clamd": "apps.reports.antivirus.readiness_probe"}
# --- Weekly report submissions (apps.reports) ---
# Private storage for submitted report files. It must NOT be inside MEDIA_ROOT:
# the nginx media container serves everything under MEDIA_ROOT publicly. On the
# Hostinger VPS it is the host directory /srv/streamx/reports (a noexec,nosuid,
# nodev bind mount) mounted at /app/private_media in the backend and worker
# containers only; files leave only through the authenticated download views.
# See apps/reports/SECURITY.md.
REPORTS_PRIVATE_ROOT = env("REPORTS_PRIVATE_ROOT", str(BASE_DIR / "private_media")).strip() or str(
    BASE_DIR / "private_media"
)
# Stored files a later re-scan finds infected are moved here (mode 000), never
# deleted automatically. Its own host directory (/srv/streamx/reports-quarantine).
REPORTS_QUARANTINE_ROOT = env("REPORTS_QUARANTINE_ROOT", str(BASE_DIR / "private_quarantine")).strip() or str(
    BASE_DIR / "private_quarantine"
)
# --- Resumable class recording uploads (apps.recording_uploads) ---
# Chunks are staged in a private directory, by default inside the noexec
# report volume (/app/private_media/.recording-uploads on the VPS), never
# under MEDIA_ROOT. See apps/recording_uploads/config.py for every knob.
RECORDING_UPLOAD_STAGING_ROOT = env("RECORDING_UPLOAD_STAGING_ROOT", "").strip() or str(
    Path(REPORTS_PRIVATE_ROOT) / ".recording-uploads"
)
RECORDING_UPLOAD_CHUNK_BYTES = env_int("RECORDING_UPLOAD_CHUNK_BYTES", 32 * 1024 * 1024)
RECORDING_UPLOAD_MAX_BYTES = env_int("RECORDING_UPLOAD_MAX_BYTES", 8 * 1024 * 1024 * 1024)
RECORDING_UPLOAD_EXPIRY_HOURS = env_int("RECORDING_UPLOAD_EXPIRY_HOURS", 48)
RECORDING_UPLOAD_MAX_ACTIVE_PER_USER = env_int("RECORDING_UPLOAD_MAX_ACTIVE_PER_USER", 3)
RECORDING_UPLOAD_MIN_FREE_BYTES = env_int("RECORDING_UPLOAD_MIN_FREE_BYTES", 2 * 1024 * 1024 * 1024)
RECORDING_UPLOAD_REVERT_RETENTION_DAYS = env_int("RECORDING_UPLOAD_REVERT_RETENTION_DAYS", 14)
RECORDING_UPLOAD_MEDIA_RUNNER = env("RECORDING_UPLOAD_MEDIA_RUNNER", "").strip()
# Hard ceilings an instructor cannot exceed when configuring a task.
REPORTS_MAX_FILE_SIZE_MB_CAP = max(1, env_int("REPORTS_MAX_FILE_SIZE_MB_CAP", 200))
REPORTS_MAX_FILES_CAP = max(1, env_int("REPORTS_MAX_FILES_CAP", 20))
# Uploads are refused (507) while the private volume has less free space than
# this plus twice the incoming file.
REPORTS_MIN_FREE_BYTES = max(0, env_int("REPORTS_MIN_FREE_BYTES", 1024 * 1024 * 1024))
# Obsidian vault .zip limits (inspected in memory, never extracted).
REPORTS_ZIP_MAX_ENTRIES = max(1, env_int("REPORTS_ZIP_MAX_ENTRIES", 2000))
REPORTS_ZIP_MAX_UNCOMPRESSED_BYTES = max(1, env_int("REPORTS_ZIP_MAX_UNCOMPRESSED_BYTES", 500 * 1024 * 1024))
REPORTS_ZIP_MAX_RATIO = max(1, env_int("REPORTS_ZIP_MAX_RATIO", 100))
# Staged (uploaded but never submitted) files are deleted after this many hours.
REPORTS_STAGED_UPLOAD_TTL_HOURS = max(1, env_int("REPORTS_STAGED_UPLOAD_TTL_HOURS", 48))
# Antivirus (apps.reports.antivirus). Every report, reference and feedback file
# is scanned before it is stored; any scanner problem rejects the upload (fail
# closed). "clamd" = the ClamAV daemon below (production default, prod.py);
# "fake" = in-process marker scanner for tests and local development (flags the
# EICAR test string and STREAMX-TEST-VIRUS markers); "off" refuses every upload;
# anything else is the dotted path of a scanner class. reports.E001 refuses to
# start production with anything but "clamd".
REPORTS_ANTIVIRUS_SCANNER = env("REPORTS_ANTIVIRUS_SCANNER", "fake").strip() or "off"
CLAMD_HOST = (env("CLAMD_HOST", "") or env("REPORTS_CLAMD_HOST", "") or "clamav").strip()
CLAMD_PORT = env_int("CLAMD_PORT", env_int("REPORTS_CLAMD_PORT", 3310))
# TCP connect timeout, and the per-read/write timeout while streaming and
# waiting for the verdict (a 200 MB file takes well under a minute; clamd may
# also pause scans for a few seconds while it reloads its signatures).
CLAMD_CONNECT_TIMEOUT_SECONDS = max(1, env_int("CLAMD_CONNECT_TIMEOUT_SECONDS", 5))
CLAMD_TIMEOUT_SECONDS = max(5, env_int("CLAMD_TIMEOUT_SECONDS", 120))
# Never stream more than this to clamd; must stay below clamd's StreamMaxLength
# (220M in infra/hostinger/clamav/clamd.conf) and above the largest report file.
CLAMD_STREAM_MAX_BYTES = max(1, env_int("CLAMD_STREAM_MAX_BYTES", 210 * 1024 * 1024))
CLAMD_CHUNK_BYTES = min(max(4096, env_int("CLAMD_CHUNK_BYTES", 256 * 1024)), 8 * 1024 * 1024)
# Stored files are re-scanned with fresh signatures this often (process_async_jobs).
REPORTS_RESCAN_INTERVAL_HOURS = max(1, env_int("REPORTS_RESCAN_INTERVAL_HOURS", 24))
REPORTS_RESCAN_BATCH_SIZE = max(1, env_int("REPORTS_RESCAN_BATCH_SIZE", 200))
# Late-submission digest for the course instructor: one notification per task
# per window instead of one per late upload.
REPORTS_LATE_DIGEST_WINDOW_MINUTES = max(5, env_int("REPORTS_LATE_DIGEST_WINDOW_MINUTES", 60))
WEB_PUSH_ENABLED = env_bool("WEB_PUSH_ENABLED", False)
WEB_PUSH_VAPID_PUBLIC_KEY = env("WEB_PUSH_VAPID_PUBLIC_KEY", "").strip()
WEB_PUSH_VAPID_PRIVATE_KEY = env("WEB_PUSH_VAPID_PRIVATE_KEY", "").strip()
WEB_PUSH_VAPID_SUBJECT = env("WEB_PUSH_VAPID_SUBJECT", "mailto:support@alsyedinitiative.com").strip()
ENROLLMENT_REQUEST_WHATSAPP_ADMIN_NUMBER = env("ENROLLMENT_REQUEST_WHATSAPP_ADMIN_NUMBER", "").strip()
ENROLLMENT_REQUEST_WHATSAPP_WEBHOOK_URL = env("ENROLLMENT_REQUEST_WHATSAPP_WEBHOOK_URL", "").strip()
ENROLLMENT_REQUEST_WHATSAPP_WEBHOOK_TOKEN = env("ENROLLMENT_REQUEST_WHATSAPP_WEBHOOK_TOKEN", "").strip()

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
OWNCAST_DEFAULT_STREAM_PATH = env("OWNCAST_DEFAULT_STREAM_PATH", "/embed/video/")
OWNCAST_DEFAULT_CHAT_PATH = env("OWNCAST_DEFAULT_CHAT_PATH", "/embed/chat/readwrite")
OWNCAST_STREAM_KEY = env("OWNCAST_STREAM_KEY", "")
OWNCAST_RTMP_TARGET = env("OWNCAST_RTMP_TARGET", "")
OWNCAST_OBS_STREAM_SERVER_URL = env("OWNCAST_OBS_STREAM_SERVER_URL", "")
OWNCAST_ADMIN_API_BASE_URL = env("OWNCAST_ADMIN_API_BASE_URL", "http://owncast:8080")
OWNCAST_ADMIN_USERNAME = env("OWNCAST_ADMIN_USERNAME", "admin")
OWNCAST_ADMIN_PASSWORD = env("OWNCAST_ADMIN_PASSWORD", "")
# Shared secret for the host ops agent that applies server resource profiles.
# Empty disables the internal endpoints.
OPS_AGENT_TOKEN = env("OPS_AGENT_TOKEN", "").strip()
# Prometheus HTTP API queried server-side by the admin dashboard. It is never
# exposed to the browser. An empty URL disables the infrastructure sections.
PROMETHEUS_URL = env("PROMETHEUS_URL", "http://prometheus:9090").strip().rstrip("/")
PROMETHEUS_TIMEOUT_SECONDS = max(1, env_int("PROMETHEUS_TIMEOUT_SECONDS", 4))
OWNCAST_ROTATE_STREAM_KEY_ON_STOP = env_bool("OWNCAST_ROTATE_STREAM_KEY_ON_STOP", False)
OWNCAST_CHAT_BRIDGE_ENABLED = env_bool("OWNCAST_CHAT_BRIDGE_ENABLED", False)
OWNCAST_CHAT_BRIDGE_TTL_SECONDS = env_int("OWNCAST_CHAT_BRIDGE_TTL_SECONDS", 10800)
OWNCAST_CHAT_REQUIRE_AUTHENTICATION = env_bool("OWNCAST_CHAT_REQUIRE_AUTHENTICATION", False)
OWNCAST_STREAM_ACCESS_TTL_SECONDS = env_int("OWNCAST_STREAM_ACCESS_TTL_SECONDS", OWNCAST_CHAT_BRIDGE_TTL_SECONDS)
OWNCAST_STREAM_ACCESS_COOKIE_NAME = env("OWNCAST_STREAM_ACCESS_COOKIE_NAME", "owncast_stream_access").strip()
REALTIME_OWNCAST_STREAM_AUTH_CACHE_TTL_SECONDS = env_int(
    "REALTIME_OWNCAST_STREAM_AUTH_CACHE_TTL_SECONDS",
    15,
)
REALTIME_OWNCAST_OFFLINE_GRACE_SECONDS = env_int("REALTIME_OWNCAST_OFFLINE_GRACE_SECONDS", 45)
# Owncast /api/status is cached and fetched single-flight across workers, so a
# class joining at once costs one Owncast call per TTL window.
REALTIME_OWNCAST_STATUS_CACHE_TTL_SECONDS = env_int("REALTIME_OWNCAST_STATUS_CACHE_TTL_SECONDS", 3)
REALTIME_OWNCAST_STATUS_TIMEOUT_SECONDS = env_int("REALTIME_OWNCAST_STATUS_TIMEOUT_SECONDS", 3)
# Host Studio heartbeat: how often LiveKit is asked about the broadcast egress,
# and how many automatic restarts of a dead egress are allowed per 10 minutes.
REALTIME_HOST_EGRESS_CHECK_INTERVAL_SECONDS = env_int("REALTIME_HOST_EGRESS_CHECK_INTERVAL_SECONDS", 10)
REALTIME_HOST_EGRESS_MAX_AUTO_RESTARTS = env_int("REALTIME_HOST_EGRESS_MAX_AUTO_RESTARTS", 5)
LIVEKIT_EGRESS_STATUS_TIMEOUT_SECONDS = env_int("LIVEKIT_EGRESS_STATUS_TIMEOUT_SECONDS", 5)
LIVEKIT_EGRESS_LAYOUT = env("LIVEKIT_EGRESS_LAYOUT", "speaker-dark")
LIVEKIT_EGRESS_TWIRP_TIMEOUT_SECONDS = env_int("LIVEKIT_EGRESS_TWIRP_TIMEOUT_SECONDS", 60)

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


# --- Phase 2: live-class lifecycle (apps/realtime/lifecycle.py, reconciler.py) ---
# LIVE_RECONCILER_MODE: off | shadow | enforce. "shadow" only logs the
# transitions the reconciler would make; "enforce" applies them. Production
# starts in shadow (backend/.env.example); the test suite runs in enforce.
import sys as _phase2_sys  # noqa: E402

_PHASE2_RUNNING_TESTS = len(_phase2_sys.argv) > 1 and _phase2_sys.argv[1] == "test"
LIVE_RECONCILER_MODE = env("LIVE_RECONCILER_MODE", "enforce" if _PHASE2_RUNNING_TESTS else "shadow").strip().lower()
LIVE_RECONCILER_INTERVAL_SECONDS = max(2, env_int("LIVE_RECONCILER_INTERVAL_SECONDS", 5))
# Host Studio heartbeat freshness (Redis TTL) and the reconnect grace period
# before an interrupted stream is declared stopped.
REALTIME_HOST_HEARTBEAT_TTL_SECONDS = max(10, env_int("REALTIME_HOST_HEARTBEAT_TTL_SECONDS", 30))
REALTIME_HOST_GRACE_SECONDS = max(10, env_int("REALTIME_HOST_GRACE_SECONDS", 60))
# A live class whose feed has been gone (and whose host has been silent) this
# long is ended automatically. Classes that never went live end after the
# attendee bound (REALTIME_ATTENDEE_JOIN_MAX_LIVE_HOURS, default 6 h).
REALTIME_ABANDONED_END_MINUTES = max(1, env_int("REALTIME_ABANDONED_END_MINUTES", 20))
REALTIME_STREAM_STARTING_TIMEOUT_SECONDS = max(30, env_int("REALTIME_STREAM_STARTING_TIMEOUT_SECONDS", 180))
REALTIME_EGRESS_RESTART_BACKOFF_SECONDS = max(1, env_int("REALTIME_EGRESS_RESTART_BACKOFF_SECONDS", 5))
# Go Live returns 202 and a worker starts the egress (POST .../go-live/).
REALTIME_ASYNC_GO_LIVE = env_bool("REALTIME_ASYNC_GO_LIVE", True)
# Calendar-aware server resource profile (broadcast before/while a class,
# content 10 min after). Off by default: the owner turns it on after the
# shadow weekends.
REALTIME_AUTO_RESOURCE_PROFILE = env_bool("REALTIME_AUTO_RESOURCE_PROFILE", False)
# Off under `manage.py test` so suites never probe real services in the T-10 window.
REALTIME_PRECLASS_PROBE_ENABLED = env_bool("REALTIME_PRECLASS_PROBE_ENABLED", not _PHASE2_RUNNING_TESTS)
# Egress health port (egress.yaml health_port; shares LiveKit's network namespace).
LIVEKIT_EGRESS_HEALTH_URL = env("LIVEKIT_EGRESS_HEALTH_URL", "").strip()
# Process liveness file for the async worker healthcheck (written every ~10 s).
WORKER_HEARTBEAT_FILE = env("WORKER_HEARTBEAT_FILE", "").strip()
# --- end Phase 2 live-class lifecycle ---


# --- Phase 2: no-click automatic class recordings (apps/realtime/recording) ---
# Record every broadcast (OBS and Host Studio both reach Owncast) with the
# server recorder; no Start/Stop Recording button exists any more.
RECORDING_AUTO_ALL_BROADCASTS = env_bool("RECORDING_AUTO_ALL_BROADCASTS", True)
# STREAM_RECORDER_ENABLED (above) follows RECORDING_AUTO_ALL_BROADCASTS unless
# it is set explicitly in the environment.
import os as _phase2_rec_os  # noqa: E402

if "STREAM_RECORDER_ENABLED" not in _phase2_rec_os.environ:
    STREAM_RECORDER_ENABLED = RECORDING_AUTO_ALL_BROADCASTS
# Meetings: a LiveKit room-composite egress starts when the meeting goes live
# and is stopped and published when it ends (recording.reconcile, 30 s).
# OFF by default and in every shipped env example: a meeting records students'
# cameras and microphones, and the owner decision is that meetings are never
# auto-recorded (broadcasts only). If a deployment ever turns it on, the meeting
# room shows "This meeting is being recorded" to its hosts and every meeting
# recording is held unpublished and flagged "needs review" for an admin.
RECORDING_AUTO_MEETINGS = env_bool("RECORDING_AUTO_MEETINGS", False)
RECORDING_RECONCILE_INTERVAL_SECONDS = max(10, env_int("RECORDING_RECONCILE_INTERVAL_SECONDS", 30))
# Only egress/browser recordings that completed this recently are picked up
# automatically (older ones stay for the admin "Scan" review).
RECORDING_RECONCILE_LOOKBACK_HOURS = max(1, env_int("RECORDING_RECONCILE_LOOKBACK_HOURS", 24))
# Publish the faststart MP4 as soon as finalize completes; HLS follows.
RECORDING_INSTANT_PUBLISH = env_bool("RECORDING_INSTANT_PUBLISH", True)
# Section auto-created in the class's course when no module can be derived.
RECORDING_AUTO_MODULE_TITLE = env("RECORDING_AUTO_MODULE_TITLE", "Class recordings").strip() or "Class recordings"
# Feed offline this long -> the take is finalized (one take per class).
STREAM_RECORDER_IDLE_FINALIZE_SECONDS = max(60, env_int("STREAM_RECORDER_IDLE_FINALIZE_SECONDS", 900))
# "Stop Live" without "End": wait this long for a restart (same take) before
# finalizing. 0 = finalize on Stop immediately (pre-Phase-2 behaviour).
STREAM_RECORDER_STOP_GRACE_SECONDS = max(0, env_int("STREAM_RECORDER_STOP_GRACE_SECONDS", 600))
# Failed recordings retry automatically (attempt n waits RETRY_BACKOFF[n]).
RECORDING_AUTO_RETRY_MAX = max(0, env_int("RECORDING_AUTO_RETRY_MAX", 3))
RECORDING_AUTO_RETRY_BACKOFF_SECONDS = env("RECORDING_AUTO_RETRY_BACKOFF_SECONDS", "300,1800,7200").strip()
# Periodic import scan in the stream recorder (0 disables); unclaimed egress
# files of classes that never got a recording are published automatically.
RECORDING_IMPORT_SCAN_INTERVAL_SECONDS = max(0, env_int("RECORDING_IMPORT_SCAN_INTERVAL_SECONDS", 3600))
RECORDING_IMPORT_AUTO_PUBLISH = env_bool("RECORDING_IMPORT_AUTO_PUBLISH", True)
# Admin alerts (in-app notification + ERROR log line) for failed/stuck recordings.
RECORDING_ALERTS_ENABLED = env_bool("RECORDING_ALERTS_ENABLED", True)
RECORDING_PROCESSING_ALERT_SECONDS = max(600, env_int("RECORDING_PROCESSING_ALERT_SECONDS", 6 * 3600))
RECORDING_FINALIZING_ALERT_SECONDS = max(300, env_int("RECORDING_FINALIZING_ALERT_SECONDS", 3600))
RECORDING_HEARTBEAT_ALERT_SECONDS = max(60, env_int("RECORDING_HEARTBEAT_ALERT_SECONDS", 180))
# Nightly canary: the stream recorder runs `verify_recording_pipeline` in a
# subprocess at this local hour when no class is being recorded.
RECORDING_CANARY_ENABLED = env_bool("RECORDING_CANARY_ENABLED", True)
RECORDING_CANARY_HOUR = min(23, max(0, env_int("RECORDING_CANARY_HOUR", 3)))
# Liveness file the stream recorder touches every loop (compose healthcheck).
STREAM_RECORDER_HEARTBEAT_FILE = env("STREAM_RECORDER_HEARTBEAT_FILE", "").strip()
# Transcoder (transcode_lecture_streams --pending): one ffmpeg pass for every
# rendition, faster preset, hard timeout, retries with backoff, blue/green HLS.
COURSE_HLS_SINGLE_PASS = env_bool("COURSE_HLS_SINGLE_PASS", True)
COURSE_HLS_SINGLE_PASS_PRESET = env("COURSE_HLS_SINGLE_PASS_PRESET", "veryfast").strip().lower() or "veryfast"
COURSE_HLS_SINGLE_PASS_CRF = min(30, max(16, env_int("COURSE_HLS_SINGLE_PASS_CRF", 23)))
# Top rendition by stream copy when the source is already H.264 at that size.
COURSE_HLS_TOP_RUNG_COPY = env_bool("COURSE_HLS_TOP_RUNG_COPY", False)
COURSE_HLS_TRANSCODE_TIMEOUT_BASE_SECONDS = max(60, env_int("COURSE_HLS_TRANSCODE_TIMEOUT_BASE_SECONDS", 600))
COURSE_HLS_TRANSCODE_TIMEOUT_FACTOR = float(env("COURSE_HLS_TRANSCODE_TIMEOUT_FACTOR", "3") or 3)
COURSE_HLS_TRANSCODE_MAX_TIMEOUT_SECONDS = max(600, env_int("COURSE_HLS_TRANSCODE_MAX_TIMEOUT_SECONDS", 6 * 3600))
COURSE_HLS_MAX_ATTEMPTS = max(1, env_int("COURSE_HLS_MAX_ATTEMPTS", 5))
COURSE_HLS_RETRY_BACKOFF_SECONDS = env("COURSE_HLS_RETRY_BACKOFF_SECONDS", "60,300,1800,7200").strip()
# Old HLS revisions are kept this long after a swap (viewers mid-playback).
COURSE_HLS_REVISION_GRACE_SECONDS = max(0, env_int("COURSE_HLS_REVISION_GRACE_SECONDS", 86400))
TRANSCODER_HEARTBEAT_FILE = env("TRANSCODER_HEARTBEAT_FILE", "").strip()
# --- end Phase 2 no-click recordings ---
# --- Phase 3 self-service weekly reports (apps.reports) ---
# Weeks, deadlines and late windows are computed in this zone (IST).
REPORTS_TIME_ZONE = env("REPORTS_TIME_ZONE", "Asia/Kolkata").strip() or "Asia/Kolkata"
# reports.scheduler: reminders, grader digest, SLA alert, automatic marks release.
REPORTS_SCHEDULER_ENABLED = env_bool("REPORTS_SCHEDULER_ENABLED", True)
REPORTS_SCHEDULER_INTERVAL_SECONDS = max(60, env_int("REPORTS_SCHEDULER_INTERVAL_SECONDS", 300))
REPORTS_GRADER_DIGEST_HOUR = min(23, max(0, env_int("REPORTS_GRADER_DIGEST_HOUR", 9)))
REPORTS_GRADING_SLA_HOURS = max(1, env_int("REPORTS_GRADING_SLA_HOURS", 72))
# Seconds a student can take back a first submission (the UI shows a 10 s Undo).
REPORTS_UNDO_SECONDS = max(0, env_int("REPORTS_UNDO_SECONDS", 15))
# One OpenAPI name for the "this week / last week" choice used by two serializers.
SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"]["ReportWeekWhichEnum"] = "apps.reports.serializers.WEEK_WHICH_CHOICES"
# --- end Phase 3 self-service weekly reports ---

# --- UI overhaul (plan §5.1, §4.4, §4.5; frozen after WS-0) ---
# Feature switches (apps.core.features). Both are JSON objects of
# {"<key>": true|false} read from the environment:
#   FEATURE_FORCE              emergency lock; the admin switch shows "Locked by
#                              server configuration" and cannot change it.
#                              Rollback without a deploy: FEATURE_FORCE='{"teaching": true}'.
#   FEATURE_DEFAULT_OVERRIDES  replaces registry defaults (no admin override stored).
# Production default: {} so "teaching" (Teachers section) starts OFF. Under
# `manage.py test` the default is {"teaching": true} so suites that act as
# instructors keep passing; tests that need production behaviour use
# override_settings(FEATURE_DEFAULT_OVERRIDES={}).
import json as _ui_json  # noqa: E402


def _ui_json_flags(name, default):
    raw = env(name, "")
    if raw is None or not str(raw).strip():
        return dict(default)
    try:
        value = _ui_json.loads(raw)
    except ValueError:
        logging.getLogger("config.settings").warning("%s is not valid JSON; ignoring it.", name)
        return dict(default)
    if not isinstance(value, dict):
        logging.getLogger("config.settings").warning("%s must be a JSON object; ignoring it.", name)
        return dict(default)
    return {str(key): bool(flag) for key, flag in value.items()}


FEATURE_FORCE = _ui_json_flags("FEATURE_FORCE", {})
FEATURE_DEFAULT_OVERRIDES = _ui_json_flags(
    "FEATURE_DEFAULT_OVERRIDES", {"teaching": True} if _PHASE2_RUNNING_TESTS else {}
)
# Shared snapshot cache (Redis) and the per-process memo in front of it: a flip
# reaches every worker within ~FEATURE_PROCESS_MEMO_SECONDS.
FEATURE_SNAPSHOT_CACHE_KEY = "features:snapshot:v1"
FEATURE_SNAPSHOT_CACHE_SECONDS = max(1, env_int("FEATURE_SNAPSHOT_CACHE_SECONDS", 300))
FEATURE_PROCESS_MEMO_SECONDS = max(0, env_int("FEATURE_PROCESS_MEMO_SECONDS", 2))
# Admin "needs attention" queues (GET /api/admin/attention/ and the Django index).
ADMIN_ATTENTION_CACHE_SECONDS = max(0, env_int("ADMIN_ATTENTION_CACHE_SECONDS", 30))
# Command palette record search (GET /api/admin/search/?q=).
ADMIN_SEARCH_MIN_CHARS = max(1, env_int("ADMIN_SEARCH_MIN_CHARS", 2))
ADMIN_SEARCH_GROUP_LIMIT = max(1, env_int("ADMIN_SEARCH_GROUP_LIMIT", 5))
# Where staff land after sign-in (owner decision D3).
CONSOLE_STAFF_HOME = (env("CONSOLE_STAFF_HOME", "/console/admin") or "").strip() or "/console/admin"
# Back-office product name (owner decision D9).
ADMIN_SITE_NAME = (env("ADMIN_SITE_NAME", "Al Syed Admin") or "").strip() or "Al Syed Admin"
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"].update(
    {
        # Console Home / Admin home / capabilities: polled about once a minute per tab.
        "console_read": env("CONSOLE_READ_RATE", "600/minute"),
        "admin_search": env("ADMIN_SEARCH_RATE", "240/minute"),
        "admin_action": env("ADMIN_ACTION_RATE", "1200/hour"),
        "feature_write": env("FEATURE_WRITE_RATE", "60/hour"),
    }
)
# --- end UI overhaul ---

# --- Engagement (apps.engagement: XP, streaks, badges, leaderboards) ---
INSTALLED_APPS += ["apps.engagement.apps.EngagementConfig"]
# Adds X-Engagement ({xp, level, streak, pending_xp}) to responses of requests
# that queued an XP-earning event; every other request pays one contextvar set.
MIDDLEWARE += ["apps.engagement.middleware.EngagementSnapshotMiddleware"]
CORS_EXPOSE_HEADERS = [*CORS_EXPOSE_HEADERS, "X-Engagement"]
ENGAGEMENT_READ_RATE = env("ENGAGEMENT_READ_RATE", "240/minute")
ENGAGEMENT_WRITE_RATE = env("ENGAGEMENT_WRITE_RATE", "30/minute")
ENGAGEMENT_PRESENCE_RATE = env("ENGAGEMENT_PRESENCE_RATE", "12/minute")
ENGAGEMENT_PUBLIC_RATE = env("ENGAGEMENT_PUBLIC_RATE", "60/minute")
ENGAGEMENT_STAFF_RATE = env("ENGAGEMENT_STAFF_RATE", "600/hour")
# XP economy v2 (owner rules A/B; defaults and meaning in apps/engagement/rules.py).
# Empty = the rules.py default. Read at call time, so a restart applies a change.
ENGAGEMENT_LIVE_PRESENT_XP = env("ENGAGEMENT_LIVE_PRESENT_XP", "")  # 150
ENGAGEMENT_LIVE_PARTIAL_XP = env("ENGAGEMENT_LIVE_PARTIAL_XP", "")  # 30
ENGAGEMENT_FIRST_LIVE_BONUS_XP = env("ENGAGEMENT_FIRST_LIVE_BONUS_XP", "")  # 100
ENGAGEMENT_PURCHASE_XP_PER_RUPEE = env("ENGAGEMENT_PURCHASE_XP_PER_RUPEE", "")  # 0.5
ENGAGEMENT_ONE_TIME_PURCHASE_XP_CAP = env("ENGAGEMENT_ONE_TIME_PURCHASE_XP_CAP", "")  # 1000 per payment
ENGAGEMENT_SUBSCRIPTION_XP_CAP = env("ENGAGEMENT_SUBSCRIPTION_XP_CAP", "")  # 0 = no cap
ENGAGEMENT_WEEKLY_FIRST_XP = env("ENGAGEMENT_WEEKLY_FIRST_XP", "")  # 200
ENGAGEMENT_WEEKLY_PODIUM_XP = env("ENGAGEMENT_WEEKLY_PODIUM_XP", "")  # 120 (#2-3)
ENGAGEMENT_WEEKLY_TOP10_XP = env("ENGAGEMENT_WEEKLY_TOP10_XP", "")  # 60 (#4-10)
ENGAGEMENT_MONTHLY_TOP10_XP = env("ENGAGEMENT_MONTHLY_TOP10_XP", "")  # 100
ENGAGEMENT_STANDING_AWARDS = env_bool("ENGAGEMENT_STANDING_AWARDS", True)
ENGAGEMENT_LEADERBOARD_COUNT_PURCHASE_XP = env_bool("ENGAGEMENT_LEADERBOARD_COUNT_PURCHASE_XP", True)
# JSON list of 8 ascending integers from 0 (rank thresholds); empty = the documented curve.
ENGAGEMENT_LEVEL_THRESHOLDS = env("ENGAGEMENT_LEVEL_THRESHOLDS", "")
# Release day (owner's legacy plan, apps.engagement.legacy). ENGAGEMENT_RELEASE_AT is
# the launch moment (ISO with offset, e.g. 2026-12-01T00:00:00+05:30): streaks and the
# weekly leaderboard start from it, legacy students are those enrolled before it.
# Empty = no epoch (dev, tests).
ENGAGEMENT_RELEASE_AT = (env("ENGAGEMENT_RELEASE_AT", "") or "").strip()
ENGAGEMENT_LEGACY_ACTIVE_DAYS = max(1, env_int("ENGAGEMENT_LEGACY_ACTIVE_DAYS", 30))
ENGAGEMENT_FOUNDING_GLOW_DAYS = max(1, env_int("ENGAGEMENT_FOUNDING_GLOW_DAYS", 30))
# --- end Engagement ---
# Engagement and the Monthly CTF ship ON in production (registry defaults,
# owner decision: rewards from release day). Test runs pin both explicitly
# unless FEATURE_DEFAULT_OVERRIDES names them: engagement on, monthly_ctf off
# (the Monthly CTF suites turn it on per test), so a registry change never
# silently changes what the other suites exercise.
if _PHASE2_RUNNING_TESTS:
    FEATURE_DEFAULT_OVERRIDES.setdefault("engagement", True)
    FEATURE_DEFAULT_OVERRIDES.setdefault("monthly_ctf", False)
    # No release epoch under tests unless a test sets one (override_settings).
    ENGAGEMENT_RELEASE_AT = ""

# --- Catalogue, platform plans, memberships and labs access (WS catalog-plans) ---
INSTALLED_APPS += ["apps.osint_labs.apps.OsintLabsConfig"]
# Membership access continues this many days past a subscription's paid
# period (covers Razorpay's charge retries and late webhooks).
SUBSCRIPTION_GRACE_DAYS = max(0, env_int("SUBSCRIPTION_GRACE_DAYS", 3))
# Razorpay requires a total_count for every subscription.
MEMBERSHIP_TOTAL_COUNT_MONTHLY = max(1, env_int("MEMBERSHIP_TOTAL_COUNT_MONTHLY", 120))
MEMBERSHIP_TOTAL_COUNT_YEARLY = max(1, env_int("MEMBERSHIP_TOTAL_COUNT_YEARLY", 10))
# Labs site <-> LMS: HMAC secret shared with OSINTCTF/server.js (LABS_PASS_SECRET)
# for the short-lived labs pass. Empty = no pass can be issued (labs gating then
# refuses members-only content while "labs_membership_required" is on).
LABS_PASS_SECRET = env("LABS_PASS_SECRET", "")
LABS_PASS_TTL_SECONDS = max(60, env_int("LABS_PASS_TTL_SECONDS", 1800))
LABS_PUBLIC_URL = (env("LABS_PUBLIC_URL", "https://labs.alsyedinitiative.com") or "").strip().rstrip("/")
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"].update(
    {
        "catalog_read": env("CATALOG_READ_RATE", "600/minute"),
        "plan_checkout": env("PLAN_CHECKOUT_RATE", "20/hour"),
        "labs_pass": env("LABS_PASS_RATE", "120/hour"),
        "directory_write": env("DIRECTORY_WRITE_RATE", "120/hour"),
    }
)
# Purchase-gate tests turn "pentesting" off explicitly; every other suite keeps
# testing the purchase mechanics with it on (production default: off).
if _PHASE2_RUNNING_TESTS:
    FEATURE_DEFAULT_OVERRIDES.setdefault("pentesting", True)
# --- end catalog-plans ---

# --- Student profiles (apps.profiles: /u/<handle>, PII guard, moderation) ---
INSTALLED_APPS += ["apps.profiles.apps.ProfilesConfig"]
# Profile images live outside MEDIA_ROOT (default <REPORTS_PRIVATE_ROOT>/profiles)
# and leave only through /api/profiles/media/<id>/ after a permission check.
PROFILES_PRIVATE_ROOT = env("PROFILES_PRIVATE_ROOT", "")
PROFILES_IMAGE_MAX_BYTES = max(256 * 1024, env_int("PROFILES_IMAGE_MAX_BYTES", 8 * 1024 * 1024))
PROFILES_READ_RATE = env("PROFILES_READ_RATE", "240/minute")
PROFILES_WRITE_RATE = env("PROFILES_WRITE_RATE", "60/minute")
PROFILES_PUBLISH_RATE = env("PROFILES_PUBLISH_RATE", "30/hour")
PROFILES_UPLOAD_RATE = env("PROFILES_UPLOAD_RATE", "40/hour")
PROFILES_REPORT_RATE = env("PROFILES_REPORT_RATE", "10/hour")
PROFILES_PUBLIC_RATE = env("PROFILES_PUBLIC_RATE", "120/minute")
PROFILES_STAFF_RATE = env("PROFILES_STAFF_RATE", "600/hour")
# "public_profiles" ships ON in production (registry default, owner decision);
# test runs pin it on explicitly.
if _PHASE2_RUNNING_TESTS:
    FEATURE_DEFAULT_OVERRIDES.setdefault("public_profiles", True)
# --- end Student profiles ---

# --- Attendance & class calendar (apps.attendance) ---
INSTALLED_APPS += ["apps.attendance.apps.AttendanceConfig"]
# Present = at least this many minutes in the LIVE class (recordings never count).
# Admin-editable afterwards in Admin > Attendance rule; these seed that row.
ATTENDANCE_PRESENT_MIN_MINUTES = max(1, env_int("ATTENDANCE_PRESENT_MIN_MINUTES", 40))
# A class on air for less than the minutes above is a "short session": present =
# this share of its on-air time (flagged for staff).
ATTENDANCE_SHORT_SESSION_RATIO = float(env("ATTENDANCE_SHORT_SESSION_RATIO", "0.80") or 0.80)
ATTENDANCE_LOW_PERCENT = max(1, env_int("ATTENDANCE_LOW_PERCENT", 75))
ATTENDANCE_FLUSH_INTERVAL_SECONDS = max(15, env_int("ATTENDANCE_FLUSH_INTERVAL_SECONDS", 120))
ATTENDANCE_FINALIZE_DELAY_SECONDS = max(0, env_int("ATTENDANCE_FINALIZE_DELAY_SECONDS", 90))
ATTENDANCE_PRESENCE_RATE = env("ATTENDANCE_PRESENCE_RATE", "12/minute")
ATTENDANCE_READ_RATE = env("ATTENDANCE_READ_RATE", "240/minute")
ATTENDANCE_STAFF_RATE = env("ATTENDANCE_STAFF_RATE", "1200/hour")
ATTENDANCE_WRITE_RATE = env("ATTENDANCE_WRITE_RATE", "120/hour")
# Calendar: occurrences 30 days ahead; a RealtimeSession is created for a class
# starting within the lead time (kept short so the Live classes list stays tidy).
CALENDAR_HORIZON_DAYS = max(1, env_int("CALENDAR_HORIZON_DAYS", 30))
CALENDAR_SESSION_LEAD_HOURS = max(1, env_int("CALENDAR_SESSION_LEAD_HOURS", 24))
CALENDAR_MATERIALIZE_INTERVAL_SECONDS = max(60, env_int("CALENDAR_MATERIALIZE_INTERVAL_SECONDS", 600))
CALENDAR_FEED_RATE = env("CALENDAR_FEED_RATE", "120/hour")
CALENDAR_PUBLIC_RATE = env("CALENDAR_PUBLIC_RATE", "60/minute")
# "attendance" ships ON (registry default); nothing to override for tests.
# --- end Attendance & class calendar ---

# --- Certification, delivery and Hall of Fame (apps.certification) ---
INSTALLED_APPS += ["apps.certification.apps.CertificationConfig"]
CERTIFICATION_ENABLED = env_bool("CERTIFICATION_ENABLED", True)
# Default pass mark for a new certification exam policy (admin can change it per exam).
CERTIFICATION_DEFAULT_PASS_MARK = env("CERTIFICATION_DEFAULT_PASS_MARK", "70") or "70"
CERTIFICATION_SWEEP_INTERVAL_SECONDS = max(15, env_int("CERTIFICATION_SWEEP_INTERVAL_SECONDS", 60))
CERTIFICATION_DELIVERY_MAX_ATTEMPTS = max(1, env_int("CERTIFICATION_DELIVERY_MAX_ATTEMPTS", 8))
# Sender of the certificate e-mail (empty: DEFAULT_FROM_EMAIL). SMTP itself is EMAIL_*.
CERTIFICATION_EMAIL_FROM = env("CERTIFICATION_EMAIL_FROM", "").strip()
# WhatsApp Business Cloud API (Meta). DISABLED until token, phone number id and the
# certificate template are all set; nothing is ever reported as sent while disabled.
WHATSAPP_CLOUD_API_TOKEN = env("WHATSAPP_CLOUD_API_TOKEN", "").strip()
WHATSAPP_PHONE_NUMBER_ID = env("WHATSAPP_PHONE_NUMBER_ID", "").strip()
WHATSAPP_API_VERSION = env("WHATSAPP_API_VERSION", "v21.0").strip() or "v21.0"
WHATSAPP_GRAPH_BASE_URL = env("WHATSAPP_GRAPH_BASE_URL", "https://graph.facebook.com").strip()
WHATSAPP_TEMPLATE_CERTIFICATE = env("WHATSAPP_TEMPLATE_CERTIFICATE", "").strip()
WHATSAPP_TEMPLATE_LETTER = env("WHATSAPP_TEMPLATE_LETTER", "").strip()
WHATSAPP_TEMPLATE_LANGUAGE = env("WHATSAPP_TEMPLATE_LANGUAGE", "en").strip() or "en"
WHATSAPP_DEFAULT_COUNTRY_CODE = env("WHATSAPP_DEFAULT_COUNTRY_CODE", "91").strip()
WHATSAPP_HTTP_TIMEOUT_SECONDS = max(1, env_int("WHATSAPP_HTTP_TIMEOUT_SECONDS", 15))
# --- end Certification ---

# --- Billing (apps.billing): products, versioned prices, plans, entitlements ---
INSTALLED_APPS += ["apps.billing.apps.BillingConfig"]
