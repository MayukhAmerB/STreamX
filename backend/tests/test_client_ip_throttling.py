from django.core.cache import cache
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from django.urls import URLPattern, URLResolver, get_resolver, reverse
from rest_framework.throttling import AnonRateThrottle

from config.client_ip import resolve_client_ip
from config.throttling import (
    ClientIpAnonRateThrottle,
    ClientIpIdentMixin,
    ClientIpScopedRateThrottle,
    ClientIpUserRateThrottle,
    LoginRateThrottle,
    RefreshIpCeilingThrottle,
)

CLIENT = "81.2.69.160"
GATEWAY = "172.18.0.5"
BRIDGE_PEER = "172.18.0.1"


def gateway_request(spoofed="", client=CLIENT):
    """Cloudflare -> host nginx -> gateway -> Django, as seen by Django."""
    chain = [item for item in (spoofed, client, client, BRIDGE_PEER) if item]
    return RequestFactory().get("/", REMOTE_ADDR=GATEWAY, HTTP_X_FORWARDED_FOR=", ".join(chain))


def backup_request(spoofed="", client=CLIENT):
    """Host nginx -> Django directly (backup upstream), Cloudflare bypassed."""
    chain = [item for item in (spoofed, client) if item]
    return RequestFactory().get("/", REMOTE_ADDR=BRIDGE_PEER, HTTP_X_FORWARDED_FOR=", ".join(chain))


@override_settings(TRUST_X_FORWARDED_FOR=True, TRUSTED_PROXY_COUNT=1)
class ResolveClientIpChainTests(SimpleTestCase):
    def test_gateway_path_resolves_the_address_host_nginx_appended(self):
        self.assertEqual(resolve_client_ip(gateway_request()), CLIENT)

    def test_backup_path_is_one_hop_shorter(self):
        self.assertEqual(resolve_client_ip(backup_request()), CLIENT)

    def test_spoofed_leading_values_never_change_the_client(self):
        for spoofed in ("8.8.8.8", "1.1.1.1, 9.9.9.9", "10.0.0.1", "garbage", f"{CLIENT}, 4.4.4.4"):
            with self.subTest(spoofed=spoofed):
                self.assertEqual(resolve_client_ip(gateway_request(spoofed)), CLIENT)
                self.assertEqual(resolve_client_ip(backup_request(spoofed)), CLIENT)

    def test_private_client_through_the_gateway_is_kept(self):
        self.assertEqual(resolve_client_ip(gateway_request("8.8.8.8", client="10.8.0.5")), "10.8.0.5")

    def test_cloudflare_pseudo_ipv4_client_is_never_stripped_as_a_proxy_hop(self):
        # Cloudflare Pseudo IPv4 maps IPv6 visitors into 240.0.0.0/4 (reserved,
        # "private" to Python). On the backup path stripping it would hand the
        # throttle identity to the client-controlled value on its left.
        pseudo_client = "240.16.0.7"
        for spoofed in ("8.8.8.8", "1.1.1.1, 9.9.9.9"):
            with self.subTest(spoofed=spoofed):
                self.assertEqual(resolve_client_ip(backup_request(spoofed, client=pseudo_client)), pseudo_client)
                self.assertEqual(resolve_client_ip(gateway_request(spoofed, client=pseudo_client)), pseudo_client)

    @override_settings(DEBUG=False, METRICS_AUTH_TOKEN="")
    def test_tokenless_metrics_stay_internal_only(self):
        from config.metrics import get_metrics_authorization

        self.assertFalse(get_metrics_authorization(backup_request(client="240.16.0.7"))[0])
        self.assertFalse(get_metrics_authorization(backup_request(client=CLIENT))[0])
        internal = RequestFactory().get("/", REMOTE_ADDR=BRIDGE_PEER)
        self.assertTrue(get_metrics_authorization(internal)[0])

    def test_untrusted_forwarded_for_falls_back_to_remote_addr(self):
        with self.settings(TRUST_X_FORWARDED_FOR=False):
            self.assertEqual(resolve_client_ip(gateway_request("8.8.8.8")), GATEWAY)


@override_settings(TRUST_X_FORWARDED_FOR=True, TRUSTED_PROXY_COUNT=1)
class ThrottleIdentityTests(SimpleTestCase):
    throttles = (
        ClientIpAnonRateThrottle,
        ClientIpUserRateThrottle,
        ClientIpScopedRateThrottle,
        LoginRateThrottle,
        RefreshIpCeilingThrottle,
    )

    def test_drf_default_identity_is_spoofable(self):
        # Documents why the project throttles exist: DRF keys on the raw header.
        throttle = AnonRateThrottle()
        self.assertNotEqual(
            throttle.get_ident(gateway_request("8.8.8.8")),
            throttle.get_ident(gateway_request("9.9.9.9")),
        )

    def test_spoofed_forwarded_for_cannot_change_any_throttle_identity(self):
        for throttle_class in self.throttles:
            throttle = throttle_class.__new__(throttle_class)
            with self.subTest(throttle=throttle_class.__name__):
                identities = {
                    throttle.get_ident(build(spoofed))
                    for build in (gateway_request, backup_request)
                    for spoofed in ("", "8.8.8.8", "9.9.9.9, 1.2.3.4", "garbage")
                }
                self.assertEqual(identities, {CLIENT})

    def test_every_routed_view_uses_client_ip_throttles(self):
        def views(patterns):
            for pattern in patterns:
                if isinstance(pattern, URLResolver):
                    yield from views(pattern.url_patterns)
                elif isinstance(pattern, URLPattern):
                    view_class = getattr(pattern.callback, "cls", None)
                    if view_class is not None:
                        yield pattern, view_class

        checked = 0
        for pattern, view_class in views(get_resolver().url_patterns):
            for throttle_class in getattr(view_class, "throttle_classes", ()):
                checked += 1
                self.assertTrue(
                    issubclass(throttle_class, ClientIpIdentMixin),
                    f"{view_class.__name__} ({pattern.pattern}) uses {throttle_class.__name__}",
                )
        self.assertGreater(checked, 0)


@override_settings(TRUST_X_FORWARDED_FOR=True, TRUSTED_PROXY_COUNT=1)
class SpoofedForwardedForRateLimitTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_rotating_forwarded_for_does_not_bypass_a_scoped_limit(self):
        url = reverse("auth-password-reset")
        statuses = []
        for index in range(6):
            statuses.append(
                self.client.post(
                    url,
                    {"email": "nobody@example.com"},
                    content_type="application/json",
                    REMOTE_ADDR=GATEWAY,
                    HTTP_X_FORWARDED_FOR=f"8.8.{index}.{index}, {CLIENT}, {CLIENT}, {BRIDGE_PEER}",
                ).status_code
            )

        self.assertNotIn(429, statuses[:5])
        self.assertEqual(statuses[5], 429)
