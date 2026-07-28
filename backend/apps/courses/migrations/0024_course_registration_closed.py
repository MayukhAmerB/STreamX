from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("courses", "0023_course_course_card_features"),
    ]

    operations = [
        migrations.AddField(
            model_name="course",
            name="registration_closed",
            field=models.BooleanField(
                default=False,
                help_text=(
                    "Close new registrations while keeping this course visible and available "
                    "to students who already have access."
                ),
            ),
        ),
    ]
