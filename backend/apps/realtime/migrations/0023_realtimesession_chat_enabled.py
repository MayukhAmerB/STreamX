from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("realtime", "0022_owncast_chat_moderation_state"),
    ]

    operations = [
        migrations.AddField(
            model_name="realtimesession",
            name="chat_enabled",
            field=models.BooleanField(default=True),
        ),
    ]
