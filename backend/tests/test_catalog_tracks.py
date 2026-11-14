from decimal import Decimal

from apps.core import features
from apps.courses.catalog_tracks import compute_catalog_tracks, get_catalog_tracks
from apps.courses.models import Course
from apps.users.models import User
from django.core.cache import cache
from django.test import TestCase, override_settings
from django.urls import reverse
from rest_framework.test import APITestCase


def make_course(instructor=None, **overrides):
    fields = {
        "title": "Course",
        "description": "Training",
        "price": Decimal("3500.00"),
        "is_published": True,
        "launch_status": Course.STATUS_LIVE,
        "registration_closed": False,
        "category": Course.CATEGORY_OSINT,
        "instructor": instructor,
    }
    fields.update(overrides)
    return Course.objects.create(**fields)


def track(tracks, key):
    return next(item for item in tracks if item["key"] == key)


class CatalogTracksComputationTests(TestCase):
    def setUp(self):
        cache.clear()
        # A switch written by an earlier TestCase never commits, so its
        # "pending write" marker (apps.core.features) would otherwise send
        # every feature read of this thread to the database.
        features._pending.dirty = False
        features.invalidate_cache()
        features.snapshot()  # prime the per-process memo outside the counted blocks

    def test_empty_catalog_lists_both_tracks_as_coming_soon(self):
        self.assertEqual(
            compute_catalog_tracks(),
            [
                {
                    "key": "osint",
                    "title": "Open Source Intelligence",
                    "state": "coming_soon",
                    "course_count": 0,
                    "open_course_count": 0,
                },
                {
                    "key": "web_pentesting",
                    "title": "Pentesting",  # D7: display label only; the key stays web_pentesting
                    "state": "coming_soon",
                    "course_count": 0,
                    "open_course_count": 0,
                },
            ],
        )

    def test_open_requires_a_published_live_open_course_with_a_priced_plan(self):
        make_course(title="OSINT open")
        # Coming soon: counted, never open.
        make_course(
            title="Pentest soon", category=Course.CATEGORY_WEB_PENTESTING, launch_status=Course.STATUS_COMING_SOON
        )
        # Live and open, but no payment plan switched on: counted, not purchasable.
        make_course(
            title="Pentest unpriced",
            category=Course.CATEGORY_WEB_PENTESTING,
            full_payment_enabled=False,
            installment_payment_enabled=False,
        )
        # Not in the current catalog at all.
        make_course(title="OSINT closed batch", registration_closed=True)
        make_course(title="OSINT draft", is_published=False)

        tracks = compute_catalog_tracks()

        self.assertEqual(
            track(tracks, "osint"),
            {
                "key": "osint",
                "title": "Open Source Intelligence",
                "state": "open",
                "course_count": 1,
                "open_course_count": 1,
            },
        )
        pentest = track(tracks, "web_pentesting")
        self.assertEqual(pentest["state"], "coming_soon")
        self.assertEqual(pentest["course_count"], 2)
        self.assertEqual(pentest["open_course_count"], 0)

    def test_a_zero_price_plan_does_not_make_a_track_open(self):
        make_course(price=Decimal("0.00"), monthly_price=Decimal("0.00"))
        self.assertEqual(track(compute_catalog_tracks(), "osint")["state"], "coming_soon")

    @override_settings(DIRECT_COURSE_PAYMENTS_ENABLED=False)
    def test_the_global_checkout_switch_does_not_relabel_tracks(self):
        make_course()
        self.assertEqual(track(compute_catalog_tracks(), "osint")["state"], "open")

    def test_one_query_however_many_courses(self):
        make_course()
        with self.assertNumQueries(1):
            compute_catalog_tracks()
        for index in range(6):
            make_course(title=f"More {index}", category=Course.CATEGORY_WEB_PENTESTING)
        with self.assertNumQueries(1):
            compute_catalog_tracks()

    def test_cached_until_a_course_changes(self):
        course = make_course(launch_status=Course.STATUS_COMING_SOON)
        self.assertEqual(track(get_catalog_tracks(), "osint")["state"], "coming_soon")
        with self.assertNumQueries(0):
            get_catalog_tracks()
        course.launch_status = Course.STATUS_LIVE
        course.save()  # bumps the course-list cache version
        self.assertEqual(track(get_catalog_tracks(), "osint")["state"], "open")


class CatalogTracksApiTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.instructor = User.objects.create_user(
            email="tracks-instructor@example.com", password="test-only-password", role=User.ROLE_INSTRUCTOR
        )
        self.osint = make_course(self.instructor, title="OSINT Professional")
        make_course(
            self.instructor,
            title="Pentesting soon",
            category=Course.CATEGORY_WEB_PENTESTING,
            launch_status=Course.STATUS_COMING_SOON,
        )

    def test_current_catalog_carries_tracks_next_to_the_course_array(self):
        for _ in range(2):  # second request is served from the anonymous list cache
            response = self.client.get(reverse("course-list-create"), {"catalog": "current"})
            self.assertEqual(response.status_code, 200)
            self.assertIsInstance(response.data["data"], list)
            self.assertEqual(len(response.data["data"]), 2)
            self.assertEqual(
                [
                    (item["key"], item["state"], item["course_count"], item["open_course_count"])
                    for item in response.data["tracks"]
                ],
                [("osint", "open", 1, 1), ("web_pentesting", "coming_soon", 1, 0)],
            )

    def test_signed_in_users_get_the_same_tracks(self):
        student = User.objects.create_user(email="tracks-student@example.com", password="test-only-password")
        self.client.force_authenticate(student)
        response = self.client.get(reverse("course-list-create"), {"catalog": "current"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(track(response.data["tracks"], "web_pentesting")["state"], "coming_soon")


class InstructorEmailPrivacyTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.instructor = User.objects.create_user(
            email="private-instructor@example.com",
            password="test-only-password",
            full_name="Course Instructor",
            role=User.ROLE_INSTRUCTOR,
        )
        self.course = make_course(self.instructor, title="OSINT Professional")

    def list_instructor(self):
        response = self.client.get(reverse("course-list-create"), {"catalog": "current"})
        self.assertEqual(response.status_code, 200)
        return next(item for item in response.data["data"] if item["id"] == self.course.id)["instructor"]

    def detail_instructor(self):
        response = self.client.get(reverse("course-detail", args=[self.course.id]))
        self.assertEqual(response.status_code, 200)
        return response.data["data"]["instructor"]

    def test_public_list_and_detail_omit_the_instructor_email(self):
        expected = {"id": self.instructor.id, "full_name": "Course Instructor"}
        self.assertEqual(self.list_instructor(), expected)
        self.assertEqual(self.detail_instructor(), expected)
        self.assertNotIn(
            "private-instructor@example.com", self.client.get(reverse("course-list-create")).content.decode()
        )

    def test_other_signed_in_students_do_not_see_it(self):
        student = User.objects.create_user(email="curious-student@example.com", password="test-only-password")
        self.client.force_authenticate(student)
        self.assertNotIn("email", self.list_instructor())
        self.assertNotIn("email", self.detail_instructor())

    def test_the_courses_own_instructor_and_staff_still_see_it(self):
        self.client.force_authenticate(self.instructor)
        self.assertEqual(self.list_instructor()["email"], "private-instructor@example.com")
        self.assertEqual(self.detail_instructor()["email"], "private-instructor@example.com")
        own = self.client.get(reverse("instructor-courses"))
        self.assertEqual(own.status_code, 200)
        self.assertEqual(own.data["data"][0]["instructor"]["email"], "private-instructor@example.com")

        staff = User.objects.create_superuser(email="tracks-admin@example.com", password="test-only-password")
        self.client.force_authenticate(staff)
        self.assertEqual(self.list_instructor()["email"], "private-instructor@example.com")
        self.assertEqual(self.detail_instructor()["email"], "private-instructor@example.com")
