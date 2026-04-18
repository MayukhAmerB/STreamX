import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("users", "0006_user_active_session_version"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="terms_accepted_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="user",
            name="terms_accepted_ip",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
        migrations.AddField(
            model_name="user",
            name="terms_accepted_user_agent",
            field=models.CharField(blank=True, default="", max_length=255),
        ),
        migrations.AddField(
            model_name="user",
            name="terms_accepted_version",
            field=models.CharField(blank=True, default="", max_length=40),
        ),
        migrations.CreateModel(
            name="TermsAcceptance",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("terms_version", models.CharField(max_length=40)),
                ("accepted_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("ip_address", models.CharField(blank=True, default="", max_length=64)),
                ("user_agent", models.CharField(blank=True, default="", max_length=255)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="terms_acceptances",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-accepted_at", "-id"],
            },
        ),
        migrations.AddIndex(
            model_name="termsacceptance",
            index=models.Index(fields=["terms_version", "accepted_at"], name="users_terms_terms_v_3df6ca_idx"),
        ),
        migrations.AddIndex(
            model_name="termsacceptance",
            index=models.Index(fields=["user", "terms_version"], name="users_terms_user_id_e88bdf_idx"),
        ),
        migrations.AddConstraint(
            model_name="termsacceptance",
            constraint=models.UniqueConstraint(
                fields=("user", "terms_version"),
                name="users_terms_acceptance_user_version_unique",
            ),
        ),
    ]
