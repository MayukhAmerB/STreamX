from django.db import migrations

PRIMARY_ORDER = {
    "instagram": 10,
    "youtube": 20,
    "x": 30,
    "facebook": 40,
}

PREVIOUS_ORDER = {
    "youtube": 10,
    "instagram": 20,
    "x": 30,
    "facebook": 40,
}


def set_category_order(apps, ordering):
    category_model = apps.get_model("social_accounts", "SocialAccountCategory")
    for slug, sort_order in ordering.items():
        category_model.objects.filter(slug=slug).update(sort_order=sort_order)


def promote_instagram(apps, schema_editor):
    set_category_order(apps, PRIMARY_ORDER)


def restore_previous_order(apps, schema_editor):
    set_category_order(apps, PREVIOUS_ORDER)


class Migration(migrations.Migration):
    dependencies = [("social_accounts", "0002_seed_primary_categories")]

    operations = [
        migrations.RunPython(promote_instagram, restore_previous_order),
    ]
