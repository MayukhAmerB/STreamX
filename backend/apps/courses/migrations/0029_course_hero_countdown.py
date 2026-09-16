from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("courses", "0028_course_show_course_image"),
    ]

    operations = [
        migrations.AddField(
            model_name="course",
            name="hero_countdown_end_at",
            field=models.DateTimeField(
                blank=True,
                help_text=(
                    "Optional enrollment deadline shown as a red countdown on the public homepage. "
                    "Leave blank to hide the countdown."
                ),
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="course",
            name="hero_countdown_label",
            field=models.CharField(
                blank=True,
                default="Enrollment closes in",
                help_text="Short label displayed beside the homepage countdown.",
                max_length=120,
            ),
        ),
    ]
