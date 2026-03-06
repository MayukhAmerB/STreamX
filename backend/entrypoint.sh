#!/bin/sh
set -e

if [ "${APP_ENV:-}" = "production" ] || [ "${DJANGO_SETTINGS_MODULE:-}" = "config.settings.prod" ]; then
  python manage.py check --deploy --fail-level WARNING
fi

python manage.py migrate --noinput
if [ "${RUN_COLLECTSTATIC:-1}" = "1" ]; then
  python manage.py collectstatic --noinput
fi
exec "$@"
