# Delegated-agent scheduling verification

Date: 2026-11-19

## Earlier implementation evidence

- `bun run verify` passed after the capacity settings UI and authorization changes.
  Oxlint reported existing warnings outside the new settings component; typecheck
  completed with no errors.
- `bun test --max-concurrency 1 src/runner src/tasks test/runner test/delegation test/plugin-settings test/observation-panels/tasks-scheduling.test.ts`
  passed: 969 tests across 75 files.
- The runbook's focused capacity/RPC/Settings command passed after the final UI
  change: 8 tests across 3 files, 58 assertions.
- `bun run build:gui` passed after the final settings UI change.
- `bun run build:server` passed with the final server RPC and scheduler sources.
- `git diff --check` passed.

The registered RPC tests exercise positive-integer validation, revision conflicts,
permission denial, archived/missing/cross-project session rejection, and rechecking
session scope after permission authorization. The settings component test uses
deliberate fake session/client identities to exercise canonical-project display,
stale project and connection reads, invalid input, and stale write responses.
These are fixture observations, not live native host identities.

## Takeover correction evidence

The current takeover correction passed `bun run verify`, both GUI and server
builds, and `git diff --check`. Focused capacity, registered native-hook and
lifecycle suites passed 22 tests; public shared-resume checks passed at limits
1 and 3 (2 tests). These checks cover creation before execution, stale waiter
fencing across follow-ups, first-loop follow-ups preserving their start boundary,
plugin disposal, fresh Architect admission, scope-blocked refill, admitted work
surviving process loss, and ambiguous child-creation metadata.

Independent read-only re-review confirmed the first-loop follow-up regression.
The full declared behavior suite must still pass for the committed takeover
candidate through runtime verification; the earlier 969-test result above is
not current-candidate evidence.

## Live rollout probe

The OpenCode Desktop/native rollout steps in
[`docs/how-to/delegated-agent-capacity-rollout.md`](../../../../docs/how-to/delegated-agent-capacity-rollout.md)
were not run in this environment. No real native session/worktree identities,
helper starts, review/integration ordering, or cleanup receipts were observed.
The manual rollout remains outstanding; this note does not claim it passed.
