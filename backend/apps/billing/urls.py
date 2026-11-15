from django.urls import path

from .views import CheckoutVerifyView, CheckoutView, MyEntitlementsView, PlanListView, QuoteView

urlpatterns = [
    path("plans/", PlanListView.as_view(), name="billing-plans"),
    path("quote/", QuoteView.as_view(), name="billing-quote"),
    path("checkout/", CheckoutView.as_view(), name="billing-checkout"),
    path("checkout/verify/", CheckoutVerifyView.as_view(), name="billing-checkout-verify"),
    path("entitlements/", MyEntitlementsView.as_view(), name="billing-entitlements"),
]
