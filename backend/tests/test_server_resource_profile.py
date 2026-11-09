import importlib.util
import subprocess
import tempfile
from datetime import timedelta
from pathlib import Path

from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.realtime.models import ServerResourceProfile
from apps.users.models import User

AGENT_PATH = Path(__file__).resolve().parents[2] / "infra" / "hostinger" / "ops-agent" / "resource_profile_agent.py"
TOKEN = "test-ops-agent-token-0123456789abcdef"


def load_agent():
    spec = importlib.util.spec_from_file_location("resource_profile_agent", AGENT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AdminProfileBarTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser(email="ops-admin@test.com", password="StrongPass@123", full_name="Ops")
        self.client.force_login(self.admin)

    def test_admin_home_shows_the_profile_bar(self):
        response = self.client.get(reverse("admin:index"))

        self.assertContains(response, "Server profile")
        for label in ("Content", "Broadcast", "Meeting"):
            self.assertContains(response, label)

    def test_switch_records_the_desired_profile(self):
        response = self.client.post(reverse("admin:realtime_serverresourceprofile_switch"), {"profile": "broadcast"})

        self.assertEqual(response.status_code, 302)
        profile = ServerResourceProfile.get_solo()
        self.assertEqual(profile.profile, "broadcast")
        self.assertEqual(profile.updated_by, self.admin)

    def test_switch_rejects_unknown_profiles_and_get(self):
        self.client.post(reverse("admin:realtime_serverresourceprofile_switch"), {"profile": "rm -rf"})
        self.assertEqual(ServerResourceProfile.get_solo().profile, "content")
        self.assertEqual(self.client.get(reverse("admin:realtime_serverresourceprofile_switch")).status_code, 405)

    def test_staff_without_permission_cannot_switch_or_see_the_bar(self):
        staff = User.objects.create_user(email="staff@test.com", password="StrongPass@123", full_name="Staff", is_staff=True)
        self.client.force_login(staff)

        self.assertNotContains(self.client.get(reverse("admin:index")), "Server profile")
        response = self.client.post(reverse("admin:realtime_serverresourceprofile_switch"), {"profile": "broadcast"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(ServerResourceProfile.get_solo().profile, "content")

    def test_status_reflects_the_agent(self):
        profile = ServerResourceProfile.get_solo()
        self.assertIn("offline", profile.status_label())
        profile.agent_last_seen_at = timezone.now()
        profile.applied_profile = "content"
        self.assertEqual(profile.status_label(), "Applied")
        profile.profile = "broadcast"
        self.assertEqual(profile.status_label(), "Applying...")
        profile.agent_last_seen_at = timezone.now() - timedelta(minutes=5)
        self.assertIn("offline", profile.status_label())


@override_settings(OPS_AGENT_TOKEN=TOKEN)
class InternalProfileEndpointTests(TestCase):
    desired_url = "/api/internal/ops/resource-profile/"
    report_url = "/api/internal/ops/resource-profile/report/"

    def auth(self, token=TOKEN):
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def test_desired_profile_requires_the_agent_token(self):
        self.assertEqual(self.client.get(self.desired_url).status_code, 401)
        self.assertEqual(self.client.get(self.desired_url, **self.auth("wrong")).status_code, 401)

        response = self.client.get(self.desired_url, **self.auth())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"], {"profile": "content"})

    @override_settings(OPS_AGENT_TOKEN="")
    def test_endpoints_do_not_exist_without_a_configured_token(self):
        self.assertEqual(self.client.get(self.desired_url, **self.auth()).status_code, 404)

    def test_report_records_the_applied_profile(self):
        response = self.client.post(
            self.report_url, {"applied_profile": "broadcast", "error": ""}, content_type="application/json", **self.auth()
        )

        self.assertEqual(response.status_code, 200)
        profile = ServerResourceProfile.get_solo()
        self.assertEqual(profile.applied_profile, "broadcast")
        self.assertIsNotNone(profile.agent_last_seen_at)

    def test_report_rejects_unknown_profiles(self):
        response = self.client.post(
            self.report_url, {"applied_profile": "evil"}, content_type="application/json", **self.auth()
        )
        self.assertEqual(response.status_code, 400)


def completed(stdout="", returncode=0):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr="" if returncode == 0 else "boom")


class FakeDocker:
    """Two owncast containers on 1.5 cores, one backend already on 2.0."""

    def __init__(self):
        self.nano = {"own1": 1_500_000_000, "back1": 2_000_000_000}
        self.services = {"owncast": ["own1"], "backend": ["back1"]}
        self.updates = []

    def __call__(self, cmd, **kwargs):
        args = cmd[1:]
        if args[0] == "ps":
            prefix = "label=com.docker.compose.service="
            service = next(a[len(prefix):] for a in args if a.startswith(prefix))
            return completed("\n".join(self.services.get(service, [])))
        if args[0] == "inspect":
            return completed(str(self.nano[args[-1]]))
        if args[0] == "update":
            cpus, container = args[2], args[3]
            self.updates.append((container, cpus))
            self.nano[container] = int(round(float(cpus) * 1_000_000_000))
            return completed()
        raise AssertionError(cmd)


class ResourceProfileAgentTests(TestCase):
    def setUp(self):
        self.agent = load_agent()
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / "broadcast.env").write_text("# day profile\nOWNCAST_CPUS=3.0\nBACKEND_CPUS=2.0\nUNKNOWN_KEY=9\n")
        (self.dir / "content.env").write_text("OWNCAST_CPUS=1.5\nBACKEND_CPUS=2.0\n")
        (self.dir / "bad.env").write_text("OWNCAST_CPUS=3; reboot\n")
        self.env_file = self.dir / ".env.production"
        self.env_file.write_text("SECRET=keep\nOWNCAST_CPUS=1.5\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_load_profile_accepts_only_allow_listed_names_and_numeric_values(self):
        self.assertEqual(self.agent.load_profile(self.dir, "broadcast"), {"OWNCAST_CPUS": "3.0", "BACKEND_CPUS": "2.0"})
        with self.assertRaises(self.agent.AgentError):
            self.agent.load_profile(self.dir, "../etc/passwd")
        (self.dir / "meeting.env").write_text("OWNCAST_CPUS=3; reboot\n")
        with self.assertRaises(self.agent.AgentError):
            self.agent.load_profile(self.dir, "meeting")

    def test_reconcile_updates_only_containers_that_differ(self):
        docker = FakeDocker()

        updated = self.agent.reconcile({"OWNCAST_CPUS": "3.0", "BACKEND_CPUS": "2.0"}, "streamx", runner=docker)

        self.assertEqual(updated, 1)
        self.assertEqual(docker.updates, [("own1", "3.0")])
        self.assertEqual(self.agent.reconcile({"OWNCAST_CPUS": "3.0"}, "streamx", runner=docker), 0)

    def test_persist_env_updates_values_and_keeps_other_settings(self):
        self.assertTrue(self.agent.persist_env(self.env_file, {"OWNCAST_CPUS": "3.0", "BACKEND_CPUS": "2.0"}))
        content = self.env_file.read_text()
        self.assertIn("SECRET=keep", content)
        self.assertIn("OWNCAST_CPUS=3.0", content)
        self.assertIn("BACKEND_CPUS=2.0", content)
        self.assertFalse(self.agent.persist_env(self.env_file, {"OWNCAST_CPUS": "3.0", "BACKEND_CPUS": "2.0"}))

    def test_run_cycle_applies_and_reports(self):
        class Client:
            reports = []

            def desired_profile(self):
                return "broadcast"

            def report(self, applied, error=""):
                self.reports.append((applied, error))

        client, docker = Client(), FakeDocker()

        applied, error = self.agent.run_cycle(client, self.dir, "streamx", self.env_file, runner=docker)

        self.assertEqual((applied, error), ("broadcast", ""))
        self.assertEqual(client.reports, [("broadcast", "")])
        self.assertIn("OWNCAST_CPUS=3.0", self.env_file.read_text())

    def test_run_cycle_reports_docker_failures(self):
        class Client:
            reports = []

            def desired_profile(self):
                return "broadcast"

            def report(self, applied, error=""):
                self.reports.append((applied, error))

        def failing_docker(cmd, **kwargs):
            if cmd[1] == "update":
                return completed(returncode=1)
            return FakeDocker()(cmd, **kwargs)

        client = Client()
        applied, error = self.agent.run_cycle(client, self.dir, "streamx", self.env_file, runner=failing_docker)

        self.assertEqual(applied, "")
        self.assertIn("docker update --cpus failed", error)
        self.assertEqual(client.reports[0][0], "")
        self.assertIn("OWNCAST_CPUS=1.5", self.env_file.read_text())
