# Generated manually for campaign subdomain launch.

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Campaign",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=180)),
                ("campaign_number", models.CharField(blank=True, default="", max_length=20)),
                ("description", models.TextField(blank=True, default="")),
                ("image_data_url", models.TextField(blank=True, default="")),
                ("is_featured", models.BooleanField(default=False)),
                ("is_active", models.BooleanField(default=True)),
                ("sort_order", models.PositiveIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["sort_order", "-is_featured", "-created_at"],
                "indexes": [
                    models.Index(fields=["is_active", "is_featured", "sort_order"], name="campaigns_c_is_acti_821d9b_idx"),
                    models.Index(fields=["created_at"], name="campaigns_c_created_eda2da_idx"),
                ],
            },
        ),
        migrations.CreateModel(
            name="CampaignVolunteer",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("full_name", models.CharField(max_length=180)),
                ("whatsapp_number", models.CharField(max_length=24)),
                ("alternate_number", models.CharField(blank=True, default="", max_length=24)),
                ("city", models.CharField(max_length=120)),
                ("state", models.CharField(max_length=80)),
                ("gender", models.CharField(choices=[("male", "Male"), ("female", "Female")], max_length=12)),
                ("status", models.CharField(choices=[("new", "New"), ("reviewed", "Reviewed"), ("contacted", "Contacted"), ("confirmed", "Confirmed"), ("rejected", "Rejected")], default="new", max_length=20)),
                ("notes", models.TextField(blank=True, default="")),
                ("source_ip", models.GenericIPAddressField(blank=True, null=True)),
                ("user_agent", models.CharField(blank=True, default="", max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("campaign", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="volunteers", to="campaigns.campaign")),
            ],
            options={
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(fields=["campaign", "created_at"], name="campaigns_c_campaig_5736e8_idx"),
                    models.Index(fields=["status", "created_at"], name="campaigns_c_status_5107da_idx"),
                    models.Index(fields=["whatsapp_number", "created_at"], name="campaigns_c_whatsap_49f15f_idx"),
                ],
            },
        ),
    ]
