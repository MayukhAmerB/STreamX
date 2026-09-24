from config.response import api_response
from django.db.models import Prefetch
from drf_spectacular.utils import extend_schema
from rest_framework import permissions
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from .models import SocialAccount, SocialAccountCategory
from .serializers import SocialAccountCategorySerializer, SocialAccountDirectoryResponseSerializer


class SocialAccountDirectoryThrottle(AnonRateThrottle):
    scope = "social_account_directory"
    rate = "120/min"


class SocialAccountDirectoryView(APIView):
    permission_classes = (permissions.AllowAny,)
    throttle_classes = (SocialAccountDirectoryThrottle,)

    @extend_schema(
        operation_id="social_accounts_directory_list",
        tags=("AS Accounts",),
        responses={200: SocialAccountDirectoryResponseSerializer},
    )
    def get(self, request):
        public_accounts = SocialAccount.objects.filter(is_active=True).order_by(
            "sort_order", "account_name", "pk"
        )
        categories = SocialAccountCategory.objects.filter(is_active=True).prefetch_related(
            Prefetch("accounts", queryset=public_accounts, to_attr="public_accounts")
        )
        response = api_response(
            message="Verified account directory fetched.",
            data=SocialAccountCategorySerializer(categories, many=True).data,
        )
        response["Cache-Control"] = "public, max-age=60, stale-while-revalidate=120"
        return response
