# Scope recovery and partial source integration

2026-10-31. Production repairs preserve immutable task revision 1, stopped
candidates, native worker identity, and attempt/evidence history.

## Landed repairs

- `eb4c723`: additive owner/version/idempotency-checked `amend-scope`; effective
  scope governs scheduling conflicts, artifact verification and readable instructions.
- `a1c22e3`: typed scope violations retain the stopped verifying attempt in a stable
  Architect wait. Amendment plus explicit reconciliation verifies that candidate;
  scope-only failures do not consume automatic implementation repair.
- `c6cb1b7`: `integrated` with `taskID` records an accepted artifact's reviewed
  source landing, after checking branch and ancestry. It does not finalize the
  combined plan, change task state, clean worktrees or touch active dependencies.
- `2332abb` (Root): isolated scope checks exclude newer common reviewed main
  ancestry. Shared-checkout scope remains strict; absent valid newer common ancestry
  retains the original baseline. No authorization of inherited main files.
- `b0fb333`: authorization and exact owned-attempt instruction intent commit
  atomically. Fenced reconciliation uses native `instructions.entry.list/put`
  with a stable keyed cumulative additive authorization and exact readback.
  Project/session/agent/attempt/workspace/archive guards precede native updates.
  Lost replies recover the durable entry; no prompt, move, interrupt or new worker.
  A native-entry receipt is not proof of model consumption or acceptance.

## Actual native recovery

All-location activation at `1793487926044` covered ten locations. Service PID
remained `16786`; the grouping and assembly Luna Max workers retained their
directories, attempt IDs, models and busy/idle timestamps. The read-only reviewer
also remained unchanged. See `scope-instruction-activation.json` and the earlier
three-worker activation trace `scope-initial-activation.json`.

Normal command `wake-reviewed-test-scope-amendment-v1`, wake plan
`1d4a866e-1ffd-4255-a68c-d72f8f1a6a25` v9 → v10, authorized only
`src/runner/store.test.ts` and `test/runner/crash-fixture.ts`, legitimate dependencies
from preserved first artifact `c44d345`. The original specification remains unchanged.
It did **not** authorize 107 inherited main files or rewrite either attempt.

Effect `07be7bc7b9d82c6b8b4ba3d6ef889f7fccd958e3feb3f5ca06e77ea0306c3d32`
was durably intended and completed for retained attempt
`7513f29c-f4fd-44dd-88dc-9e9946c9f994`. Native readback at `1793487976331`
confirmed the cumulative authorization in the original session
`ses_2baf8e6b157b4ae781054408707ab8d7`, exact owned directory and Luna Max route.
Busy/idle remained `1793485149838` / `1793487446208`: no model restart.
`wake-reconcile-retained-candidate-after-scope-delivery-v1` then requested normal
same-attempt verification at v10 → v11. That request is not a claim that checks
passed or that the candidate was accepted or merged.

The retained candidate subsequently passed `focused`, `all` and `quality` and
stopped at the real `native-observation:human` boundary (v12), with both original
attempt IDs retained. No replacement worker was created.

## Reviewed wake and assembly source

`a6c5877` merges `1356ce3` while retaining `a07377c`, `a771bc3`, all scope fixes,
and Root's ancestry-aware verification call. Read-only review identified three
defects corrected during the merge:

- Native inbox IDs are global (pinned 2.2.5 `session/inbox.ts:176–187`). Owner
  replacement now durably records a new delivery ID before admission while
  retaining the old ID, ownership and uncertain receipt history. Reopen reuses
  the replacement ID, rather than violating native lifecycle identity.
- Host admission alone is not consumption. An admitted current notice also
  follows a replaced owner unless exact owned transcript consumption is proved.
- Current notices include recorded plan state/reason and the full accepted-task
  artifact/attempt/check-reference set. A newer partial result can replace an
  older result only when it covers that artifact; legacy distinct partial results
  remain independently deliverable rather than silently disappearing.

The merge restores the legitimate legacy-schema close/reopen test and positive
owned synthetic crash reconciliation from the first candidate. The unowned legacy
case remains separately unknown. The expanded focused suite passed 102 tests /
1,554 assertions; lint and strict types passed after removing one unused initializer.

`0c5de84` merges accepted assembly `ce270c5` without duplicating Root's existing
GUI registrations. Its new Vite registration test uses `middlewareMode: true,
ws: false` before any execution, so the one-shot test has no listener. Panel order
is not mistaken for exactly-once registration. Assembly/store checks passed
5 tests / 40 assertions and quality passed. Root's narrow-axis/theme work was
left untouched and landed separately as `ad01f67`.

Historical non-latest `unknown` delivery rows are no longer scanned; the latest
unknown and older admitted rows remain visible/recoverable. The store regression
checks both scan selection and preserved durable history.

All-location activation at `1793488805619` covered all eight then-loaded native
locations, with unchanged PID `16786` and unchanged active grouping Luna Max
attempt/timestamps. See `wake-activation.json`. The real b50 accepted wake
`msg_fa4727e7b7344416a4f4eef24a1b4384` remained queued before/after reload, ready
for observation against its genuine integration outcome. Reload alone is not
suppression evidence; native acceptance remains unclaimed here.

