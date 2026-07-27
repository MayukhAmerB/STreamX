from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("payments", "0005_payment_audit_retention")]

    operations = [
        migrations.AddField(model_name="payment", name="access_expires_at", field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(model_name="payment", name="credentials_issued_at", field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(model_name="payment", name="installment_number", field=models.PositiveSmallIntegerField(blank=True, null=True)),
        migrations.AddField(model_name="payment", name="invoice_number", field=models.CharField(blank=True, max_length=64, null=True, unique=True)),
        migrations.AddField(model_name="payment", name="plan", field=models.CharField(choices=[("full", "Full / lifetime"), ("monthly", "Monthly installment")], default="full", max_length=20)),
        migrations.AddField(model_name="payment", name="provisioning_status", field=models.CharField(choices=[("pending_payment", "Pending payment"), ("awaiting_admin_credentials", "Awaiting admin credentials"), ("credentials_issued", "Credentials issued"), ("failed", "Provisioning failed")], default="pending_payment", max_length=40)),
        migrations.CreateModel(
            name="StudentAccountSequence",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("next_number", models.PositiveBigIntegerField(default=1)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"verbose_name": "Student account sequence", "verbose_name_plural": "Student account sequence"},
        ),
    ]
