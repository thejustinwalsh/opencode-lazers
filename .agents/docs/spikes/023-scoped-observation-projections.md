# Scoped projection task addenda

Existing task: `efd8459f-1dbe-4472-968b-f26f59504291`, existing plan:
`b50a1a71-1a54-4d89-8ef2-0644bcccc327`. These clarifications apply to that
work, not a replacement task. Implementation and verification evidence follows.

## Linked worker association — native reproduction, 2026-10-31

The driver opened the real `2958fa32-9f7a-43d9-9252-3d30f2d4dca1` worker
through OpenCode's native subagent menu. Luna Max, its native isolated worktree
and live tools were visible. Its Session Tasks view incorrectly said “No tasks
submitted from this session”. The driver returned to the parent afterward.

`src/tasks/read.ts` currently filters query pages and detail reads solely by
`task.provenance.sessionID`. The scoped projection's existing requirement to use
real plan-owner/worker links includes this observed case: the registered Tasks
query and get paths must discover the assigned task from the worker session,
while unrelated and foreign-project sessions remain excluded. Do not rewrite
submission provenance or turn Session scope into Project scope. Exercise the
actual registered RPC, including reconnect/scope switches, not only a new helper.
The task already owns `src/index.ts` and `src/observability/**`, so the shared
association-aware read adapter can be connected at registration within its
existing write scope. Return for coordination if further boundary changes prove
necessary; do not silently broaden the immutable task record.

## Current design authority

Use the design lineage culminating in
`69290a81d60b31c3d89eac711b7bfe28ed40562b`, now merged on main. Read
`design/trajectory-panel/{design.json,recorded-task-data.json}` and
`design/task-panel/execution-list.json`; the clean merged native design worktree
was removed through the host without force. This authority supersedes
objective-as-heading guidance: optional concise Architect-authored `PlanInput.title`,
short plan-reference fallback for legacy records, full objective only in Details.
Do not generate titles or rewrite historical plans.

Project complete topology, not the current filtered/paged rows: sequential order,
unambiguous fork/join boundaries, one row per task, selectable Waiting on / Blocks.
Graph independence is not evidence of actual scheduler concurrency. Radar uses
real machine topology/snapshots/transitions; Trajectory uses recorded history,
with unknown timing/accounting left unknown. Keep these sources distinct.

## Implementation and verification — 2026-10-31

- Registered `lazers.observability` exposes project/session-scoped `snapshot` and
  `trajectory` reads. Session IDs are resolved with native `session.get`, checked
  for current-project/live status, and authorized against the resolved agent.
  Project-wide scope is a separate explicit selector. The trajectory action uses
  the existing `lazers_inspect_trajectory` permission.
- Radar reads use the read-only trajectory store. The response carries the actual
  XState definition/version and persisted snapshots separately from transitions
  ordered by database sequence; unsupported/mismatched snapshots are not silently
  rewritten. Scope expansion follows persisted task provenance, plan-owner,
  worker-attempt and same-project plan dependency links only.
- Registered Tasks query/get now use an association-aware adapter for plan-owner
  and worker-session discovery without changing task provenance or admitting
  foreign-project records. Radar omits raw policy/attempt internals; visible text
  is sanitized, while Trajectory retains only its existing safe attempt summary.
  Neither projection calls `RunnerStore.detail()` or writes audits.
- Runner/check source fingerprints detect changes outside the repository
  watermark; native usage/tool events invalidate separately. Duplicate/late
  durable events are ignored, sequence gaps/reconnects request a resnapshot, and
  the client sync state rejects stale scope/project generations. Trajectory output
  retains the existing privacy/coverage and unique-session usage calculations.
  Attempt end times remain unknown; check receipt endpoints and native model
  activity endpoints are labeled by source, with native idle not treated as task
  acceptance.

Verification completed:

- `bun test src/observability test/observability src/trajectory test/trajectory src/tasks/rpc.test.ts`
  — 27 passed.
- `bun test` — 224 passed.
- `bun run verify` — formatting, lint and typecheck passed.
- A read-only projection against the local task database included task
  `970b0feb-1fd3-40bb-a61d-f8decccb8a9f` in its actual owner-session plan and
  returned the persisted accepted state/snapshot consistently. A separate
  read-only comparison found the four persisted attempt IDs, states, scalar token
  totals, tool counts and start times match the retained measurement's runner
  records (267 tool calls total). The runtime does not load the design JSON.

Verification boundary: this test harness has no live native OpenCode session
context, so the registered RPC's native authorization and trajectory host reads
were exercised with test doubles, not a live `session.get`/`session.context` call.
Accordingly the retained measurement's native cumulative token fields have not
been independently re-read through the new registered RPC; the recorded design
data remains historical evidence, not claimed live output.
