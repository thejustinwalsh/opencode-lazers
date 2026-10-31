# Spike 015 — permission-based trajectory reads

## Task record

- **Task:** `b9d649d7-5d15-4406-824b-6681865072d4`, revision 1.
- **Question:** Does an Architect-name check add protection beyond the native
  permission and project-ownership boundaries for trajectory reads?
- **Increment:** Allow any natively authorized caller to inspect a project-owned
  task or attempt, including an implementation worker reading an earlier attempt.
- **Starting revision:** `4267db97bfbea7659b9897aaff8079c07b0a5376`.
- **Write scope:** `src/trajectory/tools.ts`, `test/trajectory/registered.test.ts`,
  `src/trajectory/read.test.ts`, `README.md`, and this spike.
- **Exclusions:** Worker selection, orchestration authority, ownership/privacy
  rules, legacy global-project compatibility, and telemetry capture.

## Result

The registered tool continues to ask OpenCode's native permission system before
validating input or accessing the project database or native sessions. The
redundant agent-name rejection is removed; native permission is the caller
boundary. An implementation worker can therefore inspect an owned prior attempt
when permitted. This does not broaden task, attempt, canonical-project, session,
cursor, or data-export ownership.

The README now describes permission-based reads. Spike 012's Architect-only
wording documents the original implementation and is superseded by this
correction for current behavior.

## Verification

The registered-tool tests cover successful reads by Architect, implementor, and
another authorized agent; the implementor's request targets a prior failed
attempt. A denied caller is tested with both invalid and valid input while the
database path is unavailable, proving denial precedes validation, database
reopen, and native session access. Read tests retain foreign task, attempt, and
session rejection and bind continuation cursors to their source snapshot.
Existing privacy, no-write, pagination, and disposal regressions remain in the
trajectory suites.

- `bun test src/trajectory test/trajectory` — 17 passed, 0 failed, 122 assertions.
- `bun test` — 169 passed, 0 failed, 1,502 assertions.
- `bun run verify` — formatting, lint, and strict typecheck passed.

## Native observation

A live native authorized read after an idle supported reload remains pending.
This implementation session has no exposed invocation path for the registered
trajectory tool or supported idle reload control. No worker or host restart was
used to force a reload, and no live-tool result is claimed. The Architect should
perform that observation in the existing Desktop session after its supported
idle reload becomes available.
