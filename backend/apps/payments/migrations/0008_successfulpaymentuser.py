from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("payments", "0007_paymentwebhookevent"),
        ("users", "0011_alter_asyncjob_job_type"),
    ]

    operations = [
        migrations.CreateModel(
            name="SuccessfulPaymentUser",
            fields=[],
            options={
                "verbose_name": "Successful Payment User",
                "verbose_name_plural": "Successful Payment Users",
                "proxy": True,
                "indexes": [],
                "constraints": [],
            },
            bases=("users.user",),
        ),
    ]
