# LZ-173 integration repairs

Architect merged accepted original worker commits `ddefc44` and `0b28972` with
canonical `4560a55` in native integration checkout
`/Users/tjw/.local/share/opencode/worktree/b5da4c/lz173-canonical-integration-20261107`.
The merge `19d62a6` was clean. Strict checks and GUI build passed, but broader
Models/Trajectory checks reported 262 passed / 24 failed across 31 files.

Two concrete failures accounted for that result:

- The ledger fixture recreated an outdated sixteen-column attempt table, then
  copied seventeen-column current rows into it. It now reuses the actual current
  CREATE TABLE definition and removes only the fixture's session uniqueness.
  This changes temporary test databases, not production schema or data.
- Root's earlier process-scoped lease fix evaluated `node:process.pid` during
  module loading. The real browser-targeted trajectory bundle externalizes that
  module and threw before mounting. The same identity computation now lives in
  main-only setup, preserving PID/time-origin ownership semantics and avoiding
  renderer evaluation. No cache/model/settings change was needed.

Root committed these two repairs in `1981d7a`, preserving the original worker
commits and integration merge. All file reservations were released to Architect.

## Actual verification

The same broader Models/Trajectory command plus all eight WebGPU test files
passed: **329 passed / zero failed / 3,290 assertions / 39 files, 27.66 seconds**.
This includes the formerly failing ledger and browser-targeted render cases and
the registered cache/reload lifecycle tests. Formatter, lint, typecheck, diff
check, GUI build and bundle evaluation also passed.

Logs: `/private/tmp/lz173-integration-repair-tests-20261107.log` and
`/private/tmp/lz173-integration-repair-build-20261107.log`. Architect owns landing,
task-level integration recording and normal native worktree cleanup. Root's actual
connected LZ-137/UI observation remains required before the combined human gate.

The existing build smoke alone did not catch the eager Node property read; the
real browser-targeted render test did. Keep that distinction when selecting
verification for shared GUI/main modules.
