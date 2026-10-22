import datetime

from django.db import migrations


INSTAGRAM_URL = "https://www.instagram.com/adlfrontofficial?igsh=MTgwN3Z2ZXZ4aGswYg=="

LAW_TOPICS = (
    (
        "book",
        "Your Right to File a Complaint",
        "Under Section 154 of the CrPC, you have the right to file an FIR. The police must register it without delay.",
        "04:32",
        10,
    ),
    (
        "person",
        "What to Do If FIR Is Not Registered",
        "If the police refuse to register your complaint, you can approach higher authorities or a magistrate.",
        "03:18",
        20,
    ),
    (
        "clipboard",
        "Your Rights During Police Interrogation",
        "You have the right to remain silent, to legal counsel, and to not be forced into self-incrimination.",
        "05:26",
        30,
    ),
    (
        "scale",
        "Important Legal Provisions to Know",
        "Key sections: IPC (e.g., 499, 500), CrPC (e.g., 41, 41A, 161), and your fundamental rights under the Constitution.",
        "06:14",
        40,
    ),
    (
        "shield",
        "What to Do After Filing the FIR",
        "Next steps; follow-up, investigation process, and how to track your case status.",
        "04:50",
        50,
    ),
)

TRACKER_UPDATES = (
    ("Lucknow", "Uttar Pradesh", "completed", "FIR Registered", datetime.date(2025, 10, 18), 10),
    ("Bhopal", "Madhya Pradesh", "in_progress", "Under Process", datetime.date(2025, 10, 17), 20),
    ("Hyderabad", "Telangana", "completed", "FIR Registered", datetime.date(2025, 10, 16), 30),
    ("Jaipur", "Rajasthan", "in_progress", "Under Process", datetime.date(2025, 10, 15), 40),
    ("Kolkata", "West Bengal", "completed", "FIR Registered", datetime.date(2025, 10, 14), 50),
)


def seed(apps, schema_editor):
    NationalDeskSettings = apps.get_model("national_desk", "NationalDeskSettings")
    FirFilingGuide = apps.get_model("national_desk", "FirFilingGuide")
    LawsSection = apps.get_model("national_desk", "LawsSection")
    TrackerOverview = apps.get_model("national_desk", "TrackerOverview")
    LawTopic = apps.get_model("national_desk", "LawTopic")
    TrackerUpdate = apps.get_model("national_desk", "TrackerUpdate")

    # Materialise the single-row configuration tables with their field defaults,
    # which already carry today's content.
    NationalDeskSettings.objects.get_or_create(pk=1, defaults={"instagram_url": INSTAGRAM_URL})
    FirFilingGuide.objects.get_or_create(pk=1)
    LawsSection.objects.get_or_create(pk=1)
    TrackerOverview.objects.get_or_create(pk=1)

    for icon_key, title, body, duration, sort_order in LAW_TOPICS:
        LawTopic.objects.get_or_create(
            title=title,
            defaults={
                "icon_key": icon_key,
                "body": body,
                "audio_duration": duration,
                "sort_order": sort_order,
            },
        )

    for city, region, status, note, event_date, sort_order in TRACKER_UPDATES:
        TrackerUpdate.objects.get_or_create(
            city=city,
            region=region,
            event_date=event_date,
            defaults={
                "status": status,
                "status_note": note,
                "sort_order": sort_order,
            },
        )


def unseed(apps, schema_editor):
    LawTopic = apps.get_model("national_desk", "LawTopic")
    TrackerUpdate = apps.get_model("national_desk", "TrackerUpdate")
    LawTopic.objects.filter(title__in=[row[1] for row in LAW_TOPICS]).delete()
    TrackerUpdate.objects.filter(
        city__in=[row[0] for row in TRACKER_UPDATES]
    ).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("national_desk", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
