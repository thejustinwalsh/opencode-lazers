# LZ-181 recovery disposition — 2026-11-09

> **Current disposition:** the user explicitly requested a one-time takeover.
> The continuation decisions below are history, not current instructions.
> LZ-199 is the sole authoritative completion contract; LZ-181 and the unstarted
> LZ-198 proposal are superseded. Their contradictory baseline/equality gates
> are retired, not obligations overridden by optional advice.

## Decision

Continue the same original worker, attempt and useful draft. The adoption failure
episode shows concrete post-intervention progress; do not request surrender,
replace its writer, add another implementation tip or infer completion yet.

This is an Architect disposition, not a worker-authored handoff or proof of
quiescence. Runtime execution/acceptance and resource holds remain unchanged.

## Evidence and incident boundary

- Task: LZ-181 (`75c838e3-d292-46aa-968f-8cc5417a1ee7`).
- Attempt: `4d691f62-10c6-456f-b862-72cf665c4bb6`.
- Original worker: `ses_12ba163aca2a4703a19aa82430adb1ab`.
- Advice 1–3 supplied context/policy, not three failed recovery rounds.
- Advice 4–5 reconciled the reviewed retained-repair implementation; the retained
  suite reached 62/62. Preserve that evidence separately.
- Advice 6 is one focused adoption/restart/candidate-mutation episode. Its earlier
  repeated 4-pass/2-fail run is the pre-intervention baseline, not today's result.
- Post-advice message `msg_1be11ebfc001uN1wPmaZ3yftLx` runs both receipt-cut cases:
  **2 pass, 0 fail, 24 assertions**, then the candidate-index mutation case:
  **1 pass, 0 fail, 12 assertions**. The command does not raise test timeouts.
  An earlier filter matched zero cases; that is not counted as a test pass.
- Source inspection confirms the receipt-cut phases remain separately exercised,
  with exact receipt/no-replay/history checks. The mutation test observes a running
  combined activity before mutation and checks retained exact subprocess receipt
  evidence while acceptance remains held. This is useful progress, not final
  approval of every changed test or runtime path.
- The worker next introduced a focused stop/admission regression. Message
  `msg_1be1425f5001ySHKdvmkRU8BiT` reports a subprocess-start barrier failure for
  `runtime stop aborts checks admitted by its draining tick before storage
disposal`. This is new concrete investigation evidence, not another unchanged
  adoption timeout. Its correction and discriminating coverage remain unverified.

## Next observable reassessment condition

Reassess at the **next completed result of that focused stop/admission regression,
or the full adopted-descendant suite, whichever occurs first**. Also reassess on a
terminal/blocked worker outcome or an explicit inability to produce that result.
Use the actual native result, not merely delivery/consumption of this decision.

- A useful correction with discriminating checks permits continuation to full
  adoption, retained/runner quality and candidate review under the existing task.
- The same unresolved failure with no concrete changed approach requires
  Architect investigation and an explicit handoff/takeover disposition **before
  another steering round**. Do not default to more tips or a larger timeout.
- A different failure is classified on its evidence. A new red regression can be
  justified investigation, but does not itself establish a repaired product.
- If handoff/takeover is chosen, preserve dirty work and original history. Reconcile
  the old writer, native/background work and uncertain effects through supported
  controls before allowing another actor to edit overlapping source. A report or
  an empty inbox is not proof that ownership is released.

There is no new elapsed-time, token, tool-call or advice-count quota. One focused
steering round is the default for an incident; another needs a recorded concrete
new approach or useful progress. The external driver observes outcomes rather
than debugging the worker's implementation.

## Existing roadmap reconciliation

`design/proactive-worker-recovery.md:151–186` already defines this loop. Current
`src/architect.md` does not explicitly teach post-steering reassessment, while
`src/recovery/handoff/index.ts` exports the existing store/schema without public
registration in `src/index.ts`. Existing LZ-55/69 persistence/review work is a reuse
point, not evidence that the complete native flow is delivered.

These missing producer/consumer and guidance pieces remain with **existing
LZ-192's owned-investigation/autonomous-recovery outcome**. Its scope now includes
`src/recovery/**` and `test/recovery/**`; advice 5 records the required registration,
durable disposition/follow-up association, improving-versus-persistent-failure
fixtures, safe handoff ownership and real delivery/reassessment proof. Its LZ-181
and LZ-182 source-integration prerequisites are unchanged. No new task, watchdog,
retry scheduler, generic task-versioning system or quota was created.

Until that runtime follow-up path is delivered, this record and Architect
continuity retain the manual reassessment obligation. Do not misrepresent the
documentation as a scheduled runtime concern or functioning handoff tool.

## Reassessment after the observable checkpoint

