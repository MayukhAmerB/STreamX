"""Owner privacy rule: inside the application students see each other by HANDLE only.

Real names appear ONLY on certificates (the certificate page/PDF and its
delivery to the student). These tests create students with distinctive real
names and e-mails, call every student-facing surface as ANOTHER student (or
anonymously) and fail if a response contains the other student's real name
or e-mail. They also cover the automatic handle generator and its command.
"""

from __future__ import annotations

import io
import json
import re
from datetime import date, timedelta

from apps.courses.engagement.models import LectureComment
from apps.courses.models import CourseReview
from apps.engagement import rules
from apps.engagement import services as engagement_services
from apps.profiles import handles
from apps.profiles import services as profile_services
from apps.profiles.models import StudentProfile
from django.core.cache import cache
from django.core.management import call_command
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from tests import factories as f
from tests.engagement_support import item, reset_engagement_state

ON = {"teaching": True, "engagement": True, "monthly_ctf": True, "public_profiles": True}

TARGETS = (
    ("Zenobia Quartermaine", "zenobia.quartermaine@privacy-scan.test"),
    ("Bartholomew Ironwood", "bartholomew.ironwood@privacy-scan.test"),
)


def secrets_of(user) -> list[str]:
    """Every fragment of a student's identity that must never reach another student."""
    name = str(user.full_name or "")
    email = str(user.email or "")
    parts = [name, email, email.split("@", 1)[0]]
    parts += [token for token in re.split(r"[\s.]+", name) if len(token) >= 4]
    return [part for part in parts if part]


