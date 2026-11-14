"""Import/layering rules, enforced with ``ast`` (no extra dependencies).

1. ``apps.core`` imports no other app (apps depend on core, never the
   reverse), and the ``config.*`` modules it uses must be app-free too.
2. A views module never imports another app's views (share services, not
   HTTP handlers).
3. ``Enrollment``/``Payment`` rows are only bulk-updated (``.update(``) in
   their service modules, because ``QuerySet.update`` skips ``save()``,
   signals and audit logging. Existing offenders are allowlisted with a
   maximum count: the test passes today and fails on any NEW bypass. When
   you remove one, lower/delete its allowlist entry.
4. Instructor rights are granted only through ``apps/users/teaching.py``
   (the Teachers section switch, UI overhaul plan §5.3): a new
   ``role == "instructor"`` / ``ROLE_INSTRUCTOR`` comparison, an
   ``instructor_id == user.id`` check or an ``instructor_id=user`` /
   ``instructor=request.user`` filter outside the allowlist fails, so a new
   instructor branch cannot bypass the switch.
"""

from __future__ import annotations

import ast
from pathlib import Path

from django.test import SimpleTestCase

BACKEND_DIR = Path(__file__).resolve().parents[1]
APPS_DIR = BACKEND_DIR / "apps"
CONFIG_DIR = BACKEND_DIR / "config"

# Modules allowed to bulk-update Enrollment/Payment rows (state changes live here).
WRITE_SERVICE_MODULES = {
    "apps/payments/services.py",
    "apps/payments/provisioning.py",
    "apps/payments/refunds.py",
    "apps/payments/order_service.py",
    "apps/payments/entitlements.py",
    "apps/payments/batch_pass.py",
    "apps/courses/services.py",
}
# Current offenders (file -> max allowed occurrences). Migrate them into a
# service (Phase 2/4) and shrink this list; never grow it.
BULK_UPDATE_ALLOWLIST = {
    "apps/payments/credentials.py": 1,
}
# Cross-app views imports that exist today (file, imported module).
CROSS_APP_VIEWS_IMPORT_ALLOWLIST: set[tuple[str, str]] = set()

GUARDED_MODELS = {"Enrollment", "Payment"}


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))


