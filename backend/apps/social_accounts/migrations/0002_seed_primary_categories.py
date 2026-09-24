from django.db import migrations


PRIMARY_CATEGORIES = (
    (
        "youtube",
        "YouTube",
        "youtube",
        10,
        "Verified video channels and official publishing accounts associated with Al Syed Initiative.",
    ),
    (
        "instagram",
        "Instagram",
        "instagram",
        20,
        "Verified Instagram profiles used for announcements, education, and community updates.",
    ),
    (
        "x",
        "X",
        "x",
        30,
        "Verified X accounts used for official statements, alerts, and public communication.",
    ),
    (
        "facebook",
        "Facebook",
        "facebook",
        40,
        "Verified Facebook pages and profiles officially associated with the initiative.",
    ),
)


def seed_primary_categories(apps, schema_editor):
    category_model = apps.get_model("social_accounts", "SocialAccountCategory")
    for slug, name, icon_key, sort_order, description in PRIMARY_CATEGORIES:
        category_model.objects.get_or_create(
            slug=slug,
            defaults={
                "name": name,
                "icon_key": icon_key,
                "sort_order": sort_order,
                "description": description,
                "is_active": True,
            },
        )


class Migration(migrations.Migration):
    dependencies = [("social_accounts", "0001_initial")]

    operations = [
        migrations.RunPython(seed_primary_categories, migrations.RunPython.noop),
    ]
