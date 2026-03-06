from django.db import migrations


def backfill_missing_linked_live_class(apps, schema_editor):
    RealtimeSession = apps.get_model("realtime", "RealtimeSession")
    LiveClass = apps.get_model("courses", "LiveClass")

    queryset = RealtimeSession.objects.filter(
        linked_live_class__isnull=True,
        linked_course__isnull=False,
    ).only("id", "linked_course_id")

    for session in queryset.iterator():
        live_class = (
            LiveClass.objects.filter(linked_course_id=session.linked_course_id, is_active=True)
            .order_by("month_number", "id")
            .first()
        )
        if live_class:
            RealtimeSession.objects.filter(pk=session.pk).update(linked_live_class_id=live_class.id)


def noop_reverse(apps, schema_editor):
    return


class Migration(migrations.Migration):
    dependencies = [
        ("realtime", "0010_realtimesession_linked_live_class_and_more"),
    ]

    operations = [
        migrations.RunPython(backfill_missing_linked_live_class, noop_reverse),
    ]
