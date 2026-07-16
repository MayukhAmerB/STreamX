from django.test import SimpleTestCase

from apps.courses.admin import _parse_admin_list_field


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
