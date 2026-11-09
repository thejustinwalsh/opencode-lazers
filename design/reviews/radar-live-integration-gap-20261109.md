# Radar live delivery gap — 2026-11-09

## Actual product observation

Root reports that main Desktop Project Radar renders `[object Object]` and no
operational data; Refresh reproduces while the original LZ-181 and LZ-193 workers
are natively active. Main service logs at `2026-11-09T00:42:50Z` and
`2026-11-09T00:44:06Z` identify `lazers.observability` legacy `radar`/`snapshot`
failures: **Observation scope is too large; narrow it**.

This matches LZ-184's existing delivered-feature boundary. It is not a new feature
request, absent-worker evidence, or a reason to increase observation caps.

## Source and recorded checks

- Main inspected at `ba6b5f4fe413e059ae3349ea082829e45252ddae` still uses the legacy
  primary Radar consumer.
- Accepted LZ-184 artifact `89edd14b0cadad49b8b3cb84d733ce56ff82f549` is not main
  ancestry. Its recorded quality/GUI build and monitor checks passed: **158 tests,
  1,228 assertions**. Historical PATH-related exit-127 checks remain historical
  failures; they are not substituted for those later successful checks.
- The existing plan remains blocked on `connected-radar-agent-monitor` evidence.
  Task-node acceptance is not source landing or connected product qualification.
- The preserved combined Tasks/Radar review checkout at `66927d5` is older than the
  final accepted artifact; later changes must not be assumed composed into it.

## Fresh read-only producer observations

Authenticated calls through the existing service's `liveRadar` RPC used the
current Architect session and explicit Session/Project scope, without starting,
interrupting or replacing workers, changing settings, or reading native contexts.

| Scope   | Elapsed in this observation | Returned records                                    |
| ------- | --------------------------- | --------------------------------------------------- |
| Session | 54 ms                       | 1 session, 1 route, 0 calls, 0 flow                 |
| Project | 101 ms                      | 13 managed sessions, 52 routes, 144 calls, 256 flow |

Project inventory, progress, payload, flow and journal coverage reported bounded
or truncated data; these returned counts are **not complete project totals**.
Runner data was current and native events connected. Both scopes reported zero
native-context loads. The compact receipt is retained at
`.cache/driver/lz184-live-read-20261109.json`.

A subsequent Project read positively identified both original active workers:

- LZ-181: session `ses_12ba163aca2a4703a19aa82430adb1ab`, attempt
  `4d691f62-10c6-456f-b862-72cf665c4bb6`; busy, available, exact running assignment.
- LZ-193: session `ses_dd92813879ab4e0da0f5d1c8b5a197d4`, attempt
  `c49fbc65-db5c-44ca-bd42-e142dca7fb09`; busy, available, exact running assignment.

## Acceptance boundary

These observations establish an actual legacy-consumer integration gap and a
working bounded live producer with genuine managed-worker associations. They do
**not** establish rendered monitor behavior, supported file-target observation,
event-subscription recovery, narrow/wide/short layout, scrolling/divider/keyboard
behavior, or screenshot acceptance. Continue LZ-184's existing focused source
review, composition, safe activation and connected qualification. Keep the
user-owned paused OAuth instance untouched, preserve both active workers and all
existing evidence, and leave Desktop crash diagnosis with Driver.
