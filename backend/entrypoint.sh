#!/bin/sh
set -e

wait_for_database() {
  python manage.py shell -c "from django.db import connection; connection.ensure_connection(); cursor = connection.cursor(); cursor.execute('SELECT 1'); row = cursor.fetchone(); raise SystemExit(0 if row and row[0] == 1 else 1)"
}


STARTUP_DB_MAX_ATTEMPTS="${STARTUP_DB_MAX_ATTEMPTS:-20}"
STARTUP_DB_RETRY_SECONDS="${STARTUP_DB_RETRY_SECONDS:-3}"
attempt=1
until wait_for_database; do
  if [ "$attempt" -ge "$STARTUP_DB_MAX_ATTEMPTS" ]; then
    echo "[entrypoint] Database probe failed after ${STARTUP_DB_MAX_ATTEMPTS} attempts." >&2
    exit 1
  fi
  echo "[entrypoint] Database unavailable, retrying in ${STARTUP_DB_RETRY_SECONDS}s (${attempt}/${STARTUP_DB_MAX_ATTEMPTS})..." >&2
  attempt=$((attempt + 1))
  sleep "$STARTUP_DB_RETRY_SECONDS"
done

if [ "${APP_ENV:-}" = "production" ] || [ "${DJANGO_SETTINGS_MODULE:-}" = "config.settings.prod" ]; then
  python manage.py check --deploy --fail-level WARNING
fi

if [ "${RUN_MIGRATIONS:-1}" = "1" ]; then
  python manage.py migrate --noinput
else
  echo "[entrypoint] RUN_MIGRATIONS=0, skipping migrate step."
fi
# Static files are built into the image. RUN_COLLECTSTATIC=1 only exists for
# images built without them (local development).
if [ "${RUN_COLLECTSTATIC:-0}" = "1" ]; then
  python manage.py collectstatic --noinput --clear
fi
if [ "${APP_ENV:-}" = "production" ] || [ "${DJANGO_SETTINGS_MODULE:-}" = "config.settings.prod" ]; then
  if [ "${VALIDATE_STATICFILES:-1}" = "1" ]; then
    # Proves the admin assets are servable, not just listed in the manifest:
    # a manifest without files renders an unstyled admin while /static/ 404s.
    python manage.py verify_staticfiles
  fi
fi
exec "$@"
