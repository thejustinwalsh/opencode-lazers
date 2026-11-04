# Native verification shell fit — 2026-11-04

Read-only research by `ses_e585be433ffeOqk0137YCeXMiu`, using actual cached
OpenCode source pinned at `9bbb8ce18c80f099e0e448775f59d965ead40a21`.
No processes, tests, lifecycle actions or inference were launched by this research.

## Recommendation and retained uncertainty

Evaluate public `client.shell` as an execution backend within existing **V3 resource
lifecycle / restart reconciliation**, coordinated with **R5 quiescence / R6 authorized
recovery**, before extending custom child management. This research does not create
a new task/gate or authorize expanding LZ72's diagnostic-only boundary.

LZ72 (`7473e8a5-74cc-4222-aeea-a8a01de1f9be`), plan
`0dab6e0d-6ad1-4902-a315-4066f5dee32c`, original attempt
`ed96f0b9-102b-4c64-aa8b-708a62d49fe7`, retains uncertain `verify:runner` effect
`cd7cb493807b9dbcc552f552586351cbdb78d420baee04da31440ac86c36a8f8`.
Only `runtime-e6a58ea….json` was present in the inspected receipt directory;
no conclusive runner receipt or historical child-containment proof was recovered.
Its real scope reservation remains. API availability, missing inventory, a removal
acknowledgement or foreground idleness cannot settle this old direct Bun child.

The supplied CPU snapshot (service133.6%, renderer29.6%, GPU28.8%, no hot verification
child among top22) establishes neither orphan causality nor a matched benchmark.

## Public surfaces

- `client.shell.create/list/get/output/remove`: location-owned generic execution,
  generated ID, metadata, PID/command/cwd/shell/status/timestamps and merged file-backed
  output. No caller-selected ID or idempotent create. Metadata echoes correlation;
  it does not validate ownership or perform agent-tool command authorization.
  Location ownership and execution cwd are separate bindings.
- `client.session.shell`: session directory/execution plus durable shell-start/end
  events and projected message. Input only sessionID, optional message ID, command;
  no timeout/cwd/custom metadata controls and no returned shell receipt. Process
  starts before publishing the identified event: message ID is not spawn idempotency.
- `message.list/get` and experimental session log read retained evidence, not process
  controls or LAZERS CheckReceipts. Message listing needs pagination (default50,
  maximum200); session context is only post-compaction active context.
- Plugin `ctx.shell` exposes only the create-before hook, not lifecycle APIs.

## Retention and teardown limits

Generic `list` contains running commands only. Only25 exited entries remain per
location; eviction removes output. Output files have seven-day cleanup. Inventory
is in memory and cleared on location teardown; surviving files are not reindexed
after reload/restart. Output pages default64KiB; use cursor versus size, not
`truncated:false`, to detect remaining bytes. Read errors can yield zero bytes.
Internal result/wait/timeout-adjustment are not public HTTP shell operations.
Session messages additionally retain up to1MiB prefix capture, still not an
artifact/environment/containment-bound CheckReceipt.

Scoped handles, Unix process-group termination and escalation improve ownership,
but expose no descendant/port containment certificate. Remove deletes inventory
and output before cleanup; not-found is HTTP success. Parent exit can skip group
cleanup; escaped descendants and inherited-pipe deadlines matter. Initial timeout
defaults zero; request abortion is not cancellation acknowledgement. Session
interrupt settles active foreground execution asynchronously, not all historical
generic or background commands. Location reload is server-wide, not an inventory
refresh, and requires a coordinated quiet boundary.

## Current runner boundary

`src/runner/artifacts.ts:355–410` starts detached `/bin/sh` without persisting its
launch identity, retains32KiB per output stream in memory and writes the atomic
receipt only after exit, drain and artifact revalidation. Runtime journals intent
before launch (`runtime.ts:3302–3317`); reconciliation recovers a published receipt
but never repeats an uncertain missing one (`4790–4808`). Cancellation does not
connect a check handle to these children; stop waits for the tick. CheckReceipt
has no effect ID or containment acknowledgement. Native execution changes shell,
environment and merged-stream semantics, so compatibility cannot be assumed.

Any eventual adapter must retain durable RunnerStore intent/receipts, bind native
identity positively while records survive and preserve lost-response uncertainty.
Native inventory supplements rather than replaces durable recovery. Existing
maintenance recovery still needs separately authorized exclusive maintenance,
positive old-check/descendant containment, exact revalidation and a distinct fresh
runtime check. LZ57/58/99/117 are not shortcuts around that boundary.

## Pinned sources

All paths below are relative to [the pinned source tree](https://github.com/anomalyco/opencode/tree/9bbb8ce18c80f099e0e448775f59d965ead40a21):

- `packages/schema/src/shell.ts:36–85`, `packages/protocol/src/groups/shell.ts`
- `packages/protocol/src/groups/session.ts:418–436`, `packages/plugin/src/effect/shell.ts`
- `packages/core/src/shell.ts:30–85,167–185,208–331,408–448`
- `packages/server/src/handlers/shell.ts:19–27,63–69`
- `packages/core/src/tool/plugin/shell.ts:114–149`
- `packages/core/src/session/session.ts:192–235`, `session/shell.ts`
- `packages/schema/src/session-event.ts:310–331`, `session/message-updater.ts:189–215`
- `packages/server/src/handlers/message.ts:12–60`
- `packages/util/src/cross-spawn-spawner.ts:373–610`
- `packages/core/src/session/execution.ts:17–39`, `location-service-map.ts:20–35`