@override_settings(FEATURE_DEFAULT_OVERRIDES=ON)
class PrivacyScanTests(TestCase):
    def setUp(self):
        super().setUp()
        cache.clear()
        reset_engagement_state()
        self.batch = f.make_course(title="Privacy Batch")
        self.lecture = f.make_lecture(section=f.make_section(course=self.batch), video_key="videos/p.mp4")
        self.targets = [f.make_user(full_name=name, email=email) for name, email in TARGETS]
        self.viewer = f.make_user(full_name="Viewer Person", email="viewer.person@privacy-scan.test")
        for user in (*self.targets, self.viewer):
            f.make_enrollment(user=user, course=self.batch)

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    # --- helpers ---------------------------------------------------------------------------------
    def as_viewer(self) -> APIClient:
        client = APIClient()
        client.force_authenticate(self.viewer)
        return client

    def assert_no_identity(self, response, surface: str):
        self.assertLess(response.status_code, 400, f"{surface}: {response.status_code} {response.content[:300]!r}")
        body = response.content.decode("utf-8", errors="replace")
        lowered = body.lower()
        for target in self.targets:
            for secret in secrets_of(target):
                self.assertNotIn(secret.lower(), lowered, f"{surface} leaked {secret!r} of another student")
        return body

    def give(self, user, points, key):
        with self.captureOnCommitCallbacks(execute=True):
            return engagement_services.award(user.pk, item(rules.KIND_MANUAL, points, key))

    # --- surfaces -----------------------------------------------------------------------------------
    def test_engagement_leaderboards_show_handles_only(self):
        for index, target in enumerate(self.targets):
            self.give(target, 300 + index, f"privacy-{index}")
        for period in ("week", "all"):
            response = self.as_viewer().get("/api/engagement/leaderboard/", {"period": period})
            body = self.assert_no_identity(response, f"leaderboard {period}")
            for target in self.targets:
                self.assertIn(handles.public_handle(target), body)

    def test_public_profile_shows_the_handle_only(self):
        target = self.targets[0]
        profile = profile_services.get_or_create_profile(target)
        profile_services.publish(profile, actor=target)
        response = self.as_viewer().get(f"/api/profiles/u/{profile.handle}/")
        body = self.assert_no_identity(response, "public profile")
        self.assertIn(profile.handle, body)
        self.assertIsNone(response.json()["data"]["header"]["real_name"])

    def test_monthly_ctf_board_and_hall_of_fame_show_handles_only(self):
        from apps.ctf import season_services as ctf

        from tests.test_monthly_ctf import ANSWER, make_season

        now = timezone.now()
        season = make_season(month=date(2026, 10, 1), opens_at=now - timedelta(hours=2), closes_at=now + timedelta(minutes=5))
        for index, target in enumerate(self.targets):
            ctf.submit_answer(season, target, ANSWER, now=now - timedelta(minutes=50 - index))
        client = self.as_viewer()
        self.assert_no_identity(client.get(reverse("ctf-season-leaderboard", args=[season.slug])), "ctf leaderboard")
        ctf.finalise(season, now=now + timedelta(minutes=10))
        cache.clear()
        board = self.assert_no_identity(client.get(reverse("ctf-season-leaderboard", args=[season.slug])), "ctf final board")
        self.assertIn(handles.public_handle(self.targets[0]), board)
        hall = self.assert_no_identity(client.get(reverse("ctf-season-hall-of-fame")), "ctf hall of fame")
        self.assertIn(handles.public_handle(self.targets[0]), hall)
        self.assert_no_identity(APIClient().get(reverse("ctf-season-hall-of-fame")), "ctf hall of fame (anonymous)")

    def test_certification_hall_of_fame_shows_handles_only(self):
        try:
            from apps.certification.models import HallOfFameEntry
        except ImportError:  # pragma: no cover - the app is installed in this project
            self.skipTest("apps.certification is not installed")
        for target in self.targets:
            profile_services.get_or_create_profile(target)
            HallOfFameEntry.objects.create(user=target, batch_label="Batch 1", achievement="Certified OSINT Investigator")
        response = APIClient().get(reverse("certification-hall-of-fame"))
        body = self.assert_no_identity(response, "certification hall of fame")
        # Automatic "operative_" handles are not public: graduates wait until they choose one.
        self.assertNotIn(handles.AUTO_PREFIX, body)
        profile = profile_services.get_or_create_profile(self.targets[0])
        profile.handle, profile.handle_auto = "chosen_falcon", False
        profile.save()
        response = APIClient().get(reverse("certification-hall-of-fame"))
        body = self.assert_no_identity(response, "certification hall of fame (chosen handle)")
        self.assertIn("chosen_falcon", body)
        self.assertNotIn(handles.AUTO_PREFIX, body)

    def test_lecture_comments_show_student_handles(self):
        target = self.targets[0]
        LectureComment.objects.create(lecture=self.lecture, user=target, body="Great walkthrough of the pivot.")
        response = self.as_viewer().get(reverse("lecture-comments", kwargs={"pk": self.lecture.pk}))
        body = self.assert_no_identity(response, "lecture comments")
        self.assertIn(handles.public_handle(target), body)

    def test_course_reviews_show_handles(self):
        target = self.targets[0]
        CourseReview.objects.create(course=self.batch, student=target, rating=5, text="Clear, practical and demanding.")
        response = APIClient().get(f"/api/courses/{self.batch.pk}/experience/")
        body = self.assert_no_identity(response, "course reviews")
        self.assertIn(handles.public_handle(target), body)

    def test_achievement_page_shows_the_handle_but_the_certificate_keeps_the_real_name(self):
        from apps.engagement.models import Achievement, Certificate

        target = self.targets[0]
        self.give(target, rules.LEVELS[1].min_xp + 10, "privacy-level")
        achievement = Achievement.objects.filter(user=target).order_by("earned_at", "id").first()
        self.assertIsNotNone(achievement)
        response = APIClient().get(f"/api/engagement/achievements/{achievement.slug}/")
        body = self.assert_no_identity(response, "achievement page")
        self.assertIn(handles.public_handle(target), body)
        # The certificate is the one place the real name is printed (owner rule).
        certificate = Certificate.objects.get(achievement=achievement)
        self.assertEqual(certificate.recipient_name, target.full_name)

    def test_live_meeting_names_are_handles_for_students(self):
        from apps.realtime.services import build_participant_metadata

        target = self.targets[0]
        metadata = build_participant_metadata(user=target)
        text = json.dumps(metadata)
        for secret in secrets_of(target):
            self.assertNotIn(secret.lower(), text.lower())
        self.assertEqual(metadata["full_name"], handles.public_handle(target))
        instructor = f.make_instructor(full_name="Instructor Realname")
        self.assertEqual(build_participant_metadata(user=instructor)["full_name"], "Instructor Realname")

    def test_ctf_certificate_prints_the_real_name(self):
        from apps.ctf.season_identity import certificate_name, public_name

        target = self.targets[0]
        self.assertEqual(certificate_name(target), target.full_name)
        self.assertEqual(public_name(target, real_names=True), handles.public_handle(target))


