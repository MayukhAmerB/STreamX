from apps.core.health import liveness, readiness
from django.http import JsonResponse

from config.metrics import build_metrics_response, get_metrics_authorization

# Probes live in apps.core.health; these views keep the public paths
# (/health/live, /health/ready, /healthz, /readyz) and payload keys that
# Docker healthchecks, the nginx gateway, post-deploy-smoke.sh,
# uptime-alert.sh and restore-data.sh depend on.


def liveness_view(request):
    response = JsonResponse(liveness(), status=200)
    response["Cache-Control"] = "no-store"
    return response


def readiness_view(request):
    status_code, payload = readiness()
    response = JsonResponse(payload, status=status_code)
    response["Cache-Control"] = "no-store"
    return response


def metrics_view(request):
    allowed, detail = get_metrics_authorization(request)
    if not allowed:
        return JsonResponse(
            {
                "status": "forbidden",
                "detail": detail,
            },
            status=403,
        )
    return build_metrics_response()
