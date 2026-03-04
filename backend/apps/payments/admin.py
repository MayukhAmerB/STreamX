from django.contrib import admin

from .models import Payment


@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "course", "status", "amount", "currency", "created_at")
    search_fields = ("user__email", "course__title", "razorpay_order_id", "razorpay_payment_id")
    list_filter = ("status", "currency")
