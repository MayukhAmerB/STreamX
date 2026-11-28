from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("realtime", "0029_class_recording_auto_publish"),
    ]

    operations = [
        migrations.AddField(
            model_name="realtimesession",
            name="lecture_title",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Topic of this class. Used as the title of its recorded lecture.",
                max_length=255,
                verbose_name="Recording title (topic)",
            ),
        ),
    ]
