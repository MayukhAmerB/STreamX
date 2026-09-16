from django.core.management.base import BaseCommand
from django.db import transaction

from apps.courses.models import Course, Section
from apps.courses.program_catalog import PROGRAMS


class Command(BaseCommand):
    help = "Create source-based program records without changing any existing course, price or enrollment."

    def add_arguments(self, parser):
        parser.add_argument("--publish", action="store_true", help="Publish newly created programs only.")

    @transaction.atomic
    def handle(self, *args, **options):
        for source in PROGRAMS:
            if Course.objects.filter(slug=source["slug"]).exists():
                self.stdout.write(f"Existing program {source['slug']} retained unchanged.")
                continue
            values = dict(source)
            modules = values.pop("modules")
            values.pop("image_asset", None)
            values["is_flagship"] = not Course.objects.filter(category=values["category"], is_flagship=True).exists()
            values["is_published"] = options["publish"]
            course = Course(**values)
            course.full_clean()
            course.save()
            for order, (title, description, topics) in enumerate(modules, 1):
                Section.objects.create(course=course, title=title, description=description, order=order, topics=topics)
            self.stdout.write(
                self.style.SUCCESS(
                    f"Created {'published' if course.is_published else 'draft'} program #{course.pk}: {course.title}. Existing records retained."
                )
            )
