# Secret Rotation Strategy

Secrets are stored in the production environment file or provider secret store,
never in Git. Rotation is manual and provider-aware because changing every value
at once can invalidate active sessions, payments, streaming, and monitoring.

## Rotation classes

| Secret class | Normal interval | Immediate rotation trigger |
| --- | --- | --- |
| SSH keys and privileged credentials | 90 days | device loss or unknown login |
| Django/JWT signing material | 180 days | suspected disclosure |
| Payment/API/webhook credentials | provider policy, at most 180 days | provider alert or disclosure |
| Owncast/LiveKit/stream credentials | 90 days | unauthorized stream/admin access |
| Database/Redis/Grafana credentials | 180 days | host or monitoring compromise |

## Procedure

1. Identify consumers, owner, rollback value, and whether dual-key overlap exists.
2. Create the replacement in the provider. Do not print it to terminal history.
3. Update the restricted production environment and dependent service together.
4. Restart only affected containers and verify their complete user journey.
5. Revoke the previous value after verification and overlap.
6. Record secret name, owner, rotation time, and result, never the value.

Rotate Django signing material only with a planned session invalidation strategy.
Rotate payment webhook secrets only after the provider endpoint and backend agree.
