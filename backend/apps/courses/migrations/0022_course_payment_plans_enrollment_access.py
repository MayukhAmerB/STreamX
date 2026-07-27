from decimal import Decimal

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("courses", "0021_enrollmentrequestnotification")]

    operations = [
        migrations.AddField(model_name="course", name="full_payment_enabled", field=models.BooleanField(default=True)),
        migrations.AddField(model_name="course", name="installment_payment_enabled", field=models.BooleanField(default=True)),
        migrations.AddField(model_name="course", name="monthly_price", field=models.DecimalField(decimal_places=2, default=Decimal("1500.00"), max_digits=10)),
        migrations.AddField(model_name="course", name="installments_required", field=models.PositiveSmallIntegerField(default=3)),
        migrations.AddField(model_name="course", name="installment_access_days", field=models.PositiveSmallIntegerField(default=30)),
        migrations.AddField(model_name="enrollment", name="access_type", field=models.CharField(choices=[("legacy", "Legacy permanent access"), ("installment", "Time-limited installment access"), ("lifetime", "Lifetime access")], default="legacy", max_length=20)),
        migrations.AddField(model_name="enrollment", name="access_expires_at", field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(model_name="enrollment", name="installments_paid", field=models.PositiveSmallIntegerField(default=0)),
    ]
