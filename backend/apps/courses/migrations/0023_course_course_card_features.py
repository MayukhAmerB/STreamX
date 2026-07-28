from django.db import migrations, models

import apps.courses.models


class Migration(migrations.Migration):
    dependencies = [
        ("courses", "0022_course_payment_plans_enrollment_access"),
    ]

    operations = [
        migrations.AddField(
            model_name="course",
            name="course_card_features",
            field=models.JSONField(
                blank=True,
                default=apps.courses.models.default_course_card_features,
            ),
        ),
    ]
