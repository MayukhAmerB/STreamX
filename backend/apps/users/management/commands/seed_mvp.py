from decimal import Decimal

from django.core.management.base import BaseCommand

from apps.courses.models import Course, Lecture, LiveClass, Section
from apps.users.models import User


CATALOG_THUMBNAIL = "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg"
SEED_PLACEHOLDER_LECTURES = False

COURSE_CATALOG = [
    {
        "title": "OSINT Beginner",
        "category": Course.CATEGORY_OSINT,
        "level": Course.LEVEL_BEGINNER,
        "launch_status": Course.STATUS_LIVE,
        "price": Decimal("1499.00"),
        "description": "Foundational OSINT training for beginners: data collection basics, search operators, source validation, and ethical workflows.",
        "sections": [
            {
                "title": "Module 1: Introduction to OSINT",
                "description": (
                    "Month 1 foundation module introducing what OSINT is, where it is used, and how open sources support "
                    "basic intelligence gathering in a structured workflow."
                ),
                "lectures": [
                    "What OSINT is and core use cases",
                    "OSINT workflow overview and beginner setup",
                ],
            },
            {
                "title": "Module 2: Intelligence Lifecycle (Collection -> Analysis -> Reporting)",
                "description": (
                    "Covers the basic intelligence lifecycle so students understand how to collect information, analyze findings, "
                    "and present information clearly in a simple report."
                ),
                "lectures": [
                    "Collection and source gathering basics",
                    "Analysis, prioritization, and reporting fundamentals",
                ],
            },
            {
                "title": "Module 3: Legal & Ethical Considerations",
                "description": (
                    "Explains legal and ethical boundaries for OSINT practice, responsible handling of data, and safe behavior "
                    "while performing information gathering."
                ),
                "lectures": [
                    "Legal boundaries and responsible usage",
                    "Ethics, privacy, and safe information handling",
                ],
            },
            {
                "title": "Module 4: Search Engine Intelligence",
                "description": (
                    "Introduces beginner search engine intelligence techniques including operator-based searching, query refinement, "
                    "and identifying useful public-facing information."
                ),
                "lectures": [
                    "Search operators and query refinement",
                    "Practical search engine intelligence workflow",
                ],
            },
            {
                "title": "Module 5: Basic Social Media Intelligence (SOCMINT Basics)",
                "description": (
                    "Foundational SOCMINT module focused on basic profile discovery, public post observation, and responsible "
                    "collection of open social media information."
                ),
                "lectures": [
                    "Public profile discovery and verification",
                    "Basic SOCMINT collection and note-taking",
                ],
            },
        ],
    },
    {
        "title": "OSINT Intermediate",
        "category": Course.CATEGORY_OSINT,
        "level": Course.LEVEL_INTERMEDIATE,
        "launch_status": Course.STATUS_LIVE,
        "price": Decimal("2499.00"),
        "description": "Intermediate OSINT workflows covering target profiling, correlation, prioritization, and documentation for real investigations.",
        "sections": [
            {
                "title": "Module 1: People & Identity OSINT",
                "description": (
                    "Month 2 practical-skills module focused on tracking digital identities, correlating people-related data points, "
                    "and building reliable identity profiles from public sources."
                ),
                "lectures": ["Identity profiling workflow", "Cross-platform people correlation"],
            },
            {
                "title": "Module 2: Image & Video OSINT (Reverse Search, Metadata)",
                "description": (
                    "Covers image and video investigation fundamentals including reverse image search, basic metadata inspection, "
                    "and validation of visual content using open tools."
                ),
                "lectures": ["Reverse image search workflow", "Metadata basics and media verification"],
            },
            {
                "title": "Module 3: Website & Domain OSINT",
                "description": (
                    "Introduces practical website and domain intelligence collection techniques to identify ownership clues, "
                    "infrastructure signals, and useful public-facing information."
                ),
                "lectures": ["Domain and website footprint mapping", "Website intelligence collection techniques"],
            },
            {
                "title": "Module 4: OSINT Tools & Frameworks",
                "description": (
                    "Builds familiarity with professional OSINT tools and structured frameworks so students can work faster while "
                    "keeping investigations organized and repeatable."
                ),
                "lectures": ["Professional OSINT tool categories", "Framework-driven investigation workflow"],
            },
            {
                "title": "Module 5: Google Dorks & SOCMINT (Advanced Search Techniques)",
                "description": (
                    "Advanced search techniques for Google and social media intelligence, combining refined queries and platform-specific "
                    "search methods to uncover relevant public information."
                ),
                "lectures": ["Google dorking for OSINT use cases", "Advanced SOCMINT search techniques"],
            },
        ],
    },
    {
        "title": "OSINT Advanced",
        "category": Course.CATEGORY_OSINT,
        "level": Course.LEVEL_ADVANCED,
        "launch_status": Course.STATUS_LIVE,
        "price": Decimal("3999.00"),
        "description": "Advanced OSINT course focused on operational workflow design, evidence validation, and high-confidence reporting.",
        "sections": [
            {
                "title": "Module 1: Dark Web OSINT",
                "description": (
                    "Month 3 advanced investigation module introducing dark web OSINT concepts, operational safety, and structured "
                    "collection approaches for intelligence-led investigations."
                ),
                "lectures": ["Dark web OSINT overview and safety", "Collection workflow for dark web intelligence"],
            },
            {
                "title": "Module 2: Threat Actor Profiling",
                "description": (
                    "Focuses on identifying and profiling threat actors using behavioral indicators, public references, and structured "
                    "evidence correlation across multiple sources."
                ),
                "lectures": ["Threat actor profiling methodology", "Behavioral and infrastructure correlation"],
            },
            {
                "title": "Module 3: Geolocation & Chronolocation Techniques",
                "description": (
                    "Advanced location and time-based analysis techniques for validating where and when events happened using open data, "
                    "visual clues, and contextual evidence."
                ),
                "lectures": ["Geolocation workflow and visual clues", "Chronolocation and timeline reconstruction"],
            },
            {
                "title": "Module 4: Web Archive Analysis (Wayback, Historical Data)",
                "description": (
                    "Uses web archives and historical snapshots to investigate past states of websites, recover historical information, "
                    "and track changes over time for intelligence analysis."
                ),
                "lectures": ["Wayback and archive sources", "Historical data comparison and change analysis"],
            },
            {
                "title": "Module 5: Advanced OSINT Investigations",
                "description": (
                    "End-to-end advanced investigation module combining collection, validation, analysis, and reporting to produce "
                    "professional-grade intelligence outputs."
                ),
                "lectures": ["End-to-end investigation workflow", "Intelligence reporting and analytical outputs"],
            },
        ],
    },
    {
        "title": "Web Application Pentesting Beginner",
        "category": Course.CATEGORY_WEB_PENTESTING,
        "level": Course.LEVEL_BEGINNER,
        "launch_status": Course.STATUS_COMING_SOON,
        "price": Decimal("0.00"),
        "description": "Coming soon: a beginner-friendly web application pentesting track with fundamentals, setup, and testing mindset.",
        "sections": [],
    },
    {
        "title": "Web Application Pentesting Intermediate",
        "category": Course.CATEGORY_WEB_PENTESTING,
        "level": Course.LEVEL_INTERMEDIATE,
        "launch_status": Course.STATUS_COMING_SOON,
        "price": Decimal("0.00"),
        "description": "Coming soon: intermediate web application pentesting workflows with recon, auth testing, and validation practices.",
        "sections": [],
    },
    {
        "title": "Web Application Pentesting Advanced",
        "category": Course.CATEGORY_WEB_PENTESTING,
        "level": Course.LEVEL_ADVANCED,
        "launch_status": Course.STATUS_COMING_SOON,
        "price": Decimal("0.00"),
        "description": "Coming soon: advanced web application pentesting methodology for deeper testing scenarios and structured reporting.",
        "sections": [],
    },
]


