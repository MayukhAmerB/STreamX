from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0008_user_notifications_consent_version_and_more"),
    ]

    operations = [
        migrations.AlterField(
            model_name="asyncjob",
            name="job_type",
            field=models.CharField(
                choices=[
                    ("email_send", "Email Send"),
                    ("payment_webhook_retry", "Payment Webhook Retry"),
                    ("web_push_send", "Web Push Send"),
                ],
                max_length=64,
            ),
        ),
    ]