class HandleGeneratorTests(TestCase):
    def test_derived_handles_are_valid_stable_unique_and_non_identifying(self):
        users = [f.make_user(full_name=f"Person Number{i}", email=f"person{i}@example.test") for i in range(40)]
        values = [handles.derived_handle(user.pk) for user in users]
        self.assertEqual(len(set(values)), len(values))
        for user, value in zip(users, values, strict=True):
            self.assertRegex(value, r"^operative_[a-z2-7]{6}$")
            self.assertTrue(profile_services.HANDLE_PATTERN.match(value))
            self.assertEqual(value, handles.derived_handle(user.pk))
            self.assertNotIn("person", value)
            self.assertNotEqual(handles.derived_handle(user.pk, 1), value)

    def test_public_handles_one_query_and_fallback_matches_the_assigned_handle(self):
        users = [f.make_user() for _ in range(5)]
        profile_services.get_or_create_profile(users[0])
        StudentProfile.objects.filter(user=users[0]).update(handle="night_owl_42", handle_auto=False)
        with CaptureQueriesContext(connection) as queries:
            result = handles.public_handles([user.pk for user in users] + [999999])
        self.assertEqual(len(queries.captured_queries), 1)
        self.assertNotIn(999999, result)
        self.assertEqual(result[users[0].pk], "night_owl_42")
        expected = handles.derived_handle(users[1].pk)
        self.assertEqual(result[users[1].pk], expected)
        call_command("generate_missing_handles", "--apply", "--sleep", "0", stdout=io.StringIO())
        self.assertEqual(StudentProfile.objects.get(user=users[1]).handle, expected)

    def test_command_dry_run_writes_nothing_then_apply_is_idempotent_and_revertible(self):
        students = [f.make_user() for _ in range(3)]
        staff = f.make_admin()
        out = io.StringIO()
        call_command("generate_missing_handles", stdout=out)
        self.assertIn("DRY RUN", out.getvalue())
        self.assertEqual(StudentProfile.objects.count(), 0)
        call_command("generate_missing_handles", "--apply", "--sleep", "0", stdout=io.StringIO())
        profiles = StudentProfile.objects.filter(user__in=students)
        self.assertEqual(profiles.count(), 3)
        self.assertFalse(StudentProfile.objects.filter(user=staff).exists())
        self.assertTrue(all(profile.handle_auto and handles.is_auto_handle(profile.handle) for profile in profiles))
        before = sorted(profiles.values_list("handle", flat=True))
        call_command("generate_missing_handles", "--apply", "--sleep", "0", stdout=io.StringIO())
        self.assertEqual(sorted(StudentProfile.objects.filter(user__in=students).values_list("handle", flat=True)), before)
        # A student who customised the handle keeps the profile on revert.
        touched = profiles.first()
        profile_services.change_handle(touched, "quiet_cipher_7", actor=touched.user)
        call_command("generate_missing_handles", "--revert", "--apply", stdout=io.StringIO())
        self.assertEqual(list(StudentProfile.objects.values_list("handle", flat=True)), ["quiet_cipher_7"])

    def test_students_cannot_pick_an_automatic_looking_handle(self):
        user = f.make_user()
        profile = profile_services.get_or_create_profile(user)
        other = f.make_user()
        from apps.core.errors import ValidationFailed

        with self.assertRaises(ValidationFailed):
            profile_services.validate_handle(handles.derived_handle(other.pk), user=user, profile=profile)
        # Keeping one's own automatic handle is fine.
        self.assertEqual(profile_services.validate_handle(profile.handle, user=user, profile=profile), profile.handle)


