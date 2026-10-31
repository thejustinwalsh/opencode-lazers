# Scoped projection task addenda

Existing task: `efd8459f-1dbe-4472-968b-f26f59504291`, existing plan:
`b50a1a71-1a54-4d89-8ef2-0644bcccc327`. These clarifications apply to that
work, not a replacement task. Implementation and verification are pending.

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
`69290a81d60b31c3d89eac711b7bfe28ed40562b`, currently in the native design
worktree `/private/tmp/lazers-trajectory-design`, until integrated. It supersedes
objective-as-heading guidance: optional concise Architect-authored `PlanInput.title`,
short plan-reference fallback for legacy records, full objective only in Details.
Do not generate titles or rewrite historical plans.

Project complete topology, not the current filtered/paged rows: sequential order,
unambiguous fork/join boundaries, one row per task, selectable Waiting on / Blocks.
Graph independence is not evidence of actual scheduler concurrency. Radar uses
real machine topology/snapshots/transitions; Trajectory uses recorded history,
with unknown timing/accounting left unknown. Keep these sources distinct.