Assembly and grouping received native keyed preservation entries, with exact
readback and unchanged model/directory/busy/idle values, recorded in
`scope-worker-preservation-updates.json`. Durable entry delivery is not proof
of model consumption.

## Real product outcome observation

Normal `b50-reviewed-native-assembly-integrated-ce270c5-v1` requested integration
at v25 → v26. Runtime completed non-forced native cleanup of the five owned idle
merged worktrees and reached `integrated` v27 with artifact `ce270c5`. Grouping's
unrelated active Luna Max attempt was not removed or interrupted.

The before-state `real-b50-before.json` and activation trace both show the real
accepted notice `msg_fa4727e7b7344416a4f4eef24a1b4384` queued with exact ownership.
After genuine product integration, native observation at `1793489004528` shows
that ID absent and integrated notice `msg_af4d7f6a5e4f4c12b9e760749e1a7a08`
queued for the same Architect. PID and the Architect/grouping busy/idle timestamps
are unchanged. The three unrelated unowned legacy queue entries remain, as does
the unrelated subagent steer entry. See `real-b50-after.json`.

Absence alone is not cancellation proof: the registered runtime inspection records
transition `1405`, `OUTCOME_SUPERSEDED`, with receipt
`native-cancellation-confirmed`, exact original inbox ID and replacing outbox
`ae18dd6aea88b580c994ab98274d57572894e3dca0dad01378cff18e14025d7d`.
The original row retains its admission history and becomes `superseded`; the
replacement is `admitted`, resume `0`, consumption still unknown. Structured
runtime evidence is retained in `real-b50-runtime-proof.json`, with check logs
reduced to exit status rather than copied wholesale. This is actual native product
work, not a toy task or fixture-based suppression claim.

Read-only follow-up review of the landed owner-transfer and cumulative partial
repairs found no remaining concrete release blocker; it performed no native actions
or tests. Wake's existing same-attempt human gate remains distinct from this
source landing and native observation; no forced acceptance was requested.

Root subsequently explicitly approved this observation in `root-native-review.md`
and the conversation. The task `native-observation` and combined `native`
assertions were recorded through normal artifact-bound `human-evidence` commands,
explicitly naming the merged repair lineage rather than pristine `1356ce3`.
Runtime accepted the original retained attempt; reconciliation retained passing
task and combined focused/all/quality checks. Root independently reports fresh
merged main at 339 passing tests / 3,214 assertions / 70 files, plus formatting,
lint and strict types.

## Existing progress reservation recovery

Once the accepted wake attempt released its runner-scope reservation, progress
task `01d89f85-5eeb-4797-a0a8-18b2521e1cfa` was admitted automatically as original
attempt `d543a0f7-670a-46eb-8a91-0ca590a0f848`. Native worktree creation returned
an empty error before any worker session/prompt existed. Public native registry
refresh/list, filesystem absence and Git worktree listing conclusively showed no
created worktree. A public native create recovered that exact durable reservation
at the intended directory and recorded `9ab588f` baseline; runtime reconciled the
same worktree effect. It cancelled only the still-unsent reservation while the
plan remained blocked, preserving the attempt and directory.

Before any worker dispatch, the clean checkout was fast-forwarded to reviewed
canonical `5c407e8`, preserving original source provenance while inheriting all
reviewed runtime/product fixes. Normal `resume` at progress v8 → v10 reuses the
same attempt, worktree and reserved session ID, with unchanged Luna Max routing;
it is not a retry, replacement task, or duplicate implementation. The native
creation error's underlying cause remains unestablished. Lifecycle retains its
real progress-integration prerequisite; no schedule barrier was removed.

## Radar source landing

Task `c1cc0d39-42d7-4845-bcce-8d91aee4935b` (`LZ-21`) accepted artifact
`498b0dd` was already merged as `710814a`. Native wiring and subsequent Root/Terra
repairs are retained. Its native project-ID/canonical-directory regression is
covered in `test/radar/panel.test.ts`; current Radar/observation focused checks
passed 24 tests / 175 assertions and quality checks passed.

`radar-task-source-landed-498b0dd-v1` recorded this source landing through the normal
runtime command at b50 v21 → v22, observed HEAD `ff4a717`. Assembly remained running;
no combined acceptance, plan cleanup or worker interruption was requested.
Mounted observations and their explicit remaining coverage are recorded separately
in `../027-observation-panels/native-root-review.md`.

## Checks

The final scope-delivery focused suite (`native`, `runtime`, process recovery)
passed 81 tests / 1,345 assertions, plus formatting, lint and strict types.
Coverage includes already-fetched old instructions, failed and lost native replies,
fresh-connection reopen, real process death before/after keyed delivery, command
replay, native ownership rejection, exact readback, cancellation suppression and
same-attempt recovery without another worker or repair. Full-suite verification
is recorded separately when returned; no native active-turn consumption is inferred.
