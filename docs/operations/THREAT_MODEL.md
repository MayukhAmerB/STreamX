# StreamX Threat Model

## Scope and assets

The scope includes the React frontends, Django API, PostgreSQL, Redis, payment
webhooks, protected media, Owncast, LiveKit, Nginx, Docker, monitoring, backups,
and the Hostinger VPS. Critical assets are account credentials, session tokens,
payment state, course entitlements, personal data, stream keys, recordings,
database contents, signing keys, and backup archives.

## Trust boundaries

1. Internet clients cross Cloudflare and Nginx before reaching application APIs.
2. Public HTTP traffic crosses into the private Docker network.
3. Django crosses provider boundaries when calling Razorpay, Owncast, LiveKit,
   mail, object storage, or Turnstile.
4. Administrators cross a privileged boundary through Django admin and SSH.
5. Backup data crosses from live volumes into local and offsite storage.

## Principal threats and controls

| Threat | Primary controls | Detection | Residual action |
| --- | --- | --- | --- |
| Credential theft | key-only SSH, MFA where available, secure cookies, short token lifetime | login audit events, fail2ban | revoke sessions and rotate affected secrets |
| Privilege escalation | deny-by-default API permissions, admin role checks | authorization failures and admin audit events | disable account and review all privileged actions |
| Payment forgery/replay | provider signatures, amount/order/currency validation, row locking, idempotency | webhook and payment failure metrics | suspend provisioning and reconcile provider records |
| Unauthorized media access | entitlement checks and expiring signed playback | join failures and access audit events | revoke grants and rotate signing material |
| Stream abuse or disclosure | authenticated launch, protected HLS, fixed ingest controls | Owncast and realtime telemetry | stop broadcast and rotate stream/admin credentials |
| Injection/XSS | ORM parameters, serializers, React escaping, CSP and CSRF | suspicious-input telemetry | investigate signal; do not treat regex as the security boundary |
| SSRF | scheme/host/IP validation and internal-host denial | outbound request failures | isolate provider integration and validate resolved destination |
| Denial of service | Cloudflare, Nginx limits, application throttles, capacity tests | latency, error rate, CPU, memory, connection alerts | apply incident load-shedding plan |
| Data loss | verified daily backups and offsite copy | backup age and checksum alerts | invoke disaster recovery procedure |
| Malicious deployment | protected Git access, SHA verification, preflight and rollback | deployment log and health checks | rollback to previous release and rotate CI/SSH credentials |
| Secret disclosure | ignored environment files, redacted logging, restricted permissions | repository and log scanning | revoke and rotate immediately |

## Assumptions

- PostgreSQL and Redis are not publicly exposed.
- `stream` and `ingest` DNS records may bypass Cloudflare, so origin Nginx and
  application authorization remain mandatory.
- A single VPS is a known availability boundary. Backups must be copied offsite
  to survive total host loss.
- Regex request filtering is telemetry only; it is not a substitute for safe
  queries, output encoding, CSP, CSRF, or authorization.

Review this model after a new external integration, authentication flow,
privileged role, public port, payment path, or data category is introduced.
