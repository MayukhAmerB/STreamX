FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y gcc libpq-dev ffmpeg && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x /app/entrypoint.sh

# Static files are built once into the image so every replica serves an
# identical, complete set; containers no longer rebuild them at startup.
RUN APP_ENV=production DJANGO_SETTINGS_MODULE=config.settings.prod     ENFORCE_PRODUCTION_REQUIREMENTS=0 ALLOW_SQLITE_IN_PRODUCTION=1     DJANGO_SECRET_KEY=build-only-collectstatic-key DATABASE_URL=sqlite:////tmp/build.sqlite3     DIRECT_COURSE_PAYMENTS_ENABLED=0 LIVEKIT_RECORDING_ENABLED=0     python manage.py collectstatic --noinput --clear     && test -s /app/staticfiles/staticfiles.json

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import sys, urllib.request; resp = urllib.request.urlopen('http://127.0.0.1:8000/health/live', timeout=3); sys.exit(0 if resp.status == 200 else 1)"
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["gunicorn", "--config", "gunicorn.conf.py", "config.wsgi:application"]
