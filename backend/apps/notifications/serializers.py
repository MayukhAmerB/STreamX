from django.utils import timezone
from rest_framework import serializers

from .models import Notification, NotificationRecipient, WebPushSubscription


class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = (
            "id",
            "kind",
            "title",
            "body",
            "action_url",
            "created_at",
        )


class NotificationRecipientSerializer(serializers.ModelSerializer):
    notification = NotificationSerializer(read_only=True)

    class Meta:
        model = NotificationRecipient
        fields = (
            "id",
            "notification",
            "read_at",
            "pushed_at",
            "created_at",
        )


class WebPushSubscriptionSerializer(serializers.Serializer):
    endpoint = serializers.URLField(max_length=2048)
    expirationTime = serializers.IntegerField(required=False, allow_null=True)
    keys = serializers.DictField()

    def validate_keys(self, value):
        p256dh = str(value.get("p256dh") or "").strip()
        auth = str(value.get("auth") or "").strip()
        if not p256dh or not auth:
            raise serializers.ValidationError("Push subscription keys are incomplete.")
        return {"p256dh": p256dh, "auth": auth}

    def save(self, **kwargs):
        request = self.context["request"]
        keys = self.validated_data["keys"]
        subscription, _created = WebPushSubscription.objects.update_or_create(
            endpoint=self.validated_data["endpoint"],
            defaults={
                "user": request.user,
                "p256dh": keys["p256dh"],
                "auth": keys["auth"],
                "user_agent": str(request.META.get("HTTP_USER_AGENT", "") or "")[:255],
                "is_active": True,
                "last_seen_at": timezone.now(),
            },
        )
        return subscription
