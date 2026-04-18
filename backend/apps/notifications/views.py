from django.conf import settings
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.parsers import JSONParser
from rest_framework.views import APIView

from config.response import api_response

from .models import NotificationRecipient
from .serializers import NotificationRecipientSerializer, WebPushSubscriptionSerializer


class NotificationListView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        try:
            limit = int(request.query_params.get("limit", 20))
        except (TypeError, ValueError):
            limit = 20
        limit = max(1, min(limit, 50))
        queryset = (
            NotificationRecipient.objects.filter(user=request.user)
            .select_related("notification")
            .order_by("-created_at", "-id")
        )
        unread_count = queryset.filter(read_at__isnull=True).count()
        serializer = NotificationRecipientSerializer(queryset[:limit], many=True)
        return api_response(
            success=True,
            message="Notifications fetched.",
            data={
                "results": serializer.data,
                "unread_count": unread_count,
            },
        )


class NotificationReadView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        recipient = NotificationRecipient.objects.filter(pk=pk, user=request.user).first()
        if recipient is None:
            return api_response(
                success=False,
                message="Notification not found.",
                errors={"detail": "Notification not found."},
                status_code=status.HTTP_404_NOT_FOUND,
            )
        if recipient.read_at is None:
            recipient.read_at = timezone.now()
            recipient.save(update_fields=["read_at"])
        return api_response(
            success=True,
            message="Notification marked as read.",
            data=NotificationRecipientSerializer(recipient).data,
        )


class NotificationReadAllView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        updated = NotificationRecipient.objects.filter(
            user=request.user,
            read_at__isnull=True,
        ).update(read_at=timezone.now())
        return api_response(
            success=True,
            message="Notifications marked as read.",
            data={"updated": updated},
        )


class WebPushSubscriptionView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        serializer = WebPushSubscriptionSerializer(data=request.data, context={"request": request})
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Push subscription could not be saved.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        subscription = serializer.save()
        enabled = bool(
            getattr(settings, "WEB_PUSH_ENABLED", False)
            and getattr(settings, "WEB_PUSH_VAPID_PUBLIC_KEY", "")
            and getattr(settings, "WEB_PUSH_VAPID_PRIVATE_KEY", "")
        )
        return api_response(
            success=True,
            message="Push subscription saved.",
            data={
                "id": subscription.id,
                "is_active": subscription.is_active,
                "web_push_configured": enabled,
            },
        )
