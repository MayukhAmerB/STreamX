from django.db import migrations


def fix_public_campaign_numbers(apps, schema_editor):
    Campaign = apps.get_model("campaigns", "Campaign")
    Campaign.objects.filter(name__iexact="Ex Muslim Sameer").update(campaign_number="006")
    Campaign.objects.filter(name__iexact="Gaurav Singh Rajput").update(campaign_number="009")


class Migration(migrations.Migration):
    dependencies = [
        ("campaigns", "0003_campaignvolunteer_age"),
    ]

    operations = [
        migrations.RunPython(fix_public_campaign_numbers, migrations.RunPython.noop),
    ]
