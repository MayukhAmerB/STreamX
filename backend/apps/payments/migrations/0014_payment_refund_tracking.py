from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('payments', '0013_alter_payment_plan_batchpass'),
    ]

    operations = [
        migrations.AlterField(
            model_name='payment',
            name='status',
            field=models.CharField(choices=[('created', 'Created'), ('paid', 'Paid'), ('failed', 'Failed'), ('refunded', 'Refunded')], default='created', max_length=20),
        ),
        migrations.AddField(
            model_name='payment',
            name='amount_refunded',
            field=models.DecimalField(decimal_places=2, default=0, help_text='Cumulative amount refunded through Razorpay or marked refunded by an admin.', max_digits=10),
        ),
        migrations.AddField(
            model_name='payment',
            name='refunded_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='batchpass',
            name='is_active',
            field=models.BooleanField(default=True, help_text='Untick to end the pass: future batches stop and courses only the pass unlocked are revoked.'),
        ),
    ]
