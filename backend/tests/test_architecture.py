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
