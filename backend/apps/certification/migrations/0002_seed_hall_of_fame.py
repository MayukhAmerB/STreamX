"""Import the manually curated Hall of Fame (the list that was hard-coded in
frontend/src/pages/HallOfFamePage.jsx) as curated entries.

Owner rule: the public Hall of Fame shows handles only. The curated names are
kept in ``legacy_name`` (staff only) and an entry becomes public once staff
map it to a user (whose profile handle is then shown) or confirm a display
handle (admin action "Use the curated name as the public display handle").
Idempotent (``seed_key``) and reversible (removes only these seeded rows).
"""

from django.db import migrations

BATCHES = [
    ("Batch 1", 1, ["Araxis", "Al Haris", "Zulqarnain", "Orvax", "Ibn Adam"]),
    (
        "Batch 2",
        2,
        [
            "ALHaq", "Bani Adam", "Baseej", "Fly-Nightingale", "Jarvis", "Khalid", "Laisullah", "LegallyStalking",
            "RadicalGates", "Shaikh Sahab", "Spectre", "STOIC MURDOCK", "Vision", "Yamach",
        ],
    ),
]


def seed(apps, schema_editor):
    Entry = apps.get_model("certification", "HallOfFameEntry")
    for label, order, names in BATCHES:
        for position, name in enumerate(names, 1):
            key = f"legacy:{order}:{position}"
            Entry.objects.get_or_create(
                seed_key=key,
                defaults={
                    "legacy_name": name,
                    "batch_label": label,
                    "batch_order": order,
                    "position": position,
                    "achievement": "Certified student",
                    "source": "manual",
                },
            )


def unseed(apps, schema_editor):
    apps.get_model("certification", "HallOfFameEntry").objects.filter(seed_key__startswith="legacy:").delete()


class Migration(migrations.Migration):
    dependencies = [("certification", "0001_initial")]
    operations = [migrations.RunPython(seed, unseed)]
