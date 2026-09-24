from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from .models import SocialAccount, SocialAccountCategory


class SocialAccountSerializer(serializers.ModelSerializer):
    class Meta:
        model = SocialAccount
        fields = (
            "id",
            "account_name",
            "handle",
            "url",
            "managed_by",
            "description",
            "status_label",
        )


class SocialAccountCategorySerializer(serializers.ModelSerializer):
    accounts = serializers.SerializerMethodField()
    account_count = serializers.SerializerMethodField()

    class Meta:
        model = SocialAccountCategory
        fields = (
            "id",
            "name",
            "slug",
            "description",
            "icon_key",
            "account_count",
            "accounts",
        )

    @extend_schema_field(SocialAccountSerializer(many=True))
    def get_accounts(self, obj):
        return SocialAccountSerializer(getattr(obj, "public_accounts", ()), many=True).data

    @extend_schema_field(serializers.IntegerField())
    def get_account_count(self, obj):
        return len(getattr(obj, "public_accounts", ()))


class SocialAccountDirectoryResponseSerializer(serializers.Serializer):
    success = serializers.BooleanField()
    message = serializers.CharField()
    data = SocialAccountCategorySerializer(many=True)
    errors = serializers.JSONField(allow_null=True)
