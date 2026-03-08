from django.urls import path

from .views import CreateOrderView, PaymentWebhookView, VerifyPaymentView

urlpatterns = [
    path("create-order/", CreateOrderView.as_view(), name="payment-create-order"),
    path("verify/", VerifyPaymentView.as_view(), name="payment-verify"),
    path("webhook/", PaymentWebhookView.as_view(), name="payment-webhook"),
]
