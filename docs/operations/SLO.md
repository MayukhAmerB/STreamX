# Service Level Objectives

## User journeys

| Journey | SLI | Objective | Window |
| --- | --- | --- | --- |
| API availability | non-5xx responses / all API responses | 99.9% | rolling 30 days |
| API responsiveness | requests completed in 1 second / all requests | 99% | rolling 30 days |
| Realtime admission | successful joins / all join attempts | 99% | rolling 30 days |
| Backup freshness | latest verified backup age | less than 36 hours | continuous |

Client errors are excluded from the API availability failure count because a
valid 4xx response means the service handled the request. Payment correctness,
authorization, and data durability are invariants and cannot be traded against
an error budget.

## Error-budget response

- `warning`: investigate during the same operating day and stop risky releases.
- `critical`: declare an incident, freeze deployments, and assign an incident
  commander until the burn rate or outage is controlled.
- Fast burn uses short windows to catch outages. Slow burn catches degradation
  that would consume the monthly budget without a sharp spike.

SLO recording rules are in `infra/observability/prometheus/slo-rules.yml`. The
operations dashboard is provisioned from
`infra/observability/grafana/dashboards/streamx-enterprise-operations.json`.
