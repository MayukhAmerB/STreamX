"""Self-service weekly reports, CONTRACT step.

Drops the old one-report-per-task (task, student) constraint; uniqueness is now
(task, student, target_key) from 0003. Not in the deploy gate's risky list.

Reverse (rollback) re-adds (task, student): it FAILS while any student has more
than one target in the same week task. Before reversing, turn self-service off
for every course and keep only one submission per (task, student) (see the
Phase 3 deploy notes, "Rollback").
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("reports", "0004_backfill_target_keys")]

    operations = [
        migrations.RemoveConstraint(
            model_name="reportsubmission",
            name="reports_submission_task_student_unique",
        ),
    ]