class Command(BaseCommand):
    help = "Seed MVP data: instructor, student, and the Al syed Initiative catalog courses."

    def handle(self, *args, **options):
        instructor, _ = User.objects.get_or_create(
            email="instructor@example.com",
            defaults={
                "full_name": "Sample Instructor",
                "role": User.ROLE_INSTRUCTOR,
                "is_active": True,
            },
        )
        if not instructor.has_usable_password() or not instructor.check_password("Instructor@123"):
            instructor.set_password("Instructor@123")
            instructor.save(update_fields=["password"])

        student, _ = User.objects.get_or_create(
            email="student@example.com",
            defaults={
                "full_name": "Sample Student",
                "role": User.ROLE_STUDENT,
                "is_active": True,
            },
        )
        if not student.has_usable_password() or not student.check_password("Student@123"):
            student.set_password("Student@123")
            student.save(update_fields=["password"])

        seeded_count = 0
        for course_index, item in enumerate(COURSE_CATALOG, start=1):
            course, created = Course.objects.get_or_create(
                instructor=instructor,
                title=item["title"],
                defaults={
                    "description": item["description"],
                    "thumbnail": CATALOG_THUMBNAIL,
                    "price": item["price"],
                    "category": item["category"],
                    "level": item["level"],
                    "launch_status": item["launch_status"],
                    "is_published": True,
                },
            )
            if not created:
                course.description = item["description"]
                course.thumbnail = CATALOG_THUMBNAIL
                course.price = item["price"]
                course.category = item["category"]
                course.level = item["level"]
                course.launch_status = item["launch_status"]
                course.is_published = True
                course.save(
                    update_fields=[
                        "description",
                        "thumbnail",
                        "price",
                        "category",
                        "level",
                        "launch_status",
                        "is_published",
                        "updated_at",
                    ]
                )

            if item["sections"]:
                expected_section_titles = [section_data["title"] for section_data in item["sections"]]
                course.sections.exclude(title__in=expected_section_titles).delete()
                for section_order, section_data in enumerate(item["sections"], start=1):
                    section_title = section_data["title"]
                    lectures = section_data.get("lectures", []) if SEED_PLACEHOLDER_LECTURES else []
                    section, _ = Section.objects.get_or_create(
                        course=course,
                        title=section_title,
                        defaults={
                            "order": section_order,
                            "description": section_data.get("description", ""),
                        },
                    )
                    section_changed = False
                    if section.order != section_order:
                        section.order = section_order
                        section_changed = True
                    if section.description != section_data.get("description", ""):
                        section.description = section_data.get("description", "")
                        section_changed = True
                    if section_changed:
                        section.save(update_fields=["order", "description"])

                    section.lectures.exclude(title__in=lectures).delete()
                    for lecture_order, lecture_title in enumerate(lectures, start=1):
                        lecture, lecture_created = Lecture.objects.get_or_create(
                            section=section,
                            title=lecture_title,
                            defaults={
                                "description": "Seeded placeholder lecture for catalog preview.",
                                "video_key": f"catalog/{course.slug}/lecture-{section_order}-{lecture_order}.mp4",
                                "order": lecture_order,
                                "is_preview": lecture_order == 1,
                            },
                        )
                        if not lecture_created:
                            lecture_changed = False
                            desired_description = "Seeded placeholder lecture for catalog preview."
                            desired_video_key = (
                                f"catalog/{course.slug}/lecture-{section_order}-{lecture_order}.mp4"
                            )
                            desired_preview = lecture_order == 1
                            if lecture.order != lecture_order:
                                lecture.order = lecture_order
                                lecture_changed = True
                            if lecture.description != desired_description:
                                lecture.description = desired_description
                                lecture_changed = True
                            if lecture.video_key != desired_video_key:
                                lecture.video_key = desired_video_key
                                lecture_changed = True
                            if lecture.is_preview != desired_preview:
                                lecture.is_preview = desired_preview
                                lecture_changed = True
                            if lecture_changed:
                                lecture.save(
                                    update_fields=[
                                        "description",
                                        "video_key",
                                        "order",
                                        "is_preview",
                                        "updated_at",
                                    ]
                                )
            else:
                course.sections.all().delete()

            seeded_count += 1

        live_class_specs = [
            {
                "course_title": "OSINT Beginner",
                "title": "OSINT Live Class - Month 1 (Beginner)",
                "level": LiveClass.LEVEL_BEGINNER,
                "month_number": 1,
                "price": Decimal("1499.00"),
                "description": "Month 1 live classes for OSINT Beginner foundation training. Friday, Saturday, Sunday - 1 hour each class.",
            },
            {
                "course_title": "OSINT Intermediate",
                "title": "OSINT Live Class - Month 2 (Intermediate)",
                "level": LiveClass.LEVEL_INTERMEDIATE,
                "month_number": 2,
                "price": Decimal("2499.00"),
                "description": "Month 2 live classes for OSINT Intermediate practical skills. Friday, Saturday, Sunday - 1 hour each class.",
            },
            {
                "course_title": "OSINT Advanced",
                "title": "OSINT Live Class - Month 3 (Advanced)",
                "level": LiveClass.LEVEL_ADVANCED,
                "month_number": 3,
                "price": Decimal("3999.00"),
                "description": "Month 3 live classes for OSINT Advanced investigations and intelligence. Friday, Saturday, Sunday - 1 hour each class.",
            },
        ]

        for spec in live_class_specs:
            linked_course = Course.objects.filter(title=spec["course_title"]).first()
            if not linked_course:
                continue
            live_class, _ = LiveClass.objects.get_or_create(
                title=spec["title"],
                defaults={
                    "description": spec["description"],
                    "price": spec["price"],
                    "linked_course": linked_course,
                    "level": spec["level"],
                    "month_number": spec["month_number"],
                    "schedule_days": "Friday, Saturday, Sunday",
                    "class_duration_minutes": 60,
                    "is_active": True,
                },
            )
            changed = False
            for field, value in {
                "description": spec["description"],
                "price": spec["price"],
                "linked_course": linked_course,
                "level": spec["level"],
                "month_number": spec["month_number"],
                "schedule_days": "Friday, Saturday, Sunday",
                "class_duration_minutes": 60,
                "is_active": True,
            }.items():
                if getattr(live_class, field) != value:
                    setattr(live_class, field, value)
                    changed = True
            if changed:
                live_class.save()

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded users, {seeded_count} catalog courses, and OSINT live classes."
            )
        )