def _python_files(root: Path):
    for path in sorted(root.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        yield path


def _rel(path: Path) -> str:
    return path.relative_to(BACKEND_DIR).as_posix()


def _imported_modules(tree: ast.Module):
    """Yield (lineno, absolute module, imported names) for absolute imports."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name, []
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            yield node.lineno, node.module, [alias.name for alias in node.names]


def _app_of(path: Path) -> str:
    return path.relative_to(APPS_DIR).parts[0]


def _is_views_module(path: Path) -> bool:
    inner = path.relative_to(APPS_DIR).parts[1:]
    return path.name == "views.py" or path.name.endswith("_views.py") or "views" in inner[:-1]


def _is_views_target(module: str, names: list[str]) -> bool:
    parts = module.split(".")
    if len(parts) >= 3 and (parts[2] == "views" or parts[2].endswith("_views")):
        return True
    return len(parts) == 2 and any(name == "views" or name.endswith("_views") for name in names)


class CoreLayeringTests(SimpleTestCase):
    def test_core_imports_no_app(self):
        violations = []
        config_modules = set()
        for path in _python_files(APPS_DIR / "core"):
            for lineno, module, _names in _imported_modules(_parse(path)):
                if module.startswith("apps.") and not module.startswith("apps.core"):
                    violations.append(f"{_rel(path)}:{lineno} imports {module}")
                if module.startswith("config."):
                    config_modules.add(module)
        for module in sorted(config_modules):
            config_path = BACKEND_DIR / (module.replace(".", "/") + ".py")
            if not config_path.exists():
                continue
            for lineno, imported, _names in _imported_modules(_parse(config_path)):
                if imported.startswith("apps.") and not imported.startswith("apps.core"):
                    violations.append(f"{_rel(config_path)}:{lineno} (used by apps.core) imports {imported}")
        self.assertEqual(violations, [], "apps.core must stay app-agnostic:\n" + "\n".join(violations))


class ViewsLayeringTests(SimpleTestCase):
    def test_views_do_not_import_other_apps_views(self):
        violations = []
        for path in _python_files(APPS_DIR):
            if not _is_views_module(path):
                continue
            app = _app_of(path)
            for lineno, module, names in _imported_modules(_parse(path)):
                parts = module.split(".")
                if len(parts) < 2 or parts[0] != "apps" or parts[1] == app:
                    continue
                if _is_views_target(module, names) and (_rel(path), module) not in CROSS_APP_VIEWS_IMPORT_ALLOWLIST:
                    violations.append(f"{_rel(path)}:{lineno} imports {module} {names or ''}".rstrip())
        self.assertEqual(
            violations,
            [],
            "Views must not import another app's views; move shared logic to a service module:\n"
            + "\n".join(violations),
        )


def _bulk_updates_of_guarded_models(tree: ast.Module):
    """Yield (lineno, model) for ``<Model>.objects....update(...)`` chains."""
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "update"):
            continue
        current = node.func.value
        chain = []
        while True:
            if isinstance(current, ast.Call):
                current = current.func
            elif isinstance(current, ast.Attribute):
                chain.append(current.attr)
                current = current.value
            elif isinstance(current, ast.Name):
                chain.append(current.id)
                break
            else:
                break
        if chain and chain[-1] in GUARDED_MODELS and "objects" in chain:
            yield node.lineno, chain[-1]


class EnrollmentPaymentWriteTests(SimpleTestCase):
    def test_no_new_bulk_updates_outside_service_modules(self):
        counts: dict[str, list[str]] = {}
        for path in _python_files(APPS_DIR):
            rel = _rel(path)
            if "migrations" in path.parts or "tests" in path.parts or path.name.startswith("test"):
                continue
            if rel in WRITE_SERVICE_MODULES:
                continue
            for lineno, model in _bulk_updates_of_guarded_models(_parse(path)):
                counts.setdefault(rel, []).append(f"{rel}:{lineno} {model}.objects...update()")
        violations = []
        for rel, hits in sorted(counts.items()):
            allowed = BULK_UPDATE_ALLOWLIST.get(rel, 0)
            if len(hits) > allowed:
                violations.extend(hits)
        self.assertEqual(
            violations,
            [],
            "QuerySet.update() on Enrollment/Payment bypasses save(), signals and audit. Use the "
            "service module (or allowlist with justification):\n" + "\n".join(violations),
        )

    def test_allowlist_has_no_stale_entries(self):
        stale = []
        for rel, allowed in BULK_UPDATE_ALLOWLIST.items():
            path = BACKEND_DIR / rel
            found = len(list(_bulk_updates_of_guarded_models(_parse(path)))) if path.exists() else 0
            if found < allowed:
                stale.append(f"{rel}: allowlisted {allowed}, found {found} -- shrink the allowlist")
        self.assertEqual(stale, [], "\n".join(stale))

    def test_detector_finds_the_pattern(self):
        tree = ast.parse(
            "Payment.objects.filter(pk=1).update(status='paid')\n"
            "Enrollment.objects.update(payment_status='paid')\n"
            "PaymentWebhookEvent.objects.filter().update(status='x')\n"
            "payment.update()\n"
        )
        self.assertEqual([model for _line, model in _bulk_updates_of_guarded_models(tree)], ["Payment", "Enrollment"])


# ---------------------------------------------------------------------------
# 4. Instructor grants go through apps/users/teaching.py (WS-F, plan §5.3)
# ---------------------------------------------------------------------------
# Modules that may name the instructor role or match course ownership freely:
# the predicate module itself, the user model/manager/seeds, the capability
# map, the switch registry, and the device policy (owner decision D8: not tied
# to the switch).
INSTRUCTOR_GRANT_MODULES = {
    "apps/users/teaching.py",
    "apps/users/models.py",
    "apps/users/managers.py",
    "apps/users/session_policy.py",
    "apps/users/capabilities.py",
    "apps/core/features.py",
}
INSTRUCTOR_GRANT_DIRS = ("apps/e2e_support/", "apps/users/management/")
# Existing matches that are not grants, or that are only reached through a
# gated path (file -> max allowed occurrences, with the reason). Never grow it:
# route new instructor checks through apps.users.teaching instead.
INSTRUCTOR_GRANT_ALLOWLIST = {
    # Course create stores the owner after IsInstructor/require_teaching; the
    # self-enrolment block is a refusal, not a grant.
    "apps/courses/views.py": 2,
    # Course serializer: an owner sees their course as "approved" and its live
    # links. Unpublished courses and lectures are gated in views/access.py.
    # TODO(owner of apps/courses/serializers.py): use teaching.owns_course.
    "apps/courses/serializers.py": 3,
    # UI overhaul Console API: the Teach workspace is gated first by
    # require_teacher -> features.require("teaching") (WS-C), and the palette
    # shows a role label (WS-G). TODO(WS-C): use teaching.taught_courses.
    "apps/console_api/today.py": 5,
    "apps/console_api/search.py": 1,
    # An instructor may not buy their own course (a refusal, not a grant).
    "apps/payments/plans.py": 1,
    "apps/payments/views.py": 1,
    # TODO(WS-F follow-up, owner of apps/ctf/gradebook.py): use
    # apps.users.teaching.taught_courses for the batch gradebook read scope.
    "apps/ctf/gradebook.py": 1,
    # Session list visibility (rows only; controls go through
    # RealtimeSession.is_moderator_allowed, which is gated).
    "apps/realtime/domain.py": 1,
    # Shared-cache bypass for privileged viewers (no grant).
    "apps/realtime/session_list.py": 1,
    # Pre-class probe visibility for managers (read-only diagnostics).
    "apps/realtime/views.py": 1,
    # Publishing a class recording into a module is reached through session
    # moderation, which is gated (RealtimeSession.is_moderator_allowed).
    "apps/realtime/recording/services.py": 1,
    # Display only (owner privacy rule): instructors keep their account name on
    # surfaces they author, students show their handle (no right is granted).
    "apps/profiles/handles.py": 1,
    "apps/realtime/recording/views.py": 1,
    # Upload candidates are filtered again by can_manage_session (gated).
    "apps/recording_uploads/services.py": 2,
}
_INSTRUCTOR_KEYWORDS = {"instructor", "instructor_id"}
_USER_NAMES = {"user", "owner", "request_user", "viewer", "actor"}


def _mentions_user(node) -> bool:
    """``user``, ``request.user``, ``user.id``/``user.pk``, ``self.request.user.pk``..."""
    while isinstance(node, ast.Attribute):
        if node.attr in _USER_NAMES:
            return True
        node = node.value
    return isinstance(node, ast.Name) and node.id in _USER_NAMES


def _is_instructor_literal(node) -> bool:
    if isinstance(node, ast.Constant) and node.value == "instructor":
        return True
    if isinstance(node, (ast.Name, ast.Attribute)):
        name = node.id if isinstance(node, ast.Name) else node.attr
        return name == "ROLE_INSTRUCTOR"
    if isinstance(node, (ast.Set, ast.Tuple, ast.List)):
        return any(_is_instructor_literal(item) for item in node.elts)
    return False


def _is_instructor_id(node) -> bool:
    return isinstance(node, ast.Attribute) and node.attr == "instructor_id"


def _instructor_grants(tree: ast.Module):
    """Yield (lineno, description) for instructor-role / course-ownership grants."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            operands = [node.left, *node.comparators]
            if any(_is_instructor_literal(item) for item in operands):
                yield node.lineno, "role compared with 'instructor'"
            elif any(isinstance(op, ast.Eq) for op in node.ops) and any(_is_instructor_id(item) for item in operands):
                if any(_mentions_user(item) for item in operands if not _is_instructor_id(item)):
                    yield node.lineno, "instructor_id == user"
        elif isinstance(node, ast.Call):
            for keyword in node.keywords:
                name = keyword.arg or ""
                leaf = name.rsplit("__", 1)[-1]
                if leaf in _INSTRUCTOR_KEYWORDS and _mentions_user(keyword.value):
                    yield node.lineno, f"{name}=<user>"


class InstructorGrantTests(SimpleTestCase):
    def _offenders(self):
        counts: dict[str, list[str]] = {}
        for path in _python_files(APPS_DIR):
            rel = _rel(path)
            if "migrations" in path.parts or "tests" in path.parts or path.name.startswith("test"):
                continue
            if rel in INSTRUCTOR_GRANT_MODULES or rel.startswith(INSTRUCTOR_GRANT_DIRS):
                continue
            for lineno, what in _instructor_grants(_parse(path)):
                counts.setdefault(rel, []).append(f"{rel}:{lineno} {what}")
        return counts

    def test_instructor_grants_go_through_the_teaching_switch(self):
        violations = []
        for rel, hits in sorted(self._offenders().items()):
            if len(hits) > INSTRUCTOR_GRANT_ALLOWLIST.get(rel, 0):
                violations.extend(hits)
        self.assertEqual(
            violations,
            [],
            "Instructor rights must be granted through apps.users.teaching (teaching_allowed, owns_course, "
            "taught_courses, require_teaching) so the Teachers section switch covers them:\n" + "\n".join(violations),
        )

    def test_instructor_allowlist_has_no_stale_entries(self):
        offenders = self._offenders()
        stale = [
            f"{rel}: allowlisted {allowed}, found {len(offenders.get(rel, []))} -- shrink the allowlist"
            for rel, allowed in INSTRUCTOR_GRANT_ALLOWLIST.items()
            if len(offenders.get(rel, [])) < allowed
        ]
        self.assertEqual(stale, [], "\n".join(stale))

    def test_detector_finds_the_patterns(self):
        tree = ast.parse(
            "user.role == 'instructor'\n"
            "request.user.role != 'instructor'\n"
            "getattr(user, 'role', '') in {'instructor', 'admin'}\n"
            "user.role == User.ROLE_INSTRUCTOR\n"
            "course.instructor_id == request.user.id\n"
            "Course.objects.filter(instructor_id=user.pk)\n"
            "Q(linked_course__instructor=user)\n"
            "course.instructor_id != request.user.id\n"
            "Course.objects.filter(instructor_id=course_id)\n"
        )
        self.assertEqual([line for line, _what in _instructor_grants(tree)], [1, 2, 3, 4, 5, 6, 7])
