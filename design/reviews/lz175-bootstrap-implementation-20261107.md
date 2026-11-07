# LZ-175: retained repair candidate verification

Root implemented the existing LZ-175 contract in the native isolated worktree
`/private/tmp/lz175-binding-repair-20261107`, branch
`feat/lz175-binding-repair-20261107`. Candidate `312dabd` and review corrections
`c135109` and `7727cc4` were integrated in `cbf20ee` after focused native Luna Max
rereview reported no material findings. Runtime activation is still pending.
The clean, merged review worktree was subsequently removed through OpenCode's
native `worktree.remove` with `force:false`; existence was confirmed false.

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
  evaluation passed. Broader corrected checks passed 593 tests / zero failures /
  7,800 assertions across 29 files: `bun test src/runner --max-concurrency=1`
  (585 / 7,721; 184.26 seconds) plus the two `test/runner` recovery/outcome journey
  files (8 / 79; 6.24 seconds). These broader runs apply to `c135109`.
- Focused rereview confirmed the three corrections and found a worker-state
  change during the trailing owner lookup. `7727cc4` brackets that lookup with
  the existing two worker observations at admission and acceptance, rather than
  adding another observation loop. Six input/activity/route regressions fail on
  `c135109` and pass on `7727cc4`; all thirteen review races pass. The final
  declared suite passes 75 tests / zero failures / 813 assertions / four files,
  39.09 seconds. Strict checks and GUI build/evaluation pass. Focused native
  rereview of this final ordering resolved all four findings with no material
  issues. [Final source review](lz175-7727cc4-focused-rereview-20261107.md).
- Integrated canonical retained-verification plus GPU checks: 118 passed / zero
  failed / 1,062 assertions / twelve files, 64.08 seconds. Canonical formatter,
  lint, typecheck, diff check, GUI build and bundle evaluation also passed.

Read-only preflight of actual retained LZ-173 and LZ-174 records confirmed matching
repair message, session, workspace and completed repair-prompt effect. Actual
native use of this new candidate-binding path is still unproven. LZ-174's separate
content-scanning review defect remains rejected; qualifying a commit does not
approve its source or remove that required correction.

## Remaining

Finish integrated checks, activate at a real quiet boundary, then use native
Architect controls on the preserved original work. Observe the
actual checks and subsequent correction in their original workers. Do not close
LZ-175 from this report or from unit tests alone.
