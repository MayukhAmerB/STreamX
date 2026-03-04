from rest_framework import serializers


class CreateOrderSerializer(serializers.Serializer):
    course_id = serializers.IntegerField(min_value=1)


class VerifyPaymentSerializer(serializers.Serializer):
    course_id = serializers.IntegerField(min_value=1)
    razorpay_order_id = serializers.CharField()
    razorpay_payment_id = serializers.CharField()
    razorpay_signature = serializers.CharField()
