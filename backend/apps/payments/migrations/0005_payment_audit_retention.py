import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def backfill_payment_audit_fields(apps, schema_editor):
    Payment = apps.get_model("payments", "Payment")
    for payment in Payment.objects.select_related("user", "course").iterator():
        payment.internal_reference = uuid.uuid4()
        payment.user_email_snapshot = (
            str(getattr(payment.user, "email", "") or "") if payment.user_id else ""
        )
        payment.course_id_snapshot = payment.course_id
        payment.course_title_snapshot = (
            str(getattr(payment.course, "title", "") or "") if payment.course_id else ""
        )
        payment.save(
            update_fields=[
                "internal_reference",
                "user_email_snapshot",
                "course_id_snapshot",
                "course_title_snapshot",
            ]
        )


class Migration(migrations.Migration):
    dependencies = [
        ("payments", "0004_payment_age_payment_alternate_number_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="payment",
            name="internal_reference",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="payment",
            name="user_email_snapshot",
            field=models.EmailField(blank=True, default="", max_length=254),
        ),
        migrations.AddField(
            model_name="payment",
            name="course_id_snapshot",
            field=models.PositiveBigIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="payment",
            name="course_title_snapshot",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="payment",
            name="gateway_status",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
        migrations.AddField(
            model_name="payment",
            name="payment_method",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
        migrations.AddField(
            model_name="payment",
            name="gateway_details",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="payment",
            name="failure_reason",
            field=models.TextField(blank=True, default=""),
        ),
        migrations.AddField(
            model_name="payment",
            name="last_webhook_event",
            field=models.CharField(blank=True, default="", max_length=120),
        ),
        migrations.AddField(
            model_name="payment",
            name="paid_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="payment",
            name="razorpay_order_id",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.RunPython(
            backfill_payment_audit_fields,
            migrations.RunPython.noop,
        ),
        migrations.AlterField(
            model_name="payment",
            name="internal_reference",
            field=models.UUIDField(default=uuid.uuid4, editable=False, unique=True),
        ),
        migrations.AlterField(
            model_name="payment",
            name="user",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="payments",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="payment",
            name="course",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="payments",
                to="courses.course",
            ),
        ),
    ]
