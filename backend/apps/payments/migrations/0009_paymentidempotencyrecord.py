import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("payments", "0008_successfulpaymentuser"),
    ]

    operations = [
        migrations.CreateModel(
            name="PaymentIdempotencyRecord",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("scope", models.CharField(default="create_order", max_length=40)),
                ("identity_hash", models.CharField(max_length=64)),
                ("key_hash", models.CharField(max_length=64)),
                ("request_fingerprint", models.CharField(max_length=64)),
                ("status", models.CharField(choices=[("processing", "Processing"), ("completed", "Completed")], default="processing", max_length=20)),
                ("response_payload", models.JSONField(blank=True, default=dict)),
                ("response_status", models.PositiveSmallIntegerField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("payment", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="idempotency_records", to="payments.payment")),
            ],
            options={
                "indexes": [models.Index(fields=["status", "created_at"], name="payments_pa_status_38829d_idx")],
                "constraints": [models.UniqueConstraint(fields=("scope", "identity_hash", "key_hash"), name="payments_idem_scope_identity_key_uniq")],
            },
        ),
    ]
