# LZ-175: retained repair candidate verification

Root implemented the existing LZ-175 contract in the native isolated worktree
`/private/tmp/lz175-binding-repair-20261107`, branch
`feat/lz175-binding-repair-20261107`. Candidate `312dabd` and review correction
`c135109` are not yet merged or activated.

The existing `verify-retained` command can bind the clean committed descendant
of an earlier recorded artifact to the current authorized repair, original task,
attempt, worker, route and repair input. It runs isolated checks against that new
commit without replacing the worker or inventing a successful original idle event.
The existing operation payload stores the repair binding. Historical check
receipts, usage, original execution uncertainty and independent resource/human
holds remain intact. No new tool, daemon, content fingerprint scan or database
mutation outside the product workflow is introduced.

## Verification

- Initial candidate: 62 declared tests / 670 assertions; broader runner suite
  586 tests / 7,723 assertions. Strict checks and GUI build passed.
- Independent native OpenAI Luna Max review found three gaps: native owner
  invalidation during admission awaits, native owner invalidation after check
  authorization, and a competing scope reservation appearing during admission.
  Full findings: [source review](lz175-312dabd-source-review-20261107.md).
- `c135109` refreshes the native owner after final worker observations, checks
  the native owner before task acceptance and repeats the existing scope-conflict
  scan atomically at reservation. Seven focused races fail against `312dabd`
  and pass against the correction. The acceptance fixtures suppress automatic
  command ticks so invalidation occurs after initial native authorization.
- Corrected declared suite: 69 passed / zero failed / 747 assertions / four files,
  32.91 seconds. Formatter, lint, typecheck, diff check, GUI build and bundle
  evaluation passed. Broader corrected runner suite and focused native rereview
  are in progress.

Read-only preflight of actual retained LZ-173 and LZ-174 records confirmed matching
repair message, session, workspace and completed repair-prompt effect. Actual
native use of this new candidate-binding path is still unproven. LZ-174's separate
content-scanning review defect remains rejected; qualifying a commit does not
approve its source or remove that required correction.

## Remaining

Finish rereview and broader checks, integrate, activate at a real quiet boundary,
then use native Architect controls on the preserved original work. Observe the
actual checks and subsequent correction in their original workers. Do not close
LZ-175 from this report or from unit tests alone.
