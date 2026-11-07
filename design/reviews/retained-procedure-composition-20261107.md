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
`feat/retained-procedure-composition-20261107`, parent `bc855a2`. It is not yet
merged or activated. Native task LZ-176 (`5d0061c7-37c8-4a42-a560-8dca2e0089cc`),
plan `d51c29bc-f239-426e-b453-ea46d65eb086`, is linked as a correction to LZ-138
and remains undispatched. Native Luna Max source review is running; no competing
implementor is dispatched.

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

## Native follow-through

Await focused source review, integrate and load at a real quiet boundary. Use
existing controls to retire only the obsolete held173 verification generation,
then request a new generation with a new command identity. Replaying its old
successful admission request must still return its original operation. Preserve
the failed/held history and original resources. Run the unchanged authored checks
and inspect actual acceptance/cleanup before recording fulfillment. Source173's
connected LZ-137/UI observation and original174's rejected scan remain separate.
