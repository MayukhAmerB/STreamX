from copy import deepcopy
from importlib import import_module

from django.db import migrations
from django.db.models import Q


def fill_empty_osint_batch_four_curriculum(apps, schema_editor):
    Course = apps.get_model("courses", "Course")
    curriculum = import_module(
        "apps.courses.migrations.0032_course_public_curriculum"
    ).OSINT_PUBLIC_CURRICULUM

    candidates = Course.objects.filter(
        Q(slug="osint-professional-training-batch-iv")
        | Q(category="osint", batch__iexact="Batch IV")
        | Q(category="osint", title__icontains="BATCH IV")
    )
    for course in candidates.iterator():
        if course.public_curriculum:
            continue
        course.public_curriculum = deepcopy(curriculum)
        course.save(update_fields=["public_curriculum"])


class Migration(migrations.Migration):
    dependencies = [
        ("courses", "0032_course_public_curriculum"),
    ]

    operations = [
        migrations.RunPython(
            fill_empty_osint_batch_four_curriculum,
            migrations.RunPython.noop,
        ),
    ]
