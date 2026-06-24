from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("campaigns", "0002_seed_default_campaigns"),
    ]

    operations = [
        migrations.AddField(
            model_name="campaignvolunteer",
            name="age",
            field=models.PositiveSmallIntegerField(blank=True, null=True),
        ),
    ]
