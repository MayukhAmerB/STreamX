import datetime

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.national_desk.models import (
    FirFilingGuide,
    LawsSection,
    LawTopic,
    LawTopicVideo,
    NationalDeskSettings,
    TrackerOverview,
    TrackerUpdate,
)

INSTAGRAM_URL = "https://www.instagram.com/adlfrontofficial?igsh=MTgwN3Z2ZXZ4aGswYg=="

# (icon_key, title, body, audio_duration, sort_order)
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

PDF_ROW = {
    "title": "Complaint Letter Format",
    "icon_key": "pdf",
    "action_type": "pdf",
    "body": "Download the ready-to-use complaint letter format to file your FIR.",
    "audio_duration": "02:40",
    "sort_order": 60,
}

VIDEO_ROW = {
    "title": "Video Proof Examples",
    "icon_key": "video",
    "action_type": "video",
    "body": "Watch sample video formats and how to present evidence properly.",
    "audio_duration": "2:18",
    "audio_note": "Tap to listen to a quick guide on how to record and present evidence correctly.",
    "sort_order": 70,
}

# (title, description, duration, sort_order)
VIDEO_EXAMPLES = (
    ("Recording an Incident", "How to properly record a video at the scene and what details to include.", "2:14", 10),
    ("Showing Location Proof", "How to capture location, surroundings and time in your video.", "1:48", 20),
    ("Capturing Evidence (Do's & Don'ts)", "What to record, what to avoid, and common mistakes to prevent.", "3:22", 30),
    ("How to Present Video to Police", "Step-by-step guide on how to submit your video evidence properly.", "2:37", 40),
)

TRACKER_UPDATES = (
    ("Lucknow", "Uttar Pradesh", "completed", "FIR Registered", datetime.date(2025, 10, 18), 10),
    ("Bhopal", "Madhya Pradesh", "in_progress", "Under Process", datetime.date(2025, 10, 17), 20),
    ("Hyderabad", "Telangana", "completed", "FIR Registered", datetime.date(2025, 10, 16), 30),
    ("Jaipur", "Rajasthan", "in_progress", "Under Process", datetime.date(2025, 10, 15), 40),
    ("Kolkata", "West Bengal", "completed", "FIR Registered", datetime.date(2025, 10, 14), 50),
)


class Command(BaseCommand):
    help = "Seed National Desk content (singletons, law topics, tracker updates). Idempotent."

    @transaction.atomic
    def handle(self, *args, **options):
        created = {"topics": 0, "videos": 0, "updates": 0}

        # Single-row configuration tables carry today's content in their field
        # defaults; create them if they do not exist yet, without clobbering edits.
        NationalDeskSettings.objects.get_or_create(pk=1, defaults={"instagram_url": INSTAGRAM_URL})
        FirFilingGuide.objects.get_or_create(pk=1)
        LawsSection.objects.get_or_create(pk=1)
        TrackerOverview.objects.get_or_create(pk=1)

        for icon_key, title, body, duration, sort_order in LAW_TOPICS:
            _, was_created = LawTopic.objects.get_or_create(
                title=title,
                defaults={
                    "icon_key": icon_key,
                    "action_type": "audio",
                    "body": body,
                    "audio_duration": duration,
                    "sort_order": sort_order,
                },
            )
            created["topics"] += int(was_created)

        _, was_created = LawTopic.objects.get_or_create(
            title=PDF_ROW["title"], defaults={k: v for k, v in PDF_ROW.items() if k != "title"}
        )
        created["topics"] += int(was_created)

        video_topic, was_created = LawTopic.objects.get_or_create(
            title=VIDEO_ROW["title"], defaults={k: v for k, v in VIDEO_ROW.items() if k != "title"}
        )
        created["topics"] += int(was_created)

        for title, description, duration, sort_order in VIDEO_EXAMPLES:
            _, v_created = LawTopicVideo.objects.get_or_create(
                topic=video_topic,
                title=title,
                defaults={
                    "description": description,
                    "duration": duration,
                    "sort_order": sort_order,
                },
            )
            created["videos"] += int(v_created)

        for city, region, status, note, event_date, sort_order in TRACKER_UPDATES:
            _, was_created = TrackerUpdate.objects.get_or_create(
                city=city,
                region=region,
                event_date=event_date,
                defaults={
                    "status": status,
                    "status_note": note,
                    "sort_order": sort_order,
                },
            )
            created["updates"] += int(was_created)

        self.stdout.write(
            self.style.SUCCESS(
                "National Desk seeded: "
                f"{created['topics']} new law topic(s), {created['videos']} new video(s), "
                f"{created['updates']} new tracker update(s). Settings/guide/laws/tracker rows ensured."
            )
        )
