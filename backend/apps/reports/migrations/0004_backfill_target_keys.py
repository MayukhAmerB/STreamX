"""Self-service weekly reports, BACKFILL step (data only, reversible).

Legacy submissions (one per student per instructor-created task) get the
task's title as their target, so (task, student, target_key) stays unique and
graders see a target on every row. Batched by primary key; touches only rows
whose target_key is still empty, so re-running it is a no-op.

Deploy gate: contains RunPython, so check-migration-safety.sh needs
MIGRATION_RISK_ACCEPTED=1 (see the Phase 3 deploy notes).
"""

from django.db import migrations

from apps.core.textnorm import clean_display, target_key

BATCH = 500


def backfill(apps, schema_editor):
    ReportSubmission = apps.get_model("reports", "ReportSubmission")
    last_id = 0
    while True:
        rows = list(
            ReportSubmission.objects.filter(pk__gt=last_id, target_key="")
            .select_related("task")
            .order_by("pk")[:BATCH]
        )
        if not rows:
            break
        for row in rows:
            name = clean_display(row.task.title) or f"Task {row.task_id}"
            row.target_name = row.target_name or name
            row.target_key = target_key(name) or f"task-{row.task_id}"
        ReportSubmission.objects.bulk_update(rows, ["target_name", "target_key"])
        last_id = rows[-1].pk


def clear(apps, schema_editor):
    # Reverse: back to the expand state (empty keys are unique per
    # (task, student) while the old constraint holds, which 0005's reverse
    # restores first).
    ReportSubmission = apps.get_model("reports", "ReportSubmission")
    ReportSubmission.objects.filter(task__origin="admin").update(target_name="", target_key="")


class Migration(migrations.Migration):
    dependencies = [("reports", "0003_self_service_expand")]

    operations = [migrations.RunPython(backfill, clear, elidable=True)]
