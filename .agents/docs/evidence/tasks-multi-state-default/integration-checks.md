# LZ-216 current-main composition

The Architect composed worker artifact `7372bb87807237e4f2a421de6d5c5a2ed5a10af0`
with main `09797230`. The worker's original session and workspace were not changed.
Deleted accumulated-page/RPC consumers and their obsolete tests remain deleted.
The retained selection/persistence/label behavior is connected to the current
projection-backed schedule source, view-sized stream windows and agent query.
Accepted and Integrated remain independently selectable; explicit Completed
selects their union, while legacy Completed preferences retain main's fallback.

## Observed checks

- The original artifact's four loop-isolation files were independently rechecked,
  each in its own process group with a Python subprocess wall-clock watchdog of
  90 seconds: state-selection 3 tests / 0.03 s; read 11 / 0.44 s; storage 19 /
  0.40 s; association task reads 4 / 0.21 s. All exited 0, none were killed.
  The old SQL union lacked grouping against keyset boundaries; the retained
  artifact groups that union and guards test pagination against repeated cursors.
  Current main instead filters the stored projection with one bucket IN clause.
- `bun run verify` passed on the composition (existing repository lint warnings).
- `bun test --timeout 120000 src/tasks src/storage.test.ts test/task-panel
  test/observation-panels/tasks-streams.test.ts`: 230 passed across 39 files under
  an independent 240-second process-group watchdog.
- Following review fixes and test refinements, `bun test --timeout 120000
  test/observation-panels/tasks-streams.test.ts src/tasks/stream-query.test.ts
  src/tasks/state-selection.test.ts`: 20 passed, 128 assertions.
- `bun run build:gui` and `git diff --check` passed.

The real database/stream fixture covers bucket-union counts and rows, normalized
set cursors, immediate stored choices, project defaults in another session,
explicit All across reopen, bounded schedule windows, repeated All without a new
schedule subscription, and clearing an old filter's anchor. This is component
and integration evidence, not native Desktop qualification.

## Still outstanding

Candidate-bound Desktop narrow/wide interaction, application reload, screenshots
and action receipts must be collected after the driver-controlled quiet-point
activation. No separate verification Desktop was launched. The original runtime
Fallow receipt reports missing configuration, not a clean analyzer result.
