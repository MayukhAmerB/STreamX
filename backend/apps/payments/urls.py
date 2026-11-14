from django.urls import path

from .views import CreateOrderView, PaymentWebhookView, VerifyPaymentView
from .views_platform import (
    MySubscriptionsView,
    PlatformOrderCreateView,
    PlatformOrderVerifyView,
    SubscriptionCancelView,
    SubscriptionCreateView,
    SubscriptionVerifyView,
)

urlpatterns = [
    path("create-order/", CreateOrderView.as_view(), name="payment-create-order"),
    path("verify/", VerifyPaymentView.as_view(), name="payment-verify"),
    path("webhook/", PaymentWebhookView.as_view(), name="payment-webhook"),
    # Platform plans (contract hackpath/contracts/catalog.md §5).
    path("platform/orders/", PlatformOrderCreateView.as_view(), name="platform-order-create"),
    path("platform/orders/verify/", PlatformOrderVerifyView.as_view(), name="platform-order-verify"),
    path("subscriptions/", SubscriptionCreateView.as_view(), name="subscription-create"),
    path("subscriptions/verify/", SubscriptionVerifyView.as_view(), name="subscription-verify"),
    path("subscriptions/mine/", MySubscriptionsView.as_view(), name="subscription-mine"),
    path("subscriptions/<int:pk>/cancel/", SubscriptionCancelView.as_view(), name="subscription-cancel"),
]