Independent read-only investigation confirms the stop/admission correction is
discriminating, not a weakened test: it observes a real running check before
allowing stop, then requires a terminated process group, `timedOut: false`, a
nonzero recovered result and no replay. Native `msg_1be172605…` reports **1 pass,
16 assertions** under the default test timeout.

The full adopted-descendant run in `msg_1be17757d…` is **22 pass, 2 fail, 1 error**.
The failed/READY case exceeded five seconds; its subsequent storage error is
consistent with activity surviving fixture teardown, not proof of release. The
mutating-check case exposes asynchronous re-entry into the old unconditional
clean-worktree check before retaining the exact check result.

The worker has since changed that implementation and its activity-aware waits;
the helper deadline was reduced rather than enlarged. Those later changes are
not verified by the failed run. Keep publication's branch/HEAD/index/worktree/tree
fences: a matching receipt must not become general ownership proof for arbitrary
dirt.

**Disposition remains continue the original worker, acceptance withheld.** This
is a concrete changed approach with observed progress; takeover is not justified.
No new generic debugging round was issued for those adoption failures.

### Discovered retained-repair lineage defect

Normal repair admission for both LZ-194 and LZ-193 rejects **before reservation**
because it equates the original assigned message with the currently completed
native input. In the investigated LZ-194 case, a captured owned background-shell
completion synthetic is the actual successful terminal input; fresh idle evidence
binds it to the original attempt/session/workspace and reports zero background
jobs. Missing idle is not the cause.

No inspected existing control repairs this accepted-state mismatch: tagged
review-input reconciliation requires running/verifying work; narrow interrupted
repair recovery requires an already cancelled repair; retained verification runs
checks rather than implementation. Preserve both accepted workers unchanged.
Do not manufacture cancellation, rewrite assignment IDs, ignore all synthetics,
fabricate idle or prompt/replace them manually.

This same-lifecycle correction is attached to existing LZ-181 in advice 7. Reuse
trusted captured native-input lineage, preserve original assignment separately
from observed terminal input, and carry the latter through final admission and
dispatch revalidation. Cover success and stale/foreign/uncaptured/active rejection
within already authorized runtime tests or `test/runner/**`. An attempted addition
of `src/runner/retained-repair.test.ts` was refused due to LZ-182's reservation;
that path was **not** authorized and the refusal was not bypassed.

The **next reassessment** is the corrected full adoption-suite result plus focused
retained-lineage regression, or an explicit blocker/terminal outcome first. A
repeated unresolved failure without concrete progress again requires Architect
investigation and ownership disposition before further steering. Only reviewed
root correction followed by ordinary successful repair admission can unblock the
accepted workers; no integration or cleanup is claimed for them.

## One-time takeover and consumed correction

The user diagnosis in `lz181-runaway-trajectory-20261109.md` identifies both worker
and coordination failures. Original constraints retained obligations later
rejected as advisory overrides; continued targeted gains did not close repeated
broad failures; added related work expanded the unfinished boundary. The claimed
external Root reservation was not user authority and no external repair is pending.

The original worker was stopped through owned runtime controls. Its complete
tracked diff and untracked modules are preserved, and native foreground/input/
approval/location-shell inventories were empty. Historical background certainty
remains unknown: this is not a cleanup certificate. The backup archive identifies
preserved bytes only, never feature correctness.

The first unstarted takeover proposal repeated retired requirements and reserved
more files than necessary. It was withdrawn, not executed. LZ-199 incorporates the
actual user-retired baseline/environment/configuration/`unchanged` decisions into
one binding contract and narrows writes to the real implementation seams. This
allows independent LZ-164 inspection work to continue. Its owned completion
attempt has actually dispatched; passing source/behavior evidence remains pending.

LZ-182's unsent conflicting preparation and its named held verification generation
were stopped through supported controls, preserving its original session, work,
artifact and failed receipts. Continue that same worker after reviewed takeover
source integration; do not count this coordination hold as discarded work or
fulfilled acceptance. Independent workers were not cancelled.

LZ-195 is being corrected in its same retained worker. A normal retained-repair
input carries the economic/current-contract correction, and native steering
`msg_1be9e5c54001FIi5jyLb2brAwM` adds the requested two-tool public handoff semantics.
Native `msg_1be9f008b001iXglhzPeVs8QEU` actually reads
`recovery-controls-review-20261109.md`; subsequent reads inspect the public tool
and review schemas. This establishes consumption, **not implementation completion**.
Review the committed result for structured-data `lz-verify-handoff`, reviewed
finalization through `lz-submit-handoff`, and the economic/remaining-work guidance.

Future recovery judgment belongs to existing LZ-195/196: measured usage and
available market valuation, failed approaches, demonstrated progress, scope
changes, retained value, remaining work and takeover overhead inform a reasoned
action and next reassessment condition. No quotas, automatic frontier takeover,
sunk-cost continuation or new valuation subsystem is authorized.
