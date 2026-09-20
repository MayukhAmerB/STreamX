from apps.courses.admin import (
    _parse_admin_list_field,
    _parse_course_card_features,
    _parse_public_curriculum,
)
from apps.courses.models import (
    default_course_card_features,
    sanitize_course_card_features,
    sanitize_public_curriculum,
)
from django.core.exceptions import ValidationError
from django.test import SimpleTestCase


class CourseAdminListParsingTests(SimpleTestCase):
    def test_python_style_list_is_saved_as_clean_items(self):
        raw = "['OSINT fundamentals', 'search engine intelligence', 'domain intelligence']"

        self.assertEqual(
            _parse_admin_list_field(raw),
            ["OSINT fundamentals", "search engine intelligence", "domain intelligence"],
        )

    def test_newline_input_remains_supported(self):
        self.assertEqual(
            _parse_admin_list_field("OSINT fundamentals\ndomain intelligence"),
            ["OSINT fundamentals", "domain intelligence"],
        )


class CourseCardFeatureParsingTests(SimpleTestCase):
    def test_new_courses_receive_the_reference_feature_set(self):
        features = default_course_card_features()

        self.assertEqual(len(features), 6)
        self.assertEqual(features[0]["title"], "Live Sessions")
        self.assertEqual(features[-1]["title"], "24x7 Team Chat Support")

    def test_admin_lines_are_converted_to_structured_features(self):
        features = _parse_course_card_features(
            "live | Instructor Sessions | Join the instructor in real time.\n"
            "certificate | Verified Certificate | Receive a completion certificate."
        )

        self.assertEqual(
            features,
            [
                {
                    "icon": "live",
                    "title": "Instructor Sessions",
                    "description": "Join the instructor in real time.",
                },
                {
                    "icon": "certificate",
                    "title": "Verified Certificate",
                    "description": "Receive a completion certificate.",
                },
            ],
        )

    def test_blank_admin_value_restores_defaults(self):
        self.assertEqual(_parse_course_card_features(""), default_course_card_features())

    def test_active_content_is_rejected(self):
        with self.assertRaises(ValidationError):
            sanitize_course_card_features(
                [
                    {
                        "icon": "check",
                        "title": "<script>alert(1)</script>",
                        "description": "Unsafe title",
                    }
                ]
            )


class PublicCurriculumParsingTests(SimpleTestCase):
    def test_admin_lines_create_public_modules_without_touching_lessons(self):
        modules = _parse_public_curriculum(
            "Search Intelligence | Search-engine research | Google Dorking; Yandex Dorking\n"
            "Reporting | Evidence-led reporting | Source notes; Final report"
        )

        self.assertEqual(len(modules), 2)
        self.assertEqual(modules[0]["title"], "Search Intelligence")
        self.assertEqual(modules[0]["topics"], ["Google Dorking", "Yandex Dorking"])

    def test_public_curriculum_rejects_active_content(self):
        with self.assertRaises(ValidationError):
            sanitize_public_curriculum(
                [
                    {
                        "title": "Unsafe",
                        "description": "Public details",
                        "topics": ["<script>alert(1)</script>"],
                    }
                ]
            )
