# Retained verification command composition

Actual LZ-173 retained verification admitted corrected commit `0b28972` on its
original attempt through the new LZ-175 path. Operation
`8618a6eb-5812-4063-8a8a-9a11d73117cf` then held before checks because the procedure
parser rejected this authored command:

```sh
bun run build:gui && bun test src/trajectory/read.test.ts src/trajectory/tools.test.ts test/trajectory-panel
```

The parser accepted those steps separately but could not compose them. Root
implemented candidate `e1a6f8d` in native worktree
`/private/tmp/lz-procedure-composition-20261107`, branch
`feat/retained-procedure-composition-20261107`, parent `bc855a2`. It was integrated
with test-only follow-up `831d468` through `4560a55`. Native task LZ-176
(`5d0061c7-37c8-4a42-a560-8dca2e0089cc`),
plan `d51c29bc-f239-426e-b453-ea46d65eb086`, is linked as a correction to LZ-138
and remains undispatched. Native Luna Max review found no material implementation
defect. Root added its small non-blocking test gaps; no competing implementor was
dispatched.

## Change

Twenty implementation lines compose the existing step recognizers and collect
all declared targets and scripts. The whole authored command remains unchanged,
including order and shell short-circuiting. Existing target containment, exact
candidate script declarations, private resources and receipt validation apply.
No general shell parser or new protocol is introduced.

## Checks

- Four composition regressions failed before the fix; standalone build remained
  passing. The registered repair-verification regression also failed before.
- Parser/isolation checks: 19 passed, zero failed. Actual subprocesses establish
  build-before-test order and failure short-circuiting, preserving the original
  profile and exercising existing witness validation/cleanup.
- Registered command flow passes the authored chain through task acceptance,
  normal reconciliation and combined checks, with exact-command receipts on the
  repair commit, one original worker and no replacement prompts.
- Full declared scope: 85 passed / zero failed / 864 assertions / five files,
  42.86 seconds. Final formatting, lint, typecheck, diff check, GUI build and
  bundle evaluation passed.
- Test-only review follow-up explicitly rejects `$()` and backticks, checks
  receipt command and whole-command binding, and preserves unknown background
  after combined checks. Final suite: 87 passed / zero failed / 871 assertions /
  five files, 37.37 seconds. Final strict/build checks pass. Canonical source/tests
  match that tested branch, and canonical strict checks pass.

## Native follow-through

Root's supported external server reload completed at Unix milliseconds
1794073262358–1794073266636, service PID3219 unchanged, global foreground idle,
target forms/permissions zero. [Lifecycle receipt](lz176-native-runtime-reload-20261107.json).
The clean merged review checkout was removed through native `force:false`, with
existence confirmed false.

Architect retired only held173 generation1 using the existing native control,
then submitted a new request identity. New operation
`e5c0d438-21c0-4b21-9039-ec9d246264f6`, generation2, is running the unchanged
authored checks on original173's corrected `0b28972`. Readback confirms pricing
exit0 and cleanup complete; the trajectory build/test check is running. Original
generation1 remains cancelled with its reason/history intact. Completion is still
unproven until checks, acceptance and cleanup are inspected. Source173's connected
LZ-137/UI observation and original174's rejected scan remain separate.
