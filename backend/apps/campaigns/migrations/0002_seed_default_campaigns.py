from django.db import migrations


DEFAULT_CAMPAIGNS = [
    ("Nazia Ilahi Khan", "001", True, 1),
    ("Gaurav Singh Rajput", "002", True, 2),
    ("Ex Muslim Sameer", "003", True, 3),
]


def seed_default_campaigns(apps, schema_editor):
    Campaign = apps.get_model("campaigns", "Campaign")
    for name, number, featured, order in DEFAULT_CAMPAIGNS:
        Campaign.objects.get_or_create(
            name=name,
            defaults={
                "campaign_number": number,
                "is_featured": featured,
                "is_active": True,
                "sort_order": order,
            },
        )
    for i in range(4, 28):
        Campaign.objects.get_or_create(
            name=f"Campaign #{i:03d}",
            defaults={
                "campaign_number": f"{i:03d}",
                "is_featured": False,
                "is_active": True,
                "sort_order": i,
            },
        )


class Migration(migrations.Migration):
    dependencies = [
        ("campaigns", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed_default_campaigns, migrations.RunPython.noop),
    ]

