import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("payments", "0011_payment_terms_snapshot_alter_payment_plan"),
    ]

    operations = [
        migrations.CreateModel(
            name="PaymentCheckoutLock",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("identity_hash", models.CharField(max_length=64)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "course",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="checkout_locks",
                        to="courses.course",
                    ),
                ),
            ],
        ),
        migrations.AddField(
            model_name="paymentidempotencyrecord",
            name="lease_token",
            field=models.UUIDField(default=uuid.uuid4, editable=False),
        ),
        migrations.AddConstraint(
            model_name="paymentcheckoutlock",
            constraint=models.UniqueConstraint(
                fields=("course", "identity_hash"),
                name="payments_checkout_course_identity_uniq",
            ),
        ),
    ]
