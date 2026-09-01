# Capacity Management

Capacity acceptance uses authorized users and an active test broadcast. A load
test that receives only authorization failures is not a successful capacity test.

## Release acceptance

- Run the five-viewer smoke test for at least two minutes.
- Run the target concurrency test for the expected class duration plus 30 minutes.
- For the current requirement, test at least 100 authorized viewers for 90 minutes.
- Require checks above 99%, playback failures below 1%, manifest p95 below 3s,
  segment p95 below 5s, and no sustained resource saturation.
- Observe chat, join, HLS, Nginx, CPU, memory, disk/network, Redis, PostgreSQL,
  and container restarts during the run.

Use `infra/loadtest/realtime-playback.js` and the authenticated token-generation
procedure in `infra/loadtest/README.md`. Delete generated token files after each
test. Record date, commit, session, concurrency, duration, result, bottleneck,
and capacity headroom without storing tokens.