@override_settings(FEATURE_DEFAULT_OVERRIDES=ON)
class HandlePromptTests(TestCase):
    def test_prompt_shows_once_until_customised_or_dismissed(self):
        user = f.make_user()
        client = APIClient()
        client.force_authenticate(user)
        data = client.get("/api/profiles/me/").json()["data"]
        self.assertTrue(data["handle_auto"])
        self.assertTrue(data["handle_prompt"])
        response = client.post("/api/profiles/me/handle/prompt/dismiss/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(response.json()["data"]["handle_prompt"])
        self.assertTrue(response.json()["data"]["handle_auto"])
        self.assertFalse(client.get("/api/profiles/me/").json()["data"]["handle_prompt"])

        other = f.make_user()
        client.force_authenticate(other)
        client.get("/api/profiles/me/")
        data = client.post("/api/profiles/me/handle/", {"handle": "steady_lantern"}, format="json").json()["data"]
        self.assertEqual((data["handle"], data["handle_auto"], data["handle_prompt"]), ("steady_lantern", False, False))
        self.assertEqual(handles.public_handle(other), "steady_lantern")


# --- every student-facing endpoint ------------------------------------------------------------------
# Certificates are the one place a real name is printed (owner rule); staff and
# admin endpoints answer 403 to a student, so the sweep reads them harmlessly.
SWEEP_EXEMPT_URL_PARTS = ("certificate",)
_ROUTE_PARAM = re.compile(r"<(?:(\w+):)?(\w+)>")


def _walk_routes(patterns, prefix=""):
    """Every concrete route (``api/courses/<int:pk>/experience/``) of the URLconf."""
    from django.urls import URLPattern, URLResolver

    for pattern in patterns:
        route = str(pattern.pattern)
        if route.startswith("^") or any(char in route for char in "()[]?*+$\\"):
            continue  # regex routes (re_path): not swept
        if isinstance(pattern, URLResolver):
            yield from _walk_routes(pattern.url_patterns, prefix + route)
        elif isinstance(pattern, URLPattern):
            yield prefix + route


@override_settings(FEATURE_DEFAULT_OVERRIDES=ON)
class EndpointSweepPrivacyTests(TestCase):
    """GET every named ``/api/`` endpoint as ANOTHER student (and anonymously),
    filling URL parameters with the ids, slugs and handles of the targets' data,
    and fail if any response carries a target's real name or e-mail."""

    def setUp(self):
        super().setUp()
        cache.clear()
        reset_engagement_state()
        from apps.ctf import season_services as ctf

        from tests.test_monthly_ctf import ANSWER, make_season

        self.batch = f.make_course(title="Sweep Batch")
        self.lecture = f.make_lecture(section=f.make_section(course=self.batch), video_key="videos/s.mp4")
        self.targets = [f.make_user(full_name=name, email=email) for name, email in TARGETS]
        self.viewer = f.make_user(full_name="Viewer Person", email="viewer.person@privacy-scan.test")
        for user in (*self.targets, self.viewer):
            f.make_enrollment(user=user, course=self.batch)
        self.profiles = []
        for index, target in enumerate(self.targets):
            profile = profile_services.get_or_create_profile(target)
            profile_services.publish(profile, actor=target)
            self.profiles.append(profile)
            with self.captureOnCommitCallbacks(execute=True):
                engagement_services.award(
                    target.pk, item(rules.KIND_MANUAL, rules.LEVELS[1].min_xp + 10 + index, f"sweep-{index}")
                )
            self.comment = LectureComment.objects.create(lecture=self.lecture, user=target, body="Sharp pivot here.")
            CourseReview.objects.create(course=self.batch, student=target, rating=5, text="Clear and practical.")
        now = timezone.now()
        self.season = make_season(
            month=date(2026, 9, 1), opens_at=now - timedelta(hours=2), closes_at=now + timedelta(minutes=5)
        )
        for index, target in enumerate(self.targets):
            ctf.submit_answer(self.season, target, ANSWER, now=now - timedelta(minutes=50 - index))
        ctf.finalise(self.season, now=now + timedelta(minutes=10))
        from apps.engagement.models import Achievement

        self.achievement_slugs = list(Achievement.objects.filter(user__in=self.targets).values_list("slug", flat=True))
        cache.clear()

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def _candidates(self, name: str) -> list:
        if name == "handle":
            return [profile.handle for profile in self.profiles]
        if name == "slug":
            return [self.season.slug, *self.achievement_slugs[:2]]
        if name in {"ref", "token", "key", "code", "path", "uuid", "filename", "file_path"}:
            return []
        return [self.batch.pk, self.lecture.pk, *[target.pk for target in self.targets], self.comment.pk]

    def _urls(self):
        from itertools import product

        from django.urls import get_resolver

        seen = set()
        for route in _walk_routes(get_resolver().url_patterns):
            if not route.startswith("api/") or any(part in route for part in SWEEP_EXEMPT_URL_PARTS):
                continue
            params = _ROUTE_PARAM.findall(route)
            choices = [self._candidates(name) for _converter, name in params]
            if any(not values for values in choices):
                continue
            for combo in product(*choices):
                values = iter(combo)
                url = "/" + _ROUTE_PARAM.sub(lambda _match: str(next(values)), route)
                if url not in seen:
                    seen.add(url)
                    yield route, url

    def _scan(self, client, label):
        from unittest import mock

        from rest_framework.throttling import SimpleRateThrottle

        client.raise_request_exception = False
        leaks, scanned = [], 0
        for name, url in self._urls():
            with mock.patch.object(SimpleRateThrottle, "allow_request", return_value=True):
                response = client.get(url)
            content_type = response.get("Content-Type", "")
            if getattr(response, "streaming", False) or not any(
                kind in content_type for kind in ("json", "text", "html", "xml")
            ):
                continue
            scanned += 1
            body = response.content.decode("utf-8", errors="replace").lower()
            for target in self.targets:
                for secret in secrets_of(target):
                    if secret.lower() in body:
                        leaks.append(f"{label} {name} {url} [{response.status_code}] leaked {secret!r}")
        return scanned, leaks

    def test_no_student_facing_endpoint_leaks_another_students_identity(self):
        viewer = APIClient()
        viewer.force_authenticate(self.viewer)
        scanned, leaks = self._scan(viewer, "student")
        anonymous_scanned, anonymous_leaks = self._scan(APIClient(), "anonymous")
        self.assertGreater(scanned, 100, "the sweep should reach the API surface")
        self.assertGreater(anonymous_scanned, 100)
        self.assertEqual(leaks + anonymous_leaks, [], "\n".join(leaks + anonymous_leaks))


class SignupHandleTests(TestCase):
    def test_new_student_gets_an_automatic_handle_after_signup_commits(self):
        with self.captureOnCommitCallbacks(execute=True):
            student = f.make_user(full_name="Fresh Signup", email="fresh.signup@example.test")
        profile = StudentProfile.objects.get(user=student)
        self.assertTrue(profile.handle_auto)
        self.assertEqual(profile.handle, handles.derived_handle(student.pk))
        self.assertIsNone(profile.published_at)
        self.assertNotIn("fresh", profile.handle)
        self.assertTrue(profile_services.handle_prompt_pending(profile))

    def test_staff_and_instructors_do_not_get_one(self):
        with self.captureOnCommitCallbacks(execute=True):
            admin = f.make_admin()
            instructor = f.make_instructor()
        self.assertFalse(StudentProfile.objects.filter(user__in=[admin, instructor]).exists())

    def test_a_failure_never_breaks_the_signup(self):
        from unittest import mock

        with mock.patch("apps.profiles.services.create_auto_profile", side_effect=RuntimeError("boom")):
            with self.assertLogs("apps.profiles.signals", level="ERROR"):
                with self.captureOnCommitCallbacks(execute=True):
                    student = f.make_user()
        self.assertFalse(StudentProfile.objects.filter(user=student).exists())
        # The release command backfills it.
        call_command("generate_missing_handles", "--apply", "--sleep", "0", stdout=io.StringIO())
        self.assertTrue(StudentProfile.objects.filter(user=student).exists())


class GenerateMissingHandlesCommandTests(TestCase):
    def test_dry_run_by_default_then_apply_in_chunks_is_idempotent(self):
        students = [f.make_user(full_name=f"Chunk Person{i}", email=f"chunk{i}@example.test") for i in range(7)]
        out = io.StringIO()
        call_command("generate_missing_handles", stdout=out)
        self.assertIn("DRY RUN: 7 account(s)", out.getvalue())
        self.assertFalse(StudentProfile.objects.exists())
        out = io.StringIO()
        call_command("generate_missing_handles", "--apply", "--chunk-size", "3", "--sleep", "0", stdout=out)
        self.assertIn("Assigned 7 automatic handle(s).", out.getvalue())
        assigned = dict(StudentProfile.objects.values_list("user_id", "handle"))
        self.assertEqual(len(set(assigned.values())), 7)
        for student in students:
            self.assertRegex(assigned[student.pk], r"^operative_[a-z2-7]{6}$")
            self.assertNotIn("chunk", assigned[student.pk])
        out = io.StringIO()
        call_command("generate_missing_handles", "--apply", "--sleep", "0", stdout=out)
        self.assertIn("Assigned 0 automatic handle(s).", out.getvalue())
        self.assertEqual(dict(StudentProfile.objects.values_list("user_id", "handle")), assigned)

    def test_a_taken_automatic_handle_falls_back_to_the_next_unique_one(self):
        first, second = f.make_user(), f.make_user()
        # Simulate a collision: someone already holds the second account's automatic handle.
        profile_services.get_or_create_profile(first)
        StudentProfile.objects.filter(user=first).update(handle=handles.derived_handle(second.pk))
        call_command("generate_missing_handles", "--apply", "--sleep", "0", stdout=io.StringIO())
        handle = StudentProfile.objects.get(user=second).handle
        self.assertEqual(handle, handles.derived_handle(second.pk, 1))
        self.assertEqual(StudentProfile.objects.filter(handle=handle).count(), 1)

    def test_older_command_name_still_works(self):
        f.make_user()
        call_command("profiles_assign_handles", "--apply", "--sleep", "0", stdout=io.StringIO())
        self.assertEqual(StudentProfile.objects.count(), 1)


class PublicDisplayNameTests(TestCase):
    def test_students_show_their_handle_and_staff_keep_their_name(self):
        student = f.make_user(full_name="Private Student")
        instructor = f.make_instructor(full_name="Teaching Person")
        admin = f.make_admin(full_name="Admin Person")
        self.assertEqual(handles.public_display_name(student), handles.public_handle(student))
        self.assertNotIn("private", handles.public_display_name(student))
        self.assertEqual(handles.public_display_name(instructor), "Teaching Person")
        self.assertEqual(handles.public_display_name(admin), "Admin Person")
        self.assertEqual(handles.public_display_name(None), "")


@override_settings(FEATURE_DEFAULT_OVERRIDES=ON)
class StaffScreensKeepRealNamesTests(TestCase):
    """Staff/admin screens keep the identity pattern (roll number, real name, handle)."""

    def setUp(self):
        super().setUp()
        cache.clear()
        reset_engagement_state()
        self.batch = f.make_course(title="Staff Batch")
        self.student = f.make_user(full_name="Zenobia Quartermaine", email="zenobia.staff@privacy-scan.test")
        f.make_enrollment(user=self.student, course=self.batch)
        profile_services.get_or_create_profile(self.student)
        with self.captureOnCommitCallbacks(execute=True):
            engagement_services.award(self.student.pk, item(rules.KIND_MANUAL, 120, "staff-screen"))
        self.admin = f.make_admin(full_name="Admin Person")

    def tearDown(self):
        reset_engagement_state()
        super().tearDown()

    def test_staff_leaderboard_shows_real_name_email_and_handle(self):
        client = APIClient()
        client.force_authenticate(self.admin)
        response = client.get("/api/engagement/staff/leaderboard/", {"batch": self.batch.pk, "period": "all"})
        self.assertEqual(response.status_code, 200, response.content)
        entry = response.json()["data"]["entries"][0]
        self.assertEqual(entry["full_name"], "Zenobia Quartermaine")
        self.assertEqual(entry["email"], "zenobia.staff@privacy-scan.test")
        self.assertEqual(entry["handle"], handles.public_handle(self.student))

    def test_identity_block_and_django_admin_show_the_real_name(self):
        from apps.users import identity

        block = identity.identity_block(self.student)
        self.assertEqual(block["real_name"], "Zenobia Quartermaine")
        self.assertEqual(block["handle"], handles.public_handle(self.student))
        self.client.force_login(self.admin)
        response = self.client.get(reverse("admin:users_user_changelist"), {"q": "zenobia"})
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Zenobia Quartermaine")

    def test_the_student_sees_their_own_real_name_in_account_settings(self):
        client = APIClient()
        client.force_authenticate(self.student)
        response = client.get(reverse("auth-profile"))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("Zenobia Quartermaine", response.content.decode())
